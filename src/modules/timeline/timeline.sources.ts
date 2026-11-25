import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  AdditionalBudgetStatus,
  OfferEventType,
  OrderActorType,
  OrderStatus,
  RoleName,
} from '../../generated/prisma/enums.js';
import { OffersService } from '../offers/offers.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { CONCEPT_LABELS } from '../payments/payments.policy.js';
import { WorkflowQueryService } from '../service-workflow/workflow-query.service.js';
import { TimelineSourceRegistry } from './timeline-source.registry.js';
import type {
  TimelineActor,
  TimelineContext,
  TimelineEvent,
  TimelineSource,
} from './timeline.types.js';

// Lectores de la linea de tiempo (RF-32). Cada uno usa SOLO el servicio
// publico del modulo propietario de los datos; ninguno consulta tablas ajenas.
// Ninguno incluye direccion, telefono, correo ni ubicacion en vivo.

const STATUS_SUMMARY: Readonly<Partial<Record<OrderStatus, string>>> = {
  PUBLICADO: 'Pedido publicado',
  EN_NEGOCIACION: 'Negociación iniciada',
  ACORDADO: 'Acuerdo registrado',
  ANTICIPO_REGISTRADO: 'Anticipo registrado',
  VISITA_REALIZADA: 'Visita realizada',
  PRESUPUESTO_ADICIONAL_PENDIENTE: 'Presupuesto adicional pendiente',
  EN_EJECUCION: 'Trabajo en ejecución',
  TERMINADO: 'Trabajo terminado',
  CERRADO: 'Pedido cerrado',
  CANCELADO: 'Pedido cancelado',
  VENCIDO: 'Pedido vencido',
  SIN_ACUERDO: 'Pedido sin acuerdo',
};

function userActor(
  userId: string | null,
  role: RoleName | null,
): TimelineActor {
  return { type: 'USUARIO', userId, role };
}

function recordActor(record: {
  actorType: OrderActorType;
  changedById: string | null;
  actorRole: RoleName | null;
  systemProcess: string | null;
}): TimelineActor {
  return record.actorType === OrderActorType.SISTEMA
    ? { type: 'SISTEMA', process: record.systemProcess ?? 'SISTEMA' }
    : userActor(record.changedById, record.actorRole);
}

const isClaimTransition = (
  from: OrderStatus | null,
  to: OrderStatus,
): boolean => to === OrderStatus.EN_RECLAMO || from === OrderStatus.EN_RECLAMO;

/** Historial de estados del pedido (OrdersService). Los reclamos van aparte. */
@Injectable()
export class OrdersTimelineSource implements TimelineSource {
  readonly name = 'orders';
  constructor(private readonly orders: OrdersService) {}

  async listEvents(
    db: Parameters<TimelineSource['listEvents']>[0],
    context: TimelineContext,
  ): Promise<TimelineEvent[]> {
    const history = await this.orders.listStatusHistory(db, context.orderId);
    return history
      .filter((entry) => !isClaimTransition(entry.fromStatus, entry.toStatus))
      .map((entry) => ({
        id: entry.id,
        source: this.name,
        type: `PEDIDO_${entry.toStatus}`,
        at: entry.createdAt,
        actor: recordActor(entry),
        summary:
          entry.fromStatus === OrderStatus.EN_NEGOCIACION &&
          entry.toStatus === OrderStatus.PUBLICADO
            ? 'Pedido nuevamente publicado'
            : (STATUS_SUMMARY[entry.toStatus] ?? entry.toStatus),
        details: {
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          reason: entry.reason,
        },
      }));
  }
}

/**
 * Reclamos (RF-37, RF-38): se derivan del historial de estados del pedido
 * (entrada y salida de EN_RECLAMO). No incluye el texto del reclamo, las fotos
 * ni la decision: el trabajador no debe ver mas de lo que ClaimsModule le
 * permite (GET /orders/:id/claim).
 */
@Injectable()
export class ClaimsTimelineSource implements TimelineSource {
  readonly name = 'claims';
  constructor(private readonly orders: OrdersService) {}

  async listEvents(
    db: Parameters<TimelineSource['listEvents']>[0],
    context: TimelineContext,
  ): Promise<TimelineEvent[]> {
    const history = await this.orders.listStatusHistory(db, context.orderId);
    return history
      .filter((entry) => isClaimTransition(entry.fromStatus, entry.toStatus))
      .map((entry) => ({
        id: entry.id,
        source: this.name,
        type:
          entry.toStatus === OrderStatus.EN_RECLAMO
            ? 'RECLAMO_PRESENTADO'
            : 'RECLAMO_RESUELTO',
        at: entry.createdAt,
        actor: recordActor(entry),
        summary:
          entry.toStatus === OrderStatus.EN_RECLAMO
            ? 'Reclamo presentado'
            : 'Reclamo resuelto y pedido cerrado',
      }));
  }
}

/**
 * Negociacion (OffersService): quien ofertó, a quien y cuanto, incluido el
 * costo de la visita al acordarse. El cliente y los administradores ven todas
 * las ofertas; el trabajador asignado solo las suyas (no las de otros).
 */
@Injectable()
export class OffersTimelineSource implements TimelineSource {
  readonly name = 'offers';
  constructor(private readonly offers: OffersService) {}

  async listEvents(
    db: Parameters<TimelineSource['listEvents']>[0],
    context: TimelineContext,
  ): Promise<TimelineEvent[]> {
    const [events, terms] = await Promise.all([
      this.offers.listNegotiationEvents(db, context.orderId),
      this.offers.getAcceptedOfferTerms(db, context.orderId),
    ]);
    const seeAll =
      context.viewer.isAdmin || context.viewer.userId === context.clientId;
    return events
      .filter((event) => seeAll || event.workerId === context.viewer.userId)
      .map((event): TimelineEvent => {
        const byWorker = event.actorRole === RoleName.TRABAJADOR;
        const isProposal =
          event.type === OfferEventType.PROPUESTA ||
          event.type === OfferEventType.CONTRAOFERTA;
        const accepted =
          event.type === OfferEventType.ACEPTADA &&
          terms?.offerId === event.offerId;
        return {
          id: event.id,
          source: this.name,
          type: `OFERTA_${event.type}`,
          at: event.createdAt,
          actor: recordActor(event),
          summary: isProposal
            ? `${event.type === OfferEventType.PROPUESTA ? 'Oferta' : 'Contraoferta'} de ${byWorker ? 'el trabajador al cliente' : 'el cliente al trabajador'}: Bs ${event.amount?.toFixed(2)}`
            : OFFER_CLOSING_SUMMARY[event.type],
          details: {
            offerId: event.offerId,
            round: event.round,
            amount: event.amount?.toFixed(2) ?? null,
            workerId: event.workerId,
            clientId: event.clientId,
            ...(accepted && terms
              ? {
                  agreedAmount: terms.amount.toFixed(2),
                  requiresVisit: terms.requiresVisit,
                  visitCost: terms.visitCost?.toFixed(2) ?? null,
                }
              : {}),
          },
        };
      });
  }
}

const OFFER_CLOSING_SUMMARY: Readonly<Record<OfferEventType, string>> = {
  PROPUESTA: 'Oferta enviada',
  CONTRAOFERTA: 'Contraoferta enviada',
  ACEPTADA: 'Oferta aceptada',
  RECHAZADA: 'Oferta rechazada',
  RETIRADA: 'Oferta retirada',
  VENCIDA: 'Oferta vencida',
  SIN_EFECTO: 'Oferta sin efecto',
};

/**
 * Detalles del ciclo de vida del trabajo (WorkflowQueryService): costo de la
 * visita, presupuestos adicionales, plazo de conformidad e inasistencia. Los
 * cambios de estado ya vienen del historial del pedido.
 */
@Injectable()
export class WorkflowTimelineSource implements TimelineSource {
  readonly name = 'workflow';
  constructor(private readonly workflow: WorkflowQueryService) {}

  async listEvents(
    db: Parameters<TimelineSource['listEvents']>[0],
    context: TimelineContext,
  ): Promise<TimelineEvent[]> {
    const { orderId } = context;
    const [visit, budgets, execution, noShow] = await Promise.all([
      this.workflow.getVisit(orderId, db),
      this.workflow.listAdditionalBudgets(orderId, db),
      this.workflow.getExecution(orderId, db),
      this.workflow.getNoShowReport(orderId, db),
    ]);
    const worker = userActor(context.workerId, RoleName.TRABAJADOR);
    const client = userActor(context.clientId, RoleName.CLIENTE);
    const events: TimelineEvent[] = [];
    const add = (event: Omit<TimelineEvent, 'source'>) =>
      events.push({ ...event, source: this.name });

    if (visit) {
      const cost = visit.visitCost ? Number(visit.visitCost) : 0;
      add({
        id: `visit:${orderId}`,
        type: 'VISITA_COSTO',
        at: visit.performedAt,
        actor: worker,
        summary:
          cost > 0
            ? `Visita realizada. Costo acordado: Bs ${visit.visitCost}`
            : 'Visita realizada sin costo',
        details: { visitCost: visit.visitCost },
      });
    }
    for (const budget of budgets) {
      add({
        id: `budget:${budget.id}:proposed`,
        type: 'ADICIONAL_PROPUESTO',
        at: budget.createdAt,
        actor: worker,
        summary: `Presupuesto adicional propuesto: Bs ${budget.amount}`,
        details: {
          budgetId: budget.id,
          amount: budget.amount,
          reason: budget.reason,
          materials: budget.materials,
        },
      });
      if (
        budget.status === AdditionalBudgetStatus.ACEPTADO &&
        budget.respondedAt
      ) {
        add({
          id: `budget:${budget.id}:accepted`,
          type: 'ADICIONAL_ACEPTADO',
          at: budget.respondedAt,
          actor: client,
          summary: `Presupuesto adicional aceptado: Bs ${budget.amount}`,
          details: { budgetId: budget.id, amount: budget.amount },
        });
      }
      if (
        budget.status === AdditionalBudgetStatus.RECHAZADO &&
        budget.respondedAt
      ) {
        add({
          id: `budget:${budget.id}:rejected`,
          type: 'ADICIONAL_RECHAZADO',
          at: budget.respondedAt,
          actor: client,
          summary: `Presupuesto adicional rechazado: Bs ${budget.amount}`,
          details: { budgetId: budget.id, amount: budget.amount },
        });
      }
    }
    if (execution?.finishedAt && execution.conformityDeadline) {
      add({
        id: `execution:${orderId}:deadline`,
        type: 'PLAZO_CONFORMIDAD',
        at: execution.finishedAt,
        actor: worker,
        summary: 'Plazo para confirmar conformidad o presentar reclamo',
        details: { deadline: execution.conformityDeadline.toISOString() },
      });
    }
    if (execution?.conformedAt) {
      add({
        id: `execution:${orderId}:conformed`,
        type: 'CONFORMIDAD_CONFIRMADA',
        at: execution.conformedAt,
        actor: client,
        summary: 'El cliente confirmó la conformidad del trabajo',
      });
    }
    if (noShow) {
      add({
        id: `noshow:${noShow.id}`,
        type: 'INASISTENCIA_REPORTADA',
        at: noShow.reportedAt,
        actor: client,
        summary: 'El cliente reportó la inasistencia del trabajador',
        details: { description: noShow.description },
      });
    }
    return events;
  }
}

/** Constancias y declaraciones de pago (PaymentsService). */
@Injectable()
export class PaymentsTimelineSource implements TimelineSource {
  readonly name = 'payments';
  constructor(private readonly payments: PaymentsService) {}

  async listEvents(
    db: Parameters<TimelineSource['listEvents']>[0],
    context: TimelineContext,
  ): Promise<TimelineEvent[]> {
    const facts = await this.payments.listTimelineFacts(db, context.orderId);
    const events: TimelineEvent[] = [];
    if (facts.receipt) {
      events.push({
        id: `receipt:${facts.receipt.id}`,
        source: this.name,
        type: 'CONSTANCIA_SERVICIO',
        at: facts.receipt.createdAt,
        actor: { type: 'SISTEMA', process: 'CONSTANCIA_SERVICIO' },
        summary: `Constancia del servicio emitida: Bs ${facts.receipt.agreedAmount.toFixed(2)}`,
        details: { agreedAmount: facts.receipt.agreedAmount.toFixed(2) },
      });
    }
    for (const declaration of facts.declarations) {
      const label = CONCEPT_LABELS[declaration.concept];
      events.push({
        id: `declaration:${declaration.id}`,
        source: this.name,
        type: `PAGO_${declaration.concept}_${declaration.declaredBy}`,
        at: declaration.createdAt,
        actor: userActor(
          declaration.userId,
          declaration.declaredBy === 'CLIENTE'
            ? RoleName.CLIENTE
            : RoleName.TRABAJADOR,
        ),
        summary:
          declaration.declaredBy === 'CLIENTE'
            ? `El cliente declaró haber pagado el ${label}: Bs ${declaration.amount.toFixed(2)}`
            : `El trabajador confirmó haber recibido el ${label}: Bs ${declaration.amount.toFixed(2)}`,
        details: {
          concept: declaration.concept,
          method: declaration.method,
          amount: declaration.amount.toFixed(2),
        },
      });
    }
    return events;
  }
}

/** Registra los lectores acordados al iniciar (ninguno queda sin registrar). */
@Injectable()
export class TimelineSourcesIntegration implements OnModuleInit {
  constructor(
    private readonly registry: TimelineSourceRegistry,
    private readonly orders: OrdersTimelineSource,
    private readonly claims: ClaimsTimelineSource,
    private readonly offers: OffersTimelineSource,
    private readonly workflow: WorkflowTimelineSource,
    private readonly payments: PaymentsTimelineSource,
  ) {}

  onModuleInit(): void {
    for (const source of [
      this.orders,
      this.claims,
      this.offers,
      this.workflow,
      this.payments,
    ]) {
      this.registry.register(source);
    }
  }
}
