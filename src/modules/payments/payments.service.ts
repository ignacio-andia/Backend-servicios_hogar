import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  NotificationResourceType,
  NotificationType,
  OrderStatus,
  RoleName,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  type AcceptedOfferTerms,
  OffersService,
} from '../offers/offers.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService, lockOrder } from '../orders/orders.service.js';
import { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import { WorkflowQueryService } from '../service-workflow/workflow-query.service.js';
import { DeclarePaymentDto } from './dto/declare-payment.dto.js';
import { computeExpectedBalance } from './expected-balance.js';
import {
  summarizeDeclarations,
  type DeclarationSummary,
} from './payment-declarations.js';
import {
  type BalanceView,
  type DeclarationResult,
  type DeclarationView,
  type OrderTransitionOutcome,
  type PaymentDifferenceView,
  type PaymentsOverview,
  type PaymentView,
  type ReceiptsView,
  money,
  toDeclarationView,
} from './payment-views.js';
import { PaymentsConfig } from './payments.config.js';
import {
  CONCEPT_LABELS,
  DECLARABLE_STATUSES,
  allowedMethods,
  isAdvanceReceiptConfirmation,
  requiredConfirmationFor,
} from './payments.policy.js';
import {
  DIRECT_PAYMENT_NOTICE,
  PAYMENT_CONCEPTS,
  RECEIPT_REFERENCE_NOTICE,
  computeAdvanceAmount,
  type PaymentConcept,
  type PaymentDeclarer,
} from './payments.rules.js';

type Db = Prisma.TransactionClient;

const PRISMA_UNIQUE_VIOLATION = 'P2002';

export interface PaymentsViewer {
  userId: string;
  roles: readonly RoleName[];
}

const DECLARATION_SELECT = {
  id: true,
  declaredBy: true,
  userId: true,
  method: true,
  amount: true,
  createdAt: true,
} satisfies Prisma.PaymentDeclarationSelect;

const NO_BALANCE_MESSAGE =
  'El trabajo se cerró por el rechazo de un presupuesto adicional: solo queda pendiente el cobro de la visita.';
const NO_BALANCE_AFTER_REJECTION: BalanceView = {
  status: 'NO_APLICA',
  amount: null,
  advanceAmount: null,
  additionalBudgetsTotal: null,
  note: NO_BALANCE_MESSAGE,
};

/**
 * Pagos y constancias (RF-39 a RF-43). La plataforma NO procesa, recibe,
 * retiene ni garantiza dinero: solo registra las DECLARACIONES de las partes
 * (cliente "Ya pagué", trabajador "Confirmo que me pagaron" / "Pago
 * confirmado"). Cada declaracion es inmutable (trigger) y es la constancia del
 * pago: fecha y hora, usuario, monto y metodo. Una no sustituye a la otra.
 *
 * Datos de otros modulos solo por sus servicios publicos: OrdersService
 * (participantes y transicion), OffersService (oferta aceptada),
 * WorkflowQueryService (visita y monto con adicionales aceptados).
 *
 * Orden de bloqueos: trabajador (si declara el trabajador), pedido. Las
 * notificaciones se guardan con `tx` en la misma transaccion.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly workflow: WorkflowQueryService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly notifications: NotificationsService,
    private readonly config: PaymentsConfig,
  ) {}

  // ---------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------

  /** Pagos del pedido y saldo esperado. Cliente, trabajador asignado o administrador. */
  async getOverview(
    viewer: PaymentsViewer,
    orderId: string,
  ): Promise<PaymentsOverview> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.requireAccess(tx, viewer, orderId);
      const terms = await this.offers.getAcceptedOfferTerms(tx, orderId);
      const agreement = terms
        ? await this.workflow.getAgreedAmount(orderId, tx)
        : null;
      const payments = await tx.payment.findMany({
        where: { orderId },
        select: {
          id: true,
          concept: true,
          expectedAmount: true,
          declarations: {
            select: DECLARATION_SELECT,
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      const byConcept = new Map(payments.map((p) => [p.concept, p]));
      const concepts = terms ? this.conceptsOf(terms) : [];
      const views: PaymentView[] = concepts.map((concept) => {
        const existing = byConcept.get(concept);
        const expected =
          existing?.expectedAmount ??
          (terms ? this.expectedFor(concept, terms) : null);
        return this.toPaymentView(
          concept,
          existing?.id ?? null,
          expected,
          existing?.declarations ?? [],
        );
      });
      return {
        orderId,
        orderStatus: order.status,
        notice: DIRECT_PAYMENT_NOTICE,
        agreement,
        advanceTransition: 'ACTIVA',
        payments: views,
        balance: (await this.workflow.hasRejectedBudget(orderId, tx))
          ? NO_BALANCE_AFTER_REJECTION
          : this.balanceView(agreement),
      };
    });
  }

  /** Constancia del servicio y de cada pago (RF-41). Mismos permisos que el resumen. */
  async getReceipts(
    viewer: PaymentsViewer,
    orderId: string,
  ): Promise<ReceiptsView> {
    return this.prisma.$transaction(async (tx) => {
      await this.requireAccess(tx, viewer, orderId);
      const [receipt, payments] = await Promise.all([
        tx.serviceReceipt.findUnique({ where: { orderId } }),
        tx.payment.findMany({
          where: { orderId },
          select: {
            id: true,
            concept: true,
            createdAt: true,
            declarations: {
              select: DECLARATION_SELECT,
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        }),
      ]);
      return {
        orderId,
        notice: DIRECT_PAYMENT_NOTICE,
        referenceNotice: RECEIPT_REFERENCE_NOTICE,
        service: receipt
          ? {
              clientId: receipt.clientId,
              workerId: receipt.workerId,
              agreedAmount: receipt.agreedAmount.toFixed(2),
              issuedAt: receipt.createdAt,
            }
          : null,
        payments: payments.flatMap((payment) =>
          payment.declarations.map((declaration) => ({
            concept: payment.concept,
            paymentId: payment.id,
            declaration: toDeclarationView(declaration),
          })),
        ),
      };
    });
  }

  /** Pagos cuyas declaraciones difieren en el monto, para revision (RF-42 A1). */
  async listDifferences(
    page: number,
    limit: number,
  ): Promise<{
    data: PaymentDifferenceView[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const [rows, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<
        {
          paymentId: string;
          orderId: string;
          concept: PaymentConcept;
          clientAmount: Prisma.Decimal;
          workerAmount: Prisma.Decimal;
          createdAt: Date;
        }[]
      >`
        SELECT p."id"::text AS "paymentId", p."order_id"::text AS "orderId",
               p."concept" AS "concept", c."amount" AS "clientAmount",
               w."amount" AS "workerAmount", p."created_at" AS "createdAt"
        FROM "payments" p
        JOIN "payment_declarations" c
          ON c."payment_id" = p."id" AND c."declared_by" = 'CLIENTE'
        JOIN "payment_declarations" w
          ON w."payment_id" = p."id" AND w."declared_by" = 'TRABAJADOR'
        WHERE c."amount" <> w."amount"
        ORDER BY p."created_at" DESC, p."id"
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS "total"
        FROM "payment_declarations" c
        JOIN "payment_declarations" w
          ON w."payment_id" = c."payment_id" AND w."declared_by" = 'TRABAJADOR'
        WHERE c."declared_by" = 'CLIENTE' AND c."amount" <> w."amount"`,
    ]);
    return {
      data: rows.map((row) => {
        const client = new Prisma.Decimal(row.clientAmount);
        const worker = new Prisma.Decimal(row.workerAmount);
        return {
          paymentId: row.paymentId,
          orderId: row.orderId,
          concept: row.concept,
          clientAmount: client.toFixed(2),
          workerAmount: worker.toFixed(2),
          difference: worker.minus(client).toFixed(2),
          createdAt: row.createdAt,
        };
      }),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Para TimelineModule (RF-32): constancia del servicio y declaraciones de
   * pago del pedido, solo lectura. El llamador ya decidio el permiso.
   */
  async listTimelineFacts(db: Db, orderId: string) {
    const [receipt, declarations] = await Promise.all([
      db.serviceReceipt.findUnique({ where: { orderId } }),
      db.paymentDeclaration.findMany({
        where: { payment: { orderId } },
        select: {
          ...DECLARATION_SELECT,
          payment: { select: { concept: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      receipt: receipt
        ? {
            id: receipt.id,
            agreedAmount: receipt.agreedAmount,
            createdAt: receipt.createdAt,
          }
        : null,
      declarations: declarations.map(({ payment, ...declaration }) => ({
        ...declaration,
        concept: payment.concept,
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Declaraciones
  // ---------------------------------------------------------------------

  /**
   * Declaracion de un pago por el cliente ("Ya pagué") o por el trabajador
   * asignado ("Confirmo que me pagaron"). La parte sale del pedido, no del
   * cuerpo. Cada parte declara una vez por concepto (409 si repite).
   *
   * La declaracion del trabajador de la VISITA no se hace aqui: es el "Pago
   * confirmado" de ServiceWorkflowModule, que llama a recordVisitPayment.
   */
  async declare(
    userId: string,
    orderId: string,
    concept: PaymentConcept,
    dto: DeclarePaymentDto,
  ): Promise<DeclarationResult> {
    if (!allowedMethods(concept).includes(dto.method)) {
      throw new BadRequestException(
        `El ${CONCEPT_LABELS[concept]} solo se paga en efectivo.`,
      );
    }
    const amount = new Prisma.Decimal(dto.amount);
    // Lectura previa sin bloqueo, solo para saber a quien bloquear.
    const summary = await this.orders.findOrderSummary(this.prisma, orderId);
    const declaredBy = summary ? roleIn(summary, userId) : null;
    if (!summary || !declaredBy) {
      throw orderNotFound();
    }
    if (concept === 'VISITA' && declaredBy === 'TRABAJADOR') {
      throw new ConflictException(
        'El cobro de la visita lo confirma el trabajador con «Pago confirmado» de la visita.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (declaredBy === 'TRABAJADOR') {
          // Pago de un trabajo ya acordado: una solicitud de cambio de zona
          // pendiente no lo detiene (RF-13).
          await this.workerProfiles.lockApprovedWorkerForAgreedWork(tx, userId);
        }
        const order = await lockOrder(tx, orderId);
        if (!order || roleIn(order, userId) !== declaredBy) {
          throw orderNotFound();
        }
        if (!DECLARABLE_STATUSES[concept].includes(order.status)) {
          throw new ConflictException(
            `No se puede declarar el ${CONCEPT_LABELS[concept]} con el pedido en estado ${order.status}.`,
          );
        }
        // RF-27: cerrado por rechazar un adicional, no hay saldo.
        if (
          concept === 'SALDO' &&
          (await this.workflow.hasRejectedBudget(orderId, tx))
        ) {
          throw new ConflictException(NO_BALANCE_MESSAGE);
        }
        const terms = await this.offers.getAcceptedOfferTerms(tx, orderId);
        if (!terms || !this.conceptsOf(terms).includes(concept)) {
          throw new ConflictException(
            concept === 'VISITA'
              ? 'El acuerdo no tiene una visita con costo.'
              : 'El pedido no tiene una oferta aceptada.',
          );
        }
        if (concept === 'VISITA') {
          const visit = await this.workflow.getVisit(orderId, tx);
          if (!visit) {
            throw new ConflictException('Todavía no se registró la visita.');
          }
        }
        await this.ensureServiceReceipt(tx, orderId, order, terms);

        const payment = await this.findOrCreatePayment(
          tx,
          orderId,
          concept,
          this.expectedFor(concept, terms),
        );
        // Confirmacion del anticipo por el trabajador asignado: solo vale por
        // el monto esperado (RN-02). Un monto distinto no se registra.
        const confirmsAdvance = isAdvanceReceiptConfirmation(
          concept,
          declaredBy,
          this.config.advanceConfirmedBy,
        );
        if (confirmsAdvance && !payment.expectedAmount?.equals(amount)) {
          throw new ConflictException(
            `El monto no corresponde al anticipo esperado (Bs ${money(payment.expectedAmount)}).`,
          );
        }
        const duplicate = await tx.paymentDeclaration.findUnique({
          where: {
            paymentId_declaredBy: { paymentId: payment.id, declaredBy },
          },
          select: { amount: true, method: true },
        });
        if (duplicate) {
          // Repetir la misma confirmacion es idempotente: no crea registros ni
          // avisos. Con otros datos, una declaracion no se edita.
          if (
            confirmsAdvance &&
            duplicate.amount.equals(amount) &&
            duplicate.method === dto.method
          ) {
            return this.replayAdvanceConfirmation(tx, {
              orderId,
              userId,
              status: order.status,
              payment,
            });
          }
          throw new ConflictException(
            'Ya declaró este pago. Una declaración no se edita ni se repite.',
          );
        }
        await tx.paymentDeclaration.create({
          data: {
            paymentId: payment.id,
            declaredBy,
            userId,
            method: dto.method,
            amount,
          },
        });

        const declarations = await tx.paymentDeclaration.findMany({
          where: { paymentId: payment.id },
          select: DECLARATION_SELECT,
          orderBy: { createdAt: 'asc' },
        });
        const view = this.toPaymentView(
          concept,
          payment.id,
          payment.expectedAmount,
          declarations,
        );
        await this.notifyDeclaration(tx, {
          orderId,
          clientId: order.clientId,
          workerId: order.assignedWorkerId!,
          declaredBy,
          concept,
          amount,
          view,
        });
        const orderTransition = await this.maybeRegisterAdvance(tx, {
          orderId,
          userId,
          declaredBy,
          concept,
          status: order.status,
        });
        return {
          notice: DIRECT_PAYMENT_NOTICE,
          payment: view,
          orderTransition,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(
          'El pago ya fue declarado o el pedido cambió. Vuelva a consultarlo.',
        );
      }
      throw error;
    }
  }

  /**
   * Respuesta a una confirmacion de anticipo repetida: devuelve lo ya
   * registrado. Si el pedido sigue ACORDADO (declaraciones guardadas antes de
   * esta regla) la confirmacion repetida lo avanza; si ya avanzo, no
   * transiciona de nuevo.
   */
  private async replayAdvanceConfirmation(
    tx: Db,
    input: {
      orderId: string;
      userId: string;
      status: OrderStatus;
      payment: { id: string; expectedAmount: Prisma.Decimal | null };
    },
  ): Promise<DeclarationResult> {
    const declarations = await tx.paymentDeclaration.findMany({
      where: { paymentId: input.payment.id },
      select: DECLARATION_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    const orderTransition =
      input.status === OrderStatus.ACORDADO
        ? await this.maybeRegisterAdvance(tx, {
            orderId: input.orderId,
            userId: input.userId,
            declaredBy: 'TRABAJADOR',
            concept: 'ANTICIPO',
            status: input.status,
          })
        : 'ANTICIPO_REGISTRADO';
    return {
      notice: DIRECT_PAYMENT_NOTICE,
      payment: this.toPaymentView(
        'ANTICIPO',
        input.payment.id,
        input.payment.expectedAmount,
        declarations,
      ),
      orderTransition,
    };
  }

  /**
   * Puerto de ServiceWorkflowModule (VisitPaymentRecorder): registra el cobro
   * de la visita que el trabajador confirmo con «Pago confirmado» (RF-25,
   * RN-04). Se llama DENTRO de la transaccion de A, con el pedido bloqueado.
   * Idempotente: si el trabajador ya declaro la visita, no crea otra. Siempre
   * EFECTIVO y con el monto que fija A (costo acordado).
   */
  async recordVisitPayment(
    tx: Db,
    input: { orderId: string; amount: string; confirmedByUserId: string },
  ): Promise<void> {
    const amount = new Prisma.Decimal(input.amount);
    if (!amount.gt(0)) {
      throw new BadRequestException('La visita no tiene costo que registrar.');
    }
    const order = await this.orders.findOrderSummary(tx, input.orderId);
    const terms = await this.offers.getAcceptedOfferTerms(tx, input.orderId);
    if (
      !order ||
      !terms ||
      order.assignedWorkerId !== input.confirmedByUserId
    ) {
      throw orderNotFound();
    }
    await this.ensureServiceReceipt(tx, input.orderId, order, terms);
    const payment = await this.findOrCreatePayment(
      tx,
      input.orderId,
      'VISITA',
      amount,
    );
    const existing = await tx.paymentDeclaration.findUnique({
      where: {
        paymentId_declaredBy: {
          paymentId: payment.id,
          declaredBy: 'TRABAJADOR',
        },
      },
      select: { id: true },
    });
    if (existing) {
      return;
    }
    await tx.paymentDeclaration.create({
      data: {
        paymentId: payment.id,
        declaredBy: 'TRABAJADOR',
        userId: input.confirmedByUserId,
        method: 'EFECTIVO',
        amount,
      },
    });
    const declarations = await tx.paymentDeclaration.findMany({
      where: { paymentId: payment.id },
      select: DECLARATION_SELECT,
    });
    await this.notifyDeclaration(tx, {
      orderId: input.orderId,
      clientId: order.clientId,
      workerId: input.confirmedByUserId,
      declaredBy: 'TRABAJADOR',
      concept: 'VISITA',
      amount,
      view: this.toPaymentView(
        'VISITA',
        payment.id,
        payment.expectedAmount,
        declarations,
      ),
    });
  }

  /**
   * Puerto de OrdersModule (AdvanceConfirmationVerifier): true solo si el
   * trabajador de la oferta aceptada declaro, para ESTE pedido, la recepcion
   * del anticipo por el 25 % exacto. Solo lectura, con la transaccion de
   * OrdersService.transition().
   */
  async hasValidAdvanceConfirmation(
    tx: Db,
    { orderId, workerId }: { orderId: string; workerId: string },
  ): Promise<boolean> {
    const terms = await this.offers.getAcceptedOfferTerms(tx, orderId);
    if (!terms || terms.workerId !== workerId) {
      return false;
    }
    const confirmation = await tx.paymentDeclaration.findFirst({
      where: {
        declaredBy: 'TRABAJADOR',
        userId: workerId,
        payment: { orderId, concept: 'ANTICIPO' },
      },
      select: { amount: true },
    });
    return (
      confirmation !== null &&
      confirmation.amount.equals(computeAdvanceAmount(terms.amount))
    );
  }

  /**
   * Constancia del servicio (RF-41): una por pedido con acuerdo, inmutable.
   * Idempotente. La emite el hook de la aceptacion de la oferta y, para pedidos
   * anteriores, la primera declaracion.
   */
  async ensureServiceReceipt(
    tx: Db,
    orderId: string,
    order: { clientId: string; assignedWorkerId: string | null },
    terms: Pick<AcceptedOfferTerms, 'workerId' | 'amount'>,
  ): Promise<void> {
    await tx.serviceReceipt.createMany({
      data: [
        {
          orderId,
          clientId: order.clientId,
          workerId: order.assignedWorkerId ?? terms.workerId,
          agreedAmount: terms.amount,
        },
      ],
      skipDuplicates: true,
    });
  }

  // ---------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------

  /** Cliente, trabajador asignado o administrador; cualquier otro, 404. */
  private async requireAccess(db: Db, viewer: PaymentsViewer, orderId: string) {
    const order = await this.orders.findOrderSummary(db, orderId);
    const isAdmin = viewer.roles.includes(RoleName.ADMINISTRADOR);
    if (!order || (!isAdmin && roleIn(order, viewer.userId) === null)) {
      throw orderNotFound();
    }
    return order;
  }

  /** Conceptos que existen para un acuerdo: la visita solo si tiene costo. */
  private conceptsOf(terms: AcceptedOfferTerms): PaymentConcept[] {
    return PAYMENT_CONCEPTS.filter(
      (concept) =>
        concept !== 'VISITA' ||
        (terms.requiresVisit &&
          terms.visitCost !== null &&
          terms.visitCost.gt(0)),
    );
  }

  /**
   * Monto esperado de cada concepto. ANTICIPO: 25 % del monto de la oferta
   * aceptada (RN-02: "monto acordado del trabajo"). PENDIENTE DE CONFIRMAR CON
   * EL DOCENTE: si la base debe incluir los presupuestos adicionales; hoy no
   * (el anticipo se registra antes de que exista un adicional). Se aisla aqui.
   * VISITA: costo acordado. SALDO: se calcula al consultar (null).
   */
  private expectedFor(
    concept: PaymentConcept,
    terms: AcceptedOfferTerms,
  ): Prisma.Decimal | null {
    if (concept === 'ANTICIPO') {
      return computeAdvanceAmount(terms.amount);
    }
    if (concept === 'VISITA') {
      return terms.visitCost;
    }
    return null;
  }

  private async findOrCreatePayment(
    tx: Db,
    orderId: string,
    concept: PaymentConcept,
    expectedAmount: Prisma.Decimal | null,
  ) {
    const existing = await tx.payment.findUnique({
      where: { orderId_concept: { orderId, concept } },
      select: { id: true, expectedAmount: true },
    });
    if (existing) {
      return existing;
    }
    return tx.payment.create({
      data: { orderId, concept, expectedAmount },
      select: { id: true, expectedAmount: true },
    });
  }

  private toPaymentView(
    concept: PaymentConcept,
    paymentId: string | null,
    expectedAmount: Prisma.Decimal | null,
    declarations: {
      id: string;
      declaredBy: PaymentDeclarer;
      userId: string;
      method: DeclarationView['method'];
      amount: Prisma.Decimal;
      createdAt: Date;
    }[],
  ): PaymentView {
    const summary: DeclarationSummary = summarizeDeclarations(declarations);
    return {
      concept,
      paymentId,
      expectedAmount: money(expectedAmount),
      requiredConfirmation: requiredConfirmationFor(
        concept,
        this.config.advanceConfirmedBy,
      ),
      declarations: declarations.map(toDeclarationView),
      comparison: summary.comparison,
      difference: money(summary.difference),
      methodsMatch: summary.methodsMatch,
    };
  }

  /**
   * Saldo esperado informativo: acordado + adicionales aceptados - anticipo.
   * Sin oferta aceptada no hay saldo que calcular.
   */
  private balanceView(
    agreement: { baseAmount: string; acceptedAdditional: string } | null,
  ): BalanceView {
    const note =
      'Informativo: el saldo real es lo que las partes declaran. La plataforma no recibe ni retiene dinero.';
    if (!agreement) {
      return {
        status: 'PENDIENTE_INTEGRACION',
        amount: null,
        advanceAmount: null,
        additionalBudgetsTotal: null,
        note: 'El pedido no tiene una oferta aceptada: no hay saldo que calcular.',
      };
    }
    const balance = computeExpectedBalance({
      agreedAmount: agreement.baseAmount,
      additionalBudgetsTotal: agreement.acceptedAdditional,
    });
    if (balance.status !== 'CALCULADO') {
      return {
        status: balance.status,
        amount: null,
        advanceAmount: null,
        additionalBudgetsTotal: null,
        note: balance.reason,
      };
    }
    return {
      status: 'CALCULADO',
      amount: balance.amount.toFixed(2),
      advanceAmount: balance.advanceAmount.toFixed(2),
      additionalBudgetsTotal: balance.additionalBudgetsTotal.toFixed(2),
      note,
    };
  }

  /** Aviso a la contraparte, y a ambas y a los administradores si los montos difieren. */
  private async notifyDeclaration(
    tx: Db,
    event: {
      orderId: string;
      clientId: string;
      workerId: string;
      declaredBy: PaymentDeclarer;
      concept: PaymentConcept;
      amount: Prisma.Decimal;
      view: PaymentView;
    },
  ): Promise<void> {
    const label = CONCEPT_LABELS[event.concept];
    const resource = {
      type: NotificationResourceType.PEDIDO,
      id: event.orderId,
    };
    const counterpart =
      event.declaredBy === 'CLIENTE' ? event.workerId : event.clientId;
    await this.notifications.create(
      counterpart,
      {
        type: NotificationType.PAGO_DECLARADO,
        title: 'Pago declarado',
        message:
          event.declaredBy === 'CLIENTE'
            ? `El cliente declaró haber pagado el ${label} (Bs ${event.amount.toFixed(2)}).`
            : `El trabajador confirmó haber recibido el ${label} (Bs ${event.amount.toFixed(2)}).`,
        resource,
      },
      tx,
    );
    if (event.view.comparison === 'MONTOS_DIFERENTES') {
      const message = `Las declaraciones del ${label} no coinciden (diferencia Bs ${event.view.difference}). Un administrador puede revisarlo.`;
      for (const userId of [event.clientId, event.workerId]) {
        await this.notifications.create(
          userId,
          {
            type: NotificationType.PAGO_CON_DIFERENCIA,
            title: 'Pago con diferencia',
            message,
            resource,
          },
          tx,
        );
      }
      await this.notifications.createForRole(
        RoleName.ADMINISTRADOR,
        {
          type: NotificationType.PAGO_CON_DIFERENCIA,
          title: 'Pago con diferencia',
          message: `Pedido con declaraciones de ${label} distintas (diferencia Bs ${event.view.difference}).`,
          resource,
        },
        {},
        tx,
      );
    }
  }

  /**
   * ACORDADO -> ANTICIPO_REGISTRADO (RF-39). Decision funcional definitiva:
   * SOLO la confirmacion de recepcion del trabajador asignado la produce; una
   * declaracion del cliente nunca, aunque ya exista una del trabajador. Pasa
   * por OrdersService.transition(), asi que los invariantes beforeTransition
   * de ServiceWorkflowModule y ClaimsModule siguen vigentes.
   */
  private async maybeRegisterAdvance(
    tx: Db,
    input: {
      orderId: string;
      userId: string;
      declaredBy: PaymentDeclarer;
      concept: PaymentConcept;
      status: OrderStatus;
    },
  ): Promise<OrderTransitionOutcome> {
    const confirms = isAdvanceReceiptConfirmation(
      input.concept,
      input.declaredBy,
      this.config.advanceConfirmedBy,
    );
    if (!confirms || input.status !== OrderStatus.ACORDADO) {
      return 'NO_APLICA';
    }
    await this.orders.transition(tx, {
      orderId: input.orderId,
      from: OrderStatus.ACORDADO,
      to: OrderStatus.ANTICIPO_REGISTRADO,
      actor: {
        type: 'USUARIO',
        userId: input.userId,
        role: RoleName.TRABAJADOR,
      },
      reason: 'Anticipo declarado',
    });
    return 'ANTICIPO_REGISTRADO';
  }
}

function roleIn(
  order: { clientId: string; assignedWorkerId: string | null },
  userId: string,
): PaymentDeclarer | null {
  if (order.clientId === userId) {
    return 'CLIENTE';
  }
  if (order.assignedWorkerId !== null && order.assignedWorkerId === userId) {
    return 'TRABAJADOR';
  }
  return null;
}

function orderNotFound(): NotFoundException {
  return new NotFoundException('El pedido no existe');
}
