import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import {
  AdditionalBudgetStatus,
  OrderStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { clientActor } from '../orders/order-history.js';
import {
  LockedOrder,
  lockOrder,
  orderNotFound,
  OrdersService,
} from '../orders/orders.service.js';
import type { OwnerOrderView } from '../orders/order-views.js';
import { OffersService } from '../offers/offers.service.js';
import { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import { CancelWorkDto } from './dto/cancel-work.dto.js';
import { CreateAdditionalBudgetDto } from './dto/create-additional-budget.dto.js';
import { ReportNoShowDto } from './dto/report-no-show.dto.js';
import { isNoShowReportAllowedAt } from './no-show-timing.policy.js';
import { VisitPaymentRegistry } from './visit-payment.port.js';
import {
  WorkflowEvent,
  WorkflowEventRegistry,
} from './workflow-events.registry.js';
import { dbClock, workerActor } from './workflow-support.js';
import {
  ADDITIONAL_BUDGET_ORIGIN_STATUSES,
  computeConformityDeadline,
  NO_SHOW_REPORTABLE_STATUSES,
} from './workflow.rules.js';
import {
  NoShowView,
  toBudgetView,
  toExecutionView,
  toNoShowView,
  toVisitView,
  type AdditionalBudgetView,
  type ExecutionView,
  type VisitView,
} from './workflow-views.js';

type Db = Prisma.TransactionClient;

const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Ciclo de vida del trabajo (RF-25 a RF-28, RF-34, RF-36).
 *
 * Cada operacion: (1) bloquea al trabajador aprobado cuando es una accion del
 * trabajador (orden de bloqueos: trabajador, pedido), (2) bloquea el pedido y
 * valida dueno/asignado y estado de origen DENTRO del bloqueo, (3) escribe sus
 * datos y cambia el estado SOLO con OrdersService.transition() (que deja el
 * historial), (4) corre los hooks del registro de eventos en la misma
 * transaccion. Repetir una accion (doble clic, reintento) encuentra otro
 * estado y responde 409 sin duplicar nada; los indices unicos de la BD son el
 * ultimo respaldo.
 *
 * PENDIENTE DE CONFIRMAR CON EL DOCENTE (aislado, no implementado): efecto del
 * rechazo de un presupuesto adicional (RF-27 / CU-27 A1), tratamiento del
 * anticipo al cancelar (RF-34) y tolerancia/efectos de la inasistencia (RF-36).
 */
@Injectable()
export class ServiceWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly events: WorkflowEventRegistry,
    private readonly visitPayments: VisitPaymentRegistry,
  ) {}

  // ---------------------------------------------------------------------
  // RF-25: visita
  // ---------------------------------------------------------------------

  /** El trabajador registra la visita realizada (ANTICIPO_REGISTRADO -> VISITA_REALIZADA). */
  async registerVisit(
    workerId: string,
    orderId: string,
  ): Promise<{ status: OrderStatus; visit: VisitView }> {
    return this.run(async (tx, events) => {
      const order = await this.lockForWorker(tx, workerId, orderId);
      this.assertStatus(
        order,
        [OrderStatus.ANTICIPO_REGISTRADO],
        'registrar la visita',
      );
      const terms = await this.requireTerms(tx, orderId);
      if (!terms.requiresVisit) {
        throw new ConflictException(
          'La oferta acordada no requiere visita (cotización por fotos).',
        );
      }
      const visit = await tx.orderVisit.create({
        data: {
          orderId,
          performedAt: await dbClock(tx),
          visitCost: terms.visitCost,
        },
      });
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.ANTICIPO_REGISTRADO,
        to: OrderStatus.VISITA_REALIZADA,
        actor: workerActor(workerId),
      });
      events.push({ type: 'VISITA_REGISTRADA', orderId, workerId });
      return {
        status: OrderStatus.VISITA_REALIZADA,
        visit: toVisitView(visit),
      };
    });
  }

  /**
   * "Pago confirmado" (RF-25, RN-04): el trabajador confirma el cobro de la
   * visita en efectivo. A valida actor, estado y que haya un costo; el
   * registro del cobro y su constancia son de PaymentsModule (puerto
   * VisitPaymentRecorder). Sin ese modulo integrado responde 501. Tambien se
   * confirma con el pedido CANCELADO despues de la visita: la visita se realizo
   * y su cobro sigue pendiente (RN-04).
   */
  async confirmVisitPayment(
    workerId: string,
    orderId: string,
  ): Promise<{ visit: VisitView }> {
    const recorder = this.visitPayments.get();
    if (!recorder) {
      throw new NotImplementedException(
        'El registro del cobro de la visita depende del módulo de pagos, que aún no está integrado.',
      );
    }
    return this.run(async (tx) => {
      await this.lockForWorker(tx, workerId, orderId);
      const visit = await tx.orderVisit.findUnique({ where: { orderId } });
      if (!visit) {
        throw new ConflictException('Todavía no se registró la visita.');
      }
      if (!visit.visitCost || visit.visitCost.lte(0)) {
        throw new ConflictException(
          'La visita no tiene costo: no hay cobro que confirmar.',
        );
      }
      // Idempotente por contrato del puerto: no duplica el cobro.
      await recorder.recordVisitPayment(tx, {
        orderId,
        amount: visit.visitCost.toFixed(2),
        confirmedByUserId: workerId,
      });
      return { visit: toVisitView(visit) };
    });
  }

  // ---------------------------------------------------------------------
  // Ejecucion
  // ---------------------------------------------------------------------

  /**
   * El trabajador inicia la ejecucion. Con visita requerida exige haberla
   * registrado; sin visita se inicia desde ANTICIPO_REGISTRADO.
   */
  async startWork(
    workerId: string,
    orderId: string,
  ): Promise<{ status: OrderStatus; execution: ExecutionView }> {
    return this.run(async (tx, events) => {
      const order = await this.lockForWorker(tx, workerId, orderId);
      this.assertStatus(
        order,
        [OrderStatus.ANTICIPO_REGISTRADO, OrderStatus.VISITA_REALIZADA],
        'iniciar el trabajo',
      );
      if (order.status === OrderStatus.ANTICIPO_REGISTRADO) {
        const terms = await this.requireTerms(tx, orderId);
        if (terms.requiresVisit) {
          throw new ConflictException(
            'La oferta requiere visita: registre primero la visita.',
          );
        }
      }
      await this.orders.transition(tx, {
        orderId,
        from: order.status,
        to: OrderStatus.EN_EJECUCION,
        actor: workerActor(workerId),
      });
      const execution = await this.ensureStarted(tx, orderId);
      events.push({ type: 'TRABAJO_INICIADO', orderId, workerId });
      return {
        status: OrderStatus.EN_EJECUCION,
        execution: toExecutionView(execution),
      };
    });
  }

  // ---------------------------------------------------------------------
  // RF-26: presupuesto adicional
  // ---------------------------------------------------------------------

  /**
   * El trabajador propone un costo adicional. No cambia el monto acordado: el
   * pedido queda detenido en PRESUPUESTO_ADICIONAL_PENDIENTE hasta que el
   * cliente responda.
   */
  async createAdditionalBudget(
    workerId: string,
    orderId: string,
    dto: CreateAdditionalBudgetDto,
  ): Promise<{ status: OrderStatus; budget: AdditionalBudgetView }> {
    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lte(0)) {
      throw new BadRequestException(
        'El monto adicional debe ser mayor a cero.',
      );
    }
    return this.run(async (tx, events) => {
      const order = await this.lockForWorker(tx, workerId, orderId);
      this.assertStatus(
        order,
        ADDITIONAL_BUDGET_ORIGIN_STATUSES,
        'proponer un presupuesto adicional',
      );
      const budget = await tx.additionalBudget.create({
        data: {
          orderId,
          amount,
          reason: dto.reason,
          materials: dto.materials,
        },
      });
      await this.orders.transition(tx, {
        orderId,
        from: order.status,
        to: OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
        actor: workerActor(workerId),
        reason: 'Presupuesto adicional propuesto',
      });
      events.push({
        type: 'ADICIONAL_PROPUESTO',
        orderId,
        budgetId: budget.id,
        workerId,
      });
      return {
        status: OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
        budget: toBudgetView(budget),
      };
    }, 'Ya hay un presupuesto adicional pendiente en este pedido.');
  }

  /**
   * El cliente acepta el adicional: el nuevo monto queda registrado (monto
   * acordado + adicionales aceptados) y el trabajo continua (EN_EJECUCION).
   * El rechazo NO existe todavia: pendiente de decision del docente.
   */
  async acceptAdditionalBudget(
    clientId: string,
    orderId: string,
    budgetId: string,
  ): Promise<{ status: OrderStatus; budget: AdditionalBudgetView }> {
    return this.run(async (tx, events) => {
      const order = await this.lockForClient(tx, clientId, orderId);
      this.assertStatus(
        order,
        [OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE],
        'aceptar el presupuesto adicional',
      );
      const budget = await tx.additionalBudget.findFirst({
        where: { id: budgetId, orderId },
      });
      if (!budget) {
        throw new NotFoundException('El presupuesto adicional no existe');
      }
      if (budget.status !== AdditionalBudgetStatus.PENDIENTE) {
        throw new ConflictException(
          budget.status === AdditionalBudgetStatus.SIN_EFECTO_POR_CANCELACION
            ? 'El presupuesto adicional quedó sin efecto porque el trabajo se canceló.'
            : 'El presupuesto adicional ya fue respondido.',
        );
      }
      const accepted = await tx.additionalBudget.update({
        where: { id: budgetId },
        data: {
          status: AdditionalBudgetStatus.ACEPTADO,
          respondedAt: await dbClock(tx),
        },
      });
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
        to: OrderStatus.EN_EJECUCION,
        actor: clientActor(clientId),
        reason: 'Presupuesto adicional aceptado',
      });
      await this.ensureStarted(tx, orderId);
      events.push({ type: 'ADICIONAL_ACEPTADO', orderId, budgetId });
      return {
        status: OrderStatus.EN_EJECUCION,
        budget: toBudgetView(accepted),
      };
    });
  }

  // ---------------------------------------------------------------------
  // RF-28: terminado y conformidad
  // ---------------------------------------------------------------------

  /**
   * El trabajador marca el trabajo como terminado (EN_EJECUCION ->
   * TERMINADO): registra la fecha y hora y fija el plazo de 7 dias para la
   * conformidad o el reclamo (RN-10).
   */
  /**
   * RF-27 (CU-27): el cliente rechaza el presupuesto adicional; el trabajo se
   * detiene y el pedido se cierra, con el motivo en el historial. Solo queda
   * pendiente el cobro de la visita (Pagos no admite el saldo). La
   * contraoferta del adicional (CU-27 A1) no esta definida.
   */
  async rejectAdditionalBudget(
    clientId: string,
    orderId: string,
    budgetId: string,
    reason?: string,
  ): Promise<{ status: OrderStatus; budget: AdditionalBudgetView }> {
    return this.run(async (tx, events) => {
      const order = await this.lockForClient(tx, clientId, orderId);
      this.assertStatus(
        order,
        [OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE],
        'rechazar el presupuesto adicional',
      );
      const budget = await tx.additionalBudget.findFirst({
        where: { id: budgetId, orderId },
      });
      if (!budget) {
        throw new NotFoundException('El presupuesto adicional no existe');
      }
      if (budget.status !== AdditionalBudgetStatus.PENDIENTE) {
        throw new ConflictException(
          'El presupuesto adicional ya fue respondido.',
        );
      }
      const rejected = await tx.additionalBudget.update({
        where: { id: budgetId },
        data: {
          status: AdditionalBudgetStatus.RECHAZADO,
          respondedAt: await dbClock(tx),
        },
      });
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
        to: OrderStatus.CERRADO,
        actor: clientActor(clientId),
        reason: reason
          ? `Presupuesto adicional rechazado: ${reason}`
          : 'Presupuesto adicional rechazado',
      });
      events.push({ type: 'ADICIONAL_RECHAZADO', orderId, budgetId });
      return { status: OrderStatus.CERRADO, budget: toBudgetView(rejected) };
    });
  }

  async finishWork(
    workerId: string,
    orderId: string,
  ): Promise<{ status: OrderStatus; execution: ExecutionView }> {
    return this.run(async (tx, events) => {
      const order = await this.lockForWorker(tx, workerId, orderId);
      this.assertStatus(
        order,
        [OrderStatus.EN_EJECUCION],
        'marcar como terminado',
      );
      const finishedAt = await dbClock(tx);
      const conformityDeadline = computeConformityDeadline(finishedAt);
      const execution = await tx.orderExecution.upsert({
        where: { orderId },
        create: {
          orderId,
          startedAt: finishedAt,
          finishedAt,
          conformityDeadline,
        },
        update: { finishedAt, conformityDeadline },
      });
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.EN_EJECUCION,
        to: OrderStatus.TERMINADO,
        actor: workerActor(workerId),
      });
      events.push({
        type: 'TRABAJO_TERMINADO',
        orderId,
        workerId,
        conformityDeadline,
      });
      return {
        status: OrderStatus.TERMINADO,
        execution: toExecutionView(execution),
      };
    });
  }

  /** El cliente confirma su conformidad antes del plazo: el pedido se cierra. */
  async confirmConformity(
    clientId: string,
    orderId: string,
  ): Promise<{ status: OrderStatus; execution: ExecutionView }> {
    return this.run(async (tx, events) => {
      const order = await this.lockForClient(tx, clientId, orderId);
      this.assertStatus(
        order,
        [OrderStatus.TERMINADO],
        'confirmar la conformidad',
      );
      const execution = await tx.orderExecution.update({
        where: { orderId },
        data: { conformedAt: await dbClock(tx) },
      });
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.TERMINADO,
        to: OrderStatus.CERRADO,
        actor: clientActor(clientId),
        reason: 'Conformidad del cliente',
      });
      events.push({ type: 'CONFORMIDAD_CONFIRMADA', orderId });
      return {
        status: OrderStatus.CERRADO,
        execution: toExecutionView(execution),
      };
    });
  }

  // ---------------------------------------------------------------------
  // RF-34: cancelar trabajo
  // ---------------------------------------------------------------------

  /**
   * "Cancelar trabajo": delega en OrdersService.cancelAgreedWork (registra
   * quien, cuando y por que). No decide nada sobre el anticipo.
   */
  cancelWork(
    clientId: string,
    orderId: string,
    dto: CancelWorkDto,
  ): Promise<OwnerOrderView> {
    return this.orders.cancelAgreedWork(clientId, orderId, dto.reason);
  }

  // ---------------------------------------------------------------------
  // RF-36: inasistencia (solo registro del hecho)
  // ---------------------------------------------------------------------

  /**
   * El cliente reporta que el trabajador no llego. Solo registra el hecho:
   * no cambia el estado del pedido, no penaliza ni toca calificaciones.
   * Un reporte por pedido: repetirlo devuelve el existente (idempotente).
   * La condicion de tiempo esta aislada en no-show-timing.policy.ts.
   */
  async reportNoShow(
    clientId: string,
    orderId: string,
    dto: ReportNoShowDto,
  ): Promise<{ created: boolean; report: NoShowView }> {
    return this.run(async (tx, events) => {
      const order = await this.lockForClient(tx, clientId, orderId);
      const existing = await tx.noShowReport.findUnique({ where: { orderId } });
      if (existing) {
        return { created: false, report: toNoShowView(existing) };
      }
      this.assertStatus(
        order,
        NO_SHOW_REPORTABLE_STATUSES,
        'reportar la inasistencia',
      );
      const terms = await this.requireTerms(tx, orderId);
      const now = await dbClock(tx);
      if (
        !isNoShowReportAllowedAt({
          now,
          proposedStartAt: terms.proposedStartAt,
          estimatedDurationMinutes: terms.estimatedDurationMinutes,
        })
      ) {
        throw new ConflictException(
          'Todavía no se puede reportar la inasistencia de este trabajo.',
        );
      }
      const report = await tx.noShowReport.create({
        data: {
          orderId,
          reportedById: clientId,
          description: dto.description ?? null,
          reportedAt: now,
        },
      });
      events.push({
        type: 'INASISTENCIA_REPORTADA',
        orderId,
        workerId: order.assignedWorkerId!,
      });
      return { created: true, report: toNoShowView(report) };
    });
  }

  // ---------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------

  /**
   * Ejecuta `work` en una transaccion, corre los hooks del registro dentro de
   * ella y, confirmada, los efectos posteriores. Una violacion de unicidad de
   * la BD (doble envio concurrente) se traduce en 409.
   */
  private async run<T>(
    work: (tx: Db, events: WorkflowEvent[]) => Promise<T>,
    uniqueMessage = 'La operación ya se realizó o el pedido cambió. Vuelva a consultarlo.',
  ): Promise<T> {
    let events: WorkflowEvent[] = [];
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const collected: WorkflowEvent[] = [];
        const value = await work(tx, collected);
        await this.events.runInTransaction(collected, tx);
        events = collected;
        return value;
      });
      await this.events.runAfterCommit(events);
      return result;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(uniqueMessage);
      }
      throw error;
    }
  }

  /**
   * Accion del trabajador: perfil aprobado bloqueado (1.o) y pedido asignado a
   * el (2.o). Es trabajo ya acordado: una solicitud de cambio de zona pendiente
   * no lo detiene (RF-13).
   */
  private async lockForWorker(
    tx: Db,
    workerId: string,
    orderId: string,
  ): Promise<LockedOrder> {
    await this.workerProfiles.lockApprovedWorkerForAgreedWork(tx, workerId);
    const order = await lockOrder(tx, orderId);
    if (!order || order.assignedWorkerId !== workerId) {
      throw orderNotFound();
    }
    return order;
  }

  /** Accion del cliente: solo el dueno del pedido; otro usuario recibe 404. */
  private async lockForClient(
    tx: Db,
    clientId: string,
    orderId: string,
  ): Promise<LockedOrder> {
    const order = await lockOrder(tx, orderId, clientId);
    if (!order) {
      throw orderNotFound();
    }
    return order;
  }

  private assertStatus(
    order: LockedOrder,
    allowed: readonly OrderStatus[],
    action: string,
  ): void {
    if (!allowed.includes(order.status)) {
      throw new ConflictException(
        `No se puede ${action} con el pedido en estado ${order.status}.`,
      );
    }
  }

  private async requireTerms(tx: Db, orderId: string) {
    const terms = await this.offers.getAcceptedOfferTerms(tx, orderId);
    if (!terms) {
      // Invariante roto: un pedido con acuerdo siempre tiene oferta aceptada.
      throw new ConflictException('El pedido no tiene una oferta aceptada.');
    }
    return terms;
  }

  /** Crea el registro de ejecucion y fija startedAt la primera vez. */
  private async ensureStarted(tx: Db, orderId: string) {
    const now = await dbClock(tx);
    const execution = await tx.orderExecution.upsert({
      where: { orderId },
      create: { orderId, startedAt: now },
      update: {},
    });
    return execution.startedAt
      ? execution
      : tx.orderExecution.update({
          where: { orderId },
          data: { startedAt: now },
        });
  }
}
