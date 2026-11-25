import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  OfferEventType,
  OfferParty,
  OfferStatus,
  OrderActorType,
  OrderStatus,
  Prisma,
  RoleName,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogKind, CatalogsService } from '../catalogs/catalogs.service.js';
import type { OrderActor } from '../orders/order-history.js';
import { OrderVisibilityService } from '../orders/order-visibility.service.js';
import { ORDER_OPEN_FOR_OFFERS_STATUSES } from '../orders/orders.rules.js';
import { lockOrder, OrdersService } from '../orders/orders.service.js';
import { UsersService } from '../users/users.service.js';
import { WorkerActiveWorkRegistry } from '../worker-profile/active-work.registry.js';
import { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import type { CounterOfferDto } from './dto/counter-offer.dto.js';
import type { CreateOfferDto } from './dto/create-offer.dto.js';
import { buildWhatsAppContact, type WhatsAppContact } from './offer-contact.js';
import {
  OfferEventRegistry,
  type OfferNegotiationEvent,
} from './offer-events.registry.js';
import {
  assertCanClose,
  assertCanCounter,
  lockOffer,
  offerNotFound,
  otherParty,
  partyOf,
  slotsOverlap,
} from './offer-negotiation.js';
import type {
  ListOffersQueryDto,
  ListReceivedOffersQueryDto,
} from './dto/list-offers-query.dto.js';
import {
  OFFER_EVENT_SELECT,
  OFFER_SELECT,
  OfferDetail,
  OfferView,
  offerStatusWhere,
  PaginatedOffers,
  RECEIVED_OFFER_SELECT,
  ReceivedOfferView,
  toOfferEventView,
  toOfferView,
  toReceivedOfferView,
} from './offer-views.js';
import {
  OFFER_ACCEPTANCE_PROCESS,
  OFFER_CLOSING_EVENT,
  OFFER_CLOSURE_PROCESS,
  OFFER_EXPIRATION_PROCESS,
  OFFER_REOFFER_BLOCKING_STATUSES,
  OFFER_SUPERSEDED_REASON,
  OFFER_VALIDITY_HOURS,
  OfferClosureReason,
} from './offers.rules.js';

type Db = Prisma.TransactionClient | PrismaService;

const PRISMA_UNIQUE_VIOLATION = 'P2002';

const DUPLICATE_OFFER_MESSAGE = 'Ya tiene una oferta vigente para este pedido.';

/** Motivo por el que una oferta anterior impide volver a ofertar. */
const REOFFER_BLOCKED_MESSAGE: Readonly<Record<string, string>> = {
  [OfferStatus.ACEPTADA]: 'Su oferta para este pedido ya fue aceptada.',
  [OfferStatus.RECHAZADA]:
    'Su oferta para este pedido fue rechazada: no puede volver a ofertar.',
  [OfferStatus.RETIRADA]:
    'Retiró su oferta para este pedido: no puede volver a ofertar.',
  [OfferStatus.SIN_EFECTO]:
    'Su oferta para este pedido quedó sin efecto: no puede volver a ofertar.',
};

/** Hora de la BD: la vigencia se calcula siempre con el reloj de PostgreSQL. */
async function dbNow(db: Db): Promise<Date> {
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  return now;
}

/**
 * Ofertas y negociacion (T6.2: creacion y consultas). La disponibilidad del
 * pedido y la habilitacion del trabajador las decide OrdersModule
 * (OrderVisibilityService.assertOpenForOffers) dentro de la transaccion y con
 * el orden de bloqueos del proyecto: trabajador, pedido y catalogos. Esta
 * etapa no cambia el estado del pedido.
 */
/** Condiciones de la oferta aceptada que otros modulos pueden consultar. */
export interface AcceptedOfferTerms {
  offerId: string;
  workerId: string;
  amount: Prisma.Decimal;
  requiresVisit: boolean;
  visitCost: Prisma.Decimal | null;
  proposedStartAt: Date;
  estimatedDurationMinutes: number;
}

/** Evento de la negociacion para la linea de tiempo (solo lectura). */
export interface NegotiationEventRecord {
  id: string;
  offerId: string;
  type: OfferEventType;
  round: number;
  amount: Prisma.Decimal | null;
  actorType: OrderActorType;
  changedById: string | null;
  actorRole: RoleName | null;
  systemProcess: string | null;
  createdAt: Date;
  workerId: string;
  clientId: string;
}

/** Horario de un trabajo acordado (oferta aceptada). */
export interface AcceptedJobSlot {
  orderId: string;
  proposedStartAt: Date;
  estimatedDurationMinutes: number;
}

@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: OrderVisibilityService,
    private readonly orders: OrdersService,
    private readonly users: UsersService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly catalogs: CatalogsService,
    private readonly activeWork: WorkerActiveWorkRegistry,
    // Opcional: sin registro (o sin hooks) no se emite ningun aviso.
    @Optional() private readonly offerEvents?: OfferEventRegistry,
  ) {}

  /** Avisa a los modulos registrados (RF-33), dentro de la transaccion del hecho. */
  private async emit(
    tx: Prisma.TransactionClient,
    event: OfferNegotiationEvent,
  ): Promise<void> {
    await this.offerEvents?.runInTransaction([event], tx);
  }

  // ---------------------------------------------------------------------
  // RF-20 y RF-23: contraoferta
  // ---------------------------------------------------------------------

  /**
   * Contraoferta del cliente dueno del pedido o del trabajador de la oferta,
   * segun a quien le toque el turno. Solo cambia el monto: sube la ronda (2 o
   * 3), pasa el turno a la otra parte y reinicia la vigencia de 24 horas.
   *
   * Orden de bloqueos (el del proyecto, extendido a la oferta): cuenta del
   * cliente (FOR SHARE), trabajador (lockApprovedWorker), pedido (lockOrder),
   * fila de la oferta (FOR UPDATE) y catalogos (FOR SHARE). Dos respuestas
   * simultaneas se ejecutan de a una: la segunda ve el turno ya cambiado
   * (409) y, como respaldo, la BD impide dos eventos de la misma ronda.
   */
  async counter(
    userId: string,
    offerId: string,
    dto: CounterOfferDto,
  ): Promise<OfferDetail<OfferView>> {
    // Lectura previa sin bloqueo, solo para saber a quien bloquear: todo se
    // vuelve a comprobar con los bloqueos tomados.
    const target = await this.prisma.offer.findUnique({
      where: { id: offerId },
      select: {
        workerId: true,
        orderId: true,
        order: { select: { clientId: true } },
      },
    });
    const party = target ? partyOf(target, userId) : null;
    if (!target || !party) {
      throw offerNotFound();
    }
    const { orderId, workerId } = target;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Decision 9: con el cliente o el trabajador suspendidos la oferta
        // deja de ser valida.
        const client = await this.users.findByIdForShare(
          tx,
          target.order.clientId,
        );
        if (client.status !== UserStatus.ACTIVO) {
          throw new ConflictException(
            'La cuenta del cliente no está activa: la oferta ya no es válida.',
          );
        }
        // Perfil aprobado, cuenta activa y sin cambio de zona pendiente. No
        // exige la especialidad de la categoria actual (decision 12).
        await this.workerProfiles.lockApprovedWorker(tx, workerId);
        const order = await lockOrder(tx, orderId);
        if (!order) {
          throw offerNotFound();
        }
        if (!ORDER_OPEN_FOR_OFFERS_STATUSES.includes(order.effectiveStatus)) {
          throw new ConflictException(
            `El pedido ya no admite negociación (estado ${order.effectiveStatus}).`,
          );
        }
        const offer = await lockOffer(tx, offerId);
        if (!offer) {
          throw offerNotFound();
        }
        const now = await dbNow(tx);
        assertCanCounter(offer, party, now);
        await this.assertOrderCatalogsActive(tx, orderId);

        const round = offer.round + 1;
        await tx.offer.update({
          where: { id: offerId },
          data: {
            round,
            amount: dto.amount,
            turn: otherParty(party),
            expiresAt: addHours(now, OFFER_VALIDITY_HOURS),
          },
        });
        await tx.offerEvent.create({
          data: {
            offerId,
            orderId,
            type: OfferEventType.CONTRAOFERTA,
            round,
            amount: dto.amount,
            actorType: OrderActorType.USUARIO,
            changedById: userId,
            actorRole:
              party === OfferParty.CLIENTE
                ? RoleName.CLIENTE
                : RoleName.TRABAJADOR,
          },
        });
        await this.emit(tx, {
          type: 'CONTRAOFERTA',
          offerId,
          orderId,
          workerId,
          clientId: target.order.clientId,
          actorId: userId,
          round,
          amount: String(dto.amount),
        });
      });
    } catch (error) {
      // Respaldo de la BD (offer_events_offer_round_key): ya se confirmo
      // otra contraoferta de esta ronda.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(
          'La oferta cambió mientras se procesaba la contraoferta. Vuelva a consultarla.',
        );
      }
      throw error;
    }
    return party === OfferParty.CLIENTE
      ? this.getReceived(userId, offerId)
      : this.getOwn(userId, offerId);
  }

  // ---------------------------------------------------------------------
  // T6.4.2: aceptacion y asignacion del trabajador
  // ---------------------------------------------------------------------

  /**
   * El cliente dueno del pedido acepta la oferta en su turno. En una sola
   * transaccion:
   * 1. valida cliente y trabajador (cuentas activas, perfil aprobado, sin
   *    cambio de zona pendiente), pedido EN_NEGOCIACION y sin vencer, oferta
   *    VIGENTE en el turno del cliente, zona y categoria activas. No exige
   *    la especialidad de la categoria actual (decision 12);
   * 2. RF-30: el horario de la oferta no se cruza con otro trabajo activo
   *    del trabajador (OrdersService.findActiveAssignedOrderIds);
   * 3. asigna al trabajador con OrdersService.transition (EN_NEGOCIACION ->
   *    ACORDADO, assignWorkerId);
   * 4. cierra la oferta como ACEPTADA y las demas VIGENTES del pedido como
   *    SIN_EFECTO, cada una con su evento.
   *
   * Orden de bloqueos: cuenta del cliente (FOR SHARE), trabajador, pedido,
   * oferta y catalogos (transition vuelve a tomar trabajador y pedido, ya
   * bloqueados). Con el trabajador bloqueado ninguna otra asignacion suya se
   * confirma en paralelo; con el pedido bloqueado, ninguna otra operacion de
   * sus ofertas. Respaldos de la BD: una sola ACEPTADA por pedido y un solo
   * cierre por oferta.
   */
  async accept(
    clientId: string,
    offerId: string,
  ): Promise<OfferDetail<OfferView>> {
    const target = await this.prisma.offer.findUnique({
      where: { id: offerId },
      select: {
        workerId: true,
        orderId: true,
        order: { select: { clientId: true } },
      },
    });
    const party = target ? partyOf(target, clientId) : null;
    if (!target || !party) {
      throw offerNotFound();
    }
    if (party !== OfferParty.CLIENTE) {
      throw new ForbiddenException(
        'Solo el cliente del pedido puede aceptar la oferta.',
      );
    }
    const { orderId, workerId } = target;

    try {
      await this.prisma.$transaction(async (tx) => {
        const client = await this.users.findByIdForShare(tx, clientId);
        if (client.status !== UserStatus.ACTIVO) {
          throw new ConflictException(
            'La cuenta del cliente no está activa: la oferta ya no es válida.',
          );
        }
        await this.workerProfiles.lockApprovedWorker(tx, workerId);
        const order = await lockOrder(tx, orderId);
        if (!order) {
          throw offerNotFound();
        }
        if (order.effectiveStatus !== OrderStatus.EN_NEGOCIACION) {
          throw new ConflictException(
            `El pedido ya no admite aceptar ofertas (estado ${order.effectiveStatus}).`,
          );
        }
        if (order.assignedWorkerId !== null) {
          throw new ConflictException(
            'El pedido ya tiene un trabajador asignado.',
          );
        }
        const offer = await lockOffer(tx, offerId);
        if (!offer) {
          throw offerNotFound();
        }
        const now = await dbNow(tx);
        assertCanClose(offer, OfferParty.CLIENTE, now, 'aceptar');
        await this.assertOrderCatalogsActive(tx, orderId);
        await this.assertNoScheduleConflict(tx, offerId, workerId);

        await this.orders.transition(tx, {
          orderId,
          from: OrderStatus.EN_NEGOCIACION,
          to: OrderStatus.ACORDADO,
          assignWorkerId: workerId,
          actor: clientActor(clientId),
        });

        await tx.offer.update({
          where: { id: offerId },
          data: { status: OfferStatus.ACEPTADA, closedAt: now },
        });
        await tx.offerEvent.create({
          data: {
            offerId,
            orderId,
            type: OfferEventType.ACEPTADA,
            round: offer.round,
            actorType: OrderActorType.USUARIO,
            changedById: clientId,
            actorRole: RoleName.CLIENTE,
          },
        });
        await this.supersedeOtherOffers(tx, orderId, offerId, now);
        await this.emit(tx, {
          type: 'ACEPTADA',
          offerId,
          orderId,
          workerId,
          clientId,
          actorId: clientId,
          round: offer.round,
          amount: null,
        });
      });
    } catch (error) {
      // Respaldos de la BD: offers_one_accepted_per_order_key y
      // offer_events_offer_closing_key.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(
          'El pedido o la oferta cambiaron mientras se aceptaba. Vuelva a consultarlos.',
        );
      }
      throw error;
    }
    return this.getReceived(clientId, offerId);
  }

  /**
   * RF-30 y RF-31: el trabajo de la oferta no puede cruzarse en el tiempo
   * con otro trabajo activo del trabajador. Que pedidos son trabajo activo
   * lo decide OrdersModule; el horario de cada uno es el de su oferta
   * aceptada (inicio propuesto y duracion estimada). 409 con los cruces.
   */
  private async assertNoScheduleConflict(
    tx: Prisma.TransactionClient,
    offerId: string,
    workerId: string,
  ): Promise<void> {
    const activeOrderIds = await this.orders.findActiveAssignedOrderIds(
      tx,
      workerId,
    );
    if (activeOrderIds.length === 0) {
      return;
    }
    const slot = { proposedStartAt: true, estimatedDurationMinutes: true };
    const [candidate, jobs] = await Promise.all([
      tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: slot }),
      tx.offer.findMany({
        where: {
          workerId,
          status: OfferStatus.ACEPTADA,
          orderId: { in: activeOrderIds },
        },
        select: { orderId: true, ...slot },
      }),
    ]);
    const conflicts = jobs.filter((job) => slotsOverlap(candidate, job));
    if (conflicts.length > 0) {
      throw new ConflictException(
        `El trabajador ya tiene un trabajo acordado en ese horario (pedido ${conflicts
          .map((job) => job.orderId)
          .join(', ')}).`,
      );
    }
  }

  /** Decision 6: las demas ofertas vigentes del pedido quedan SIN_EFECTO. */
  private async supersedeOtherOffers(
    tx: Prisma.TransactionClient,
    orderId: string,
    acceptedOfferId: string,
    now: Date,
  ): Promise<void> {
    const others = await tx.offer.findMany({
      where: {
        orderId,
        id: { not: acceptedOfferId },
        status: OfferStatus.VIGENTE,
      },
      select: { id: true, round: true },
    });
    if (others.length === 0) {
      return;
    }
    await tx.offer.updateMany({
      where: {
        id: { in: others.map((other) => other.id) },
        status: OfferStatus.VIGENTE,
      },
      data: { status: OfferStatus.SIN_EFECTO, closedAt: now },
    });
    await tx.offerEvent.createMany({
      data: others.map((other) => ({
        offerId: other.id,
        orderId,
        type: OfferEventType.SIN_EFECTO,
        round: other.round,
        actorType: OrderActorType.SISTEMA,
        systemProcess: OFFER_ACCEPTANCE_PROCESS,
        reason: OFFER_SUPERSEDED_REASON,
      })),
    });
  }

  // ---------------------------------------------------------------------
  // T6.5.1: vencimiento de ofertas (lo usa OfferExpirationService)
  // ---------------------------------------------------------------------

  /**
   * Consulta publica de solo lectura para ServiceWorkflowModule (RF-25, RF-26,
   * RF-36): condiciones de la oferta ACEPTADA del pedido, o null si no hay.
   * No bloquea ni escribe. Usa el cliente `db` del llamador.
   */
  async getAcceptedOfferTerms(
    db: Prisma.TransactionClient,
    orderId: string,
  ): Promise<AcceptedOfferTerms | null> {
    const offer = await db.offer.findFirst({
      where: { orderId, status: OfferStatus.ACEPTADA },
      select: {
        id: true,
        workerId: true,
        amount: true,
        requiresVisit: true,
        visitCost: true,
        proposedStartAt: true,
        estimatedDurationMinutes: true,
      },
    });
    if (!offer) {
      return null;
    }
    const { id, ...terms } = offer;
    return { offerId: id, ...terms };
  }

  /**
   * Consulta publica de solo lectura para TimelineModule (RF-32): historial de
   * la negociacion del pedido, del mas antiguo al mas reciente. Incluye el
   * trabajador de cada oferta y el cliente del pedido para saber quien ofrecio
   * y a quien. Sin direccion ni contactos.
   */
  async listNegotiationEvents(
    db: Prisma.TransactionClient,
    orderId: string,
  ): Promise<NegotiationEventRecord[]> {
    const events = await db.offerEvent.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        offerId: true,
        type: true,
        round: true,
        amount: true,
        actorType: true,
        changedById: true,
        actorRole: true,
        systemProcess: true,
        createdAt: true,
        offer: { select: { workerId: true } },
        order: { select: { clientId: true } },
      },
    });
    return events.map(({ offer, order, ...event }) => ({
      ...event,
      workerId: offer.workerId,
      clientId: order.clientId,
    }));
  }

  /**
   * Consulta publica de solo lectura para la agenda (RF-30): horario de las
   * ofertas ACEPTADAS del trabajador en los pedidos indicados.
   */
  async findAcceptedJobSlots(
    db: Prisma.TransactionClient,
    workerId: string,
    orderIds: readonly string[],
  ): Promise<AcceptedJobSlot[]> {
    if (orderIds.length === 0) {
      return [];
    }
    return db.offer.findMany({
      where: {
        workerId,
        status: OfferStatus.ACEPTADA,
        orderId: { in: [...orderIds] },
      },
      select: {
        orderId: true,
        proposedStartAt: true,
        estimatedDurationMinutes: true,
      },
      orderBy: { proposedStartAt: 'asc' },
    });
  }

  /**
   * Cierra como VENCIDA, con su evento del sistema, cada oferta VIGENTE del
   * pedido cuya vigencia ya termino (reloj de la BD) y, si el pedido queda
   * EN_NEGOCIACION sin ofertas vigentes, lo devuelve a PUBLICADO con
   * OrdersService.transition (sin tocar publishedAt ni expiresAt). Un pedido
   * vencido o cancelado no cambia de estado; sus ofertas igual se cierran.
   *
   * Bloqueos en el orden del proyecto: pedido (lockOrder) y despues sus
   * ofertas (FOR UPDATE, por id). Toda operacion sobre ofertas bloquea antes
   * el pedido, asi que solo una cierra cada oferta: lo que ya cerro otra
   * operacion o instancia no se vuelve a tocar (idempotente). Devuelve
   * cuantas ofertas vencio.
   */
  async expireOffersOfOrder(orderId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order) {
        return 0;
      }
      const due = await tx.$queryRaw<
        { id: string; round: number; workerId: string }[]
      >`
        SELECT "id"::text AS "id", "round", "worker_id"::text AS "workerId"
        FROM "offers"
        WHERE "order_id" = ${orderId}::uuid
          AND "status" = 'VIGENTE'
          AND "expires_at" <= now()
        ORDER BY "id"
        FOR UPDATE`;
      if (due.length === 0) {
        return 0;
      }
      const now = await dbNow(tx);
      await tx.offer.updateMany({
        where: {
          id: { in: due.map((offer) => offer.id) },
          status: OfferStatus.VIGENTE,
        },
        data: { status: OfferStatus.VENCIDA, closedAt: now },
      });
      await tx.offerEvent.createMany({
        data: due.map((offer) => ({
          offerId: offer.id,
          orderId,
          type: OfferEventType.VENCIDA,
          round: offer.round,
          actorType: OrderActorType.SISTEMA,
          systemProcess: OFFER_EXPIRATION_PROCESS,
        })),
      });
      for (const offer of due) {
        await this.emit(tx, {
          type: 'VENCIDA',
          offerId: offer.id,
          orderId,
          workerId: offer.workerId,
          clientId: order.clientId,
          actorId: null,
          round: offer.round,
          amount: null,
        });
      }
      // Un pedido vencido sin marcar (estado efectivo) no admite transiciones.
      if (order.effectiveStatus === OrderStatus.EN_NEGOCIACION) {
        await this.reopenIfNoOpenOffers(tx, orderId, order.status, now, {
          type: 'SISTEMA',
          process: OFFER_EXPIRATION_PROCESS,
        });
      }
      return due.length;
    });
  }

  // ---------------------------------------------------------------------
  // T6.5.2: cierres por cambios externos (los usa OffersClosureHooks)
  // ---------------------------------------------------------------------

  /**
   * Cierra, con su evento del sistema y el motivo, las ofertas VIGENTE del
   * pedido (o solo las de `workerId`). El llamador ya bloqueo el pedido;
   * aqui se bloquean sus ofertas (FOR UPDATE, por id). No cambia el estado
   * del pedido. Lo ya cerrado no se toca (idempotente). Devuelve cuantas
   * cerro.
   */
  async closeOpenOffersOfOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    status: typeof OfferStatus.SIN_EFECTO | typeof OfferStatus.VENCIDA,
    reason: OfferClosureReason,
    workerId?: string,
  ): Promise<number> {
    const open = await tx.$queryRaw<{ id: string; round: number }[]>`
      SELECT "id"::text AS "id", "round"
      FROM "offers"
      WHERE "order_id" = ${orderId}::uuid
        AND "status" = 'VIGENTE'
        AND (${workerId ?? null}::uuid IS NULL OR "worker_id" = ${workerId ?? null}::uuid)
      ORDER BY "id"
      FOR UPDATE`;
    if (open.length === 0) {
      return 0;
    }
    const now = await dbNow(tx);
    await tx.offer.updateMany({
      where: {
        id: { in: open.map((offer) => offer.id) },
        status: OfferStatus.VIGENTE,
      },
      data: { status, closedAt: now },
    });
    await tx.offerEvent.createMany({
      data: open.map((offer) => ({
        offerId: offer.id,
        orderId,
        type: OFFER_CLOSING_EVENT[status],
        round: offer.round,
        actorType: OrderActorType.SISTEMA,
        systemProcess: OFFER_CLOSURE_PROCESS,
        reason,
      })),
    });
    return open.length;
  }

  /**
   * Suspension de una cuenta (AccountStatusRegistry, la cuenta ya esta
   * bloqueada): quedan SIN_EFECTO sus ofertas como trabajador y las ofertas
   * VIGENTE que recibio como cliente.
   */
  async closeOffersOfSuspendedAccount(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<number> {
    // Trabajador despues de la cuenta y antes que los pedidos (orden del
    // proyecto). Con el trabajador bloqueado ninguna oferta suya nueva se
    // confirma en paralelo: la creacion tambien lo bloquea y, al seguir,
    // relee la cuenta ya suspendida.
    await this.activeWork.lockWorker(tx, userId);
    const asWorker = await tx.offer.findMany({
      where: { workerId: userId, status: OfferStatus.VIGENTE },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    // Como cliente: todos sus pedidos abiertos, no solo los que hoy tienen
    // ofertas. Una oferta que se crea en paralelo bloquea el pedido: o se
    // confirma antes (y aqui se cierra) o espera y, al seguir, ve la cuenta
    // del cliente suspendida (OrderVisibilityService). Lectura de solo
    // lectura sobre los pedidos del cliente, como clientOffersWhere.
    const asClient = await tx.order.findMany({
      where: {
        clientId: userId,
        status: { in: [...ORDER_OPEN_FOR_OFFERS_STATUSES] },
      },
      select: { id: true },
    });
    const targets = new Map<
      string,
      { workerId?: string; reason: OfferClosureReason }
    >();
    for (const { orderId } of asWorker) {
      targets.set(orderId, {
        workerId: userId,
        reason: OfferClosureReason.TRABAJADOR_SUSPENDIDO,
      });
    }
    for (const { id } of asClient) {
      targets.set(id, { reason: OfferClosureReason.CLIENTE_SUSPENDIDO });
    }
    return this.closeInOrders(tx, targets);
  }

  /**
   * Suspension del perfil (WorkerProfileStatusRegistry, el perfil ya esta
   * bloqueado): sus ofertas VIGENTE quedan SIN_EFECTO.
   */
  async closeOffersOfSuspendedProfile(
    tx: Prisma.TransactionClient,
    workerUserId: string,
  ): Promise<number> {
    const asWorker = await tx.offer.findMany({
      where: { workerId: workerUserId, status: OfferStatus.VIGENTE },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    return this.closeInOrders(
      tx,
      new Map(
        asWorker.map(({ orderId }) => [
          orderId,
          {
            workerId: workerUserId,
            reason: OfferClosureReason.PERFIL_SUSPENDIDO,
          },
        ]),
      ),
    );
  }

  /**
   * Por cada pedido, en orden de id (evita esperas cruzadas entre dos
   * suspensiones): bloquea el pedido, cierra sus ofertas y, si queda
   * EN_NEGOCIACION sin ofertas vigentes, lo devuelve a PUBLICADO por
   * OrdersService.transition (decision 10). Un pedido vencido o cerrado no
   * cambia de estado.
   */
  private async closeInOrders(
    tx: Prisma.TransactionClient,
    targets: Map<string, { workerId?: string; reason: OfferClosureReason }>,
  ): Promise<number> {
    let total = 0;
    for (const orderId of [...targets.keys()].sort()) {
      const { workerId, reason } = targets.get(orderId)!;
      const order = await lockOrder(tx, orderId);
      if (!order) {
        continue;
      }
      const closed = await this.closeOpenOffersOfOrder(
        tx,
        orderId,
        OfferStatus.SIN_EFECTO,
        reason,
        workerId,
      );
      total += closed;
      if (closed > 0 && order.effectiveStatus === OrderStatus.EN_NEGOCIACION) {
        await this.reopenIfNoOpenOffers(
          tx,
          orderId,
          order.status,
          await dbNow(tx),
          { type: 'SISTEMA', process: OFFER_CLOSURE_PROCESS },
        );
      }
    }
    return total;
  }

  // ---------------------------------------------------------------------
  // T6.4.1: rechazo (cliente) y retiro (trabajador)
  // ---------------------------------------------------------------------

  /** El cliente dueno del pedido rechaza la oferta, en su turno. */
  reject(clientId: string, offerId: string): Promise<OfferDetail<OfferView>> {
    return this.closeByParticipant(
      clientId,
      offerId,
      OfferParty.CLIENTE,
      OfferStatus.RECHAZADA,
    );
  }

  /**
   * El trabajador retira su oferta, sin importar el turno. Despues no puede
   * volver a ofertar por ese pedido (closePreviousOffers).
   */
  withdraw(
    workerUserId: string,
    offerId: string,
  ): Promise<OfferDetail<OfferView>> {
    return this.closeByParticipant(
      workerUserId,
      offerId,
      OfferParty.TRABAJADOR,
      OfferStatus.RETIRADA,
    );
  }

  /**
   * Cierra la oferta con su evento y, si ya no quedan ofertas vigentes,
   * devuelve el pedido a PUBLICADO por OrdersService.transition (decision
   * 10), sin tocar publishedAt ni expiresAt.
   *
   * Bloqueos: pedido (lockOrder) y despues la fila de la oferta. No bloquea
   * al trabajador ni la cuenta: la transicion a PUBLICADO tampoco lo hace, y
   * ninguna operacion bloquea al trabajador despues del pedido. Toda
   * operacion que crea o cierra ofertas bloquea antes el pedido: el conteo de
   * vigentes no cambia hasta confirmar.
   */
  private async closeByParticipant(
    userId: string,
    offerId: string,
    party: OfferParty,
    status: typeof OfferStatus.RECHAZADA | typeof OfferStatus.RETIRADA,
  ): Promise<OfferDetail<OfferView>> {
    const target = await this.prisma.offer.findUnique({
      where: { id: offerId },
      select: {
        workerId: true,
        orderId: true,
        order: { select: { clientId: true } },
      },
    });
    const actual = target ? partyOf(target, userId) : null;
    if (!target || !actual) {
      throw offerNotFound();
    }
    if (actual !== party) {
      throw new ForbiddenException(
        party === OfferParty.CLIENTE
          ? 'Solo el cliente del pedido puede rechazar la oferta.'
          : 'Solo el trabajador que la envió puede retirar la oferta.',
      );
    }
    const { orderId } = target;
    const actor =
      party === OfferParty.CLIENTE ? clientActor(userId) : workerActor(userId);

    try {
      await this.prisma.$transaction(async (tx) => {
        const order = await lockOrder(tx, orderId);
        if (!order) {
          throw offerNotFound();
        }
        if (!ORDER_OPEN_FOR_OFFERS_STATUSES.includes(order.effectiveStatus)) {
          throw new ConflictException(
            `El pedido ya no admite negociación (estado ${order.effectiveStatus}).`,
          );
        }
        const offer = await lockOffer(tx, offerId);
        if (!offer) {
          throw offerNotFound();
        }
        const now = await dbNow(tx);
        assertCanClose(offer, party, now);

        await tx.offer.update({
          where: { id: offerId },
          data: { status, closedAt: now },
        });
        await tx.offerEvent.create({
          data: {
            offerId,
            orderId,
            type: OFFER_CLOSING_EVENT[status],
            round: offer.round,
            actorType: OrderActorType.USUARIO,
            changedById: userId,
            actorRole:
              party === OfferParty.CLIENTE
                ? RoleName.CLIENTE
                : RoleName.TRABAJADOR,
          },
        });
        await this.reopenIfNoOpenOffers(tx, orderId, order.status, now, actor);
        await this.emit(tx, {
          type: status === OfferStatus.RECHAZADA ? 'RECHAZADA' : 'RETIRADA',
          offerId,
          orderId,
          workerId: target.workerId,
          clientId: target.order.clientId,
          actorId: userId,
          round: offer.round,
          amount: null,
        });
      });
    } catch (error) {
      // Respaldo de la BD (offer_events_offer_closing_key): la oferta ya
      // tiene un cierre registrado.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException('La oferta ya fue cerrada.');
      }
      throw error;
    }
    return party === OfferParty.CLIENTE
      ? this.getReceived(userId, offerId)
      : this.getOwn(userId, offerId);
  }

  /**
   * Sin ofertas vigentes (VIGENTE y sin vencer), un pedido EN_NEGOCIACION
   * vuelve a PUBLICADO. Se llama con el pedido bloqueado.
   */
  private async reopenIfNoOpenOffers(
    tx: Prisma.TransactionClient,
    orderId: string,
    orderStatus: OrderStatus,
    now: Date,
    actor: OrderActor,
  ): Promise<void> {
    if (orderStatus !== OrderStatus.EN_NEGOCIACION) {
      return;
    }
    const open = await tx.offer.count({
      where: { orderId, status: OfferStatus.VIGENTE, expiresAt: { gt: now } },
    });
    if (open === 0) {
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.EN_NEGOCIACION,
        to: OrderStatus.PUBLICADO,
        actor,
      });
    }
  }

  /**
   * Zona y categoria del pedido activas, bloqueadas (FOR SHARE) hasta
   * confirmar. Con el pedido bloqueado no cambian. Orden fijo: zona y
   * categoria, como OrderVisibilityService. 409 si alguna esta inactiva.
   */
  private async assertOrderCatalogsActive(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    const { zoneId, categoryId } = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { zoneId: true, categoryId: true },
    });
    const [zone] = await this.catalogs.findByIdsForShare(tx, CatalogKind.ZONE, [
      zoneId,
    ]);
    if (!zone?.isActive) {
      throw new ConflictException(
        'La zona del pedido no está activa: por ahora no se puede negociar.',
      );
    }
    const [category] = await this.catalogs.findByIdsForShare(
      tx,
      CatalogKind.CATEGORY,
      [categoryId],
    );
    if (!category?.isActive) {
      throw new ConflictException(
        'La categoría del pedido no está activa: por ahora no se puede negociar.',
      );
    }
  }

  // ---------------------------------------------------------------------
  // RF-19: crear oferta
  // ---------------------------------------------------------------------

  async create(
    workerUserId: string,
    orderId: string,
    dto: CreateOfferDto,
  ): Promise<OfferDetail<OfferView>> {
    assertVisitCost(dto);
    const proposedStartAt = new Date(dto.proposedStartAt);

    let offerId: string;
    try {
      offerId = await this.prisma.$transaction(async (tx) => {
        // 1. Trabajador (bloqueado y releido: APROBADO, cuenta activa, sin
        //    cambio de zona pendiente), 2. pedido (bloqueado: visible para
        //    ese trabajador por zona, especialidad de la categoria ACTUAL,
        //    cliente activo, no propio, abierto y sin vencer) y 3. zona y
        //    categoria activas (FOR SHARE). Lo que no corresponde da 404.
        const { order } = await this.visibility.assertOpenForOffers(
          tx,
          workerUserId,
          orderId,
        );
        const now = await dbNow(tx);
        if (proposedStartAt <= now) {
          throw new BadRequestException(
            'proposedStartAt debe ser una fecha y hora futura',
          );
        }
        // El horario de atencion (WorkerSchedule) no limita las ofertas:
        // el trabajador recibe pedidos y oferta a cualquier hora y negocia el
        // horario con el cliente (aclaracion del docente).
        await this.closePreviousOffers(tx, workerUserId, orderId, now);

        const offer = await tx.offer.create({
          data: {
            orderId,
            workerId: workerUserId,
            amount: dto.amount,
            requiresVisit: dto.requiresVisit,
            visitCost: dto.requiresVisit ? dto.visitCost : null,
            materialsIncluded: dto.materialsIncluded,
            proposedStartAt,
            estimatedDurationMinutes: dto.estimatedDurationMinutes,
            expiresAt: addHours(now, OFFER_VALIDITY_HOURS),
            // status VIGENTE, round 1 y turn CLIENTE: valores por defecto.
          },
          select: { id: true },
        });
        await tx.offerEvent.create({
          data: {
            offerId: offer.id,
            orderId,
            type: OfferEventType.PROPUESTA,
            round: 1,
            amount: dto.amount,
            actorType: OrderActorType.USUARIO,
            changedById: workerUserId,
            actorRole: RoleName.TRABAJADOR,
          },
        });
        if (this.offerEvents?.hasHooks) {
          const { clientId } = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            select: { clientId: true },
          });
          await this.emit(tx, {
            type: 'PROPUESTA',
            offerId: offer.id,
            orderId,
            workerId: workerUserId,
            clientId,
            actorId: workerUserId,
            round: 1,
            amount: String(dto.amount),
          });
        }
        // T6.4.1: la primera oferta abre la negociacion. El cambio lo hace
        // OrdersModule (transition), con el pedido ya bloqueado; no toca
        // publishedAt ni expiresAt.
        if (order.status === OrderStatus.PUBLICADO) {
          await this.orders.transition(tx, {
            orderId,
            from: OrderStatus.PUBLICADO,
            to: OrderStatus.EN_NEGOCIACION,
            actor: workerActor(workerUserId),
          });
        }
        return offer.id;
      });
    } catch (error) {
      // Respaldo de la BD (offers_order_worker_open_key): no deberia ocurrir
      // porque el trabajador esta bloqueado, pero nunca da un 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(DUPLICATE_OFFER_MESSAGE);
      }
      throw error;
    }
    return this.getOwn(workerUserId, offerId);
  }

  /**
   * Ofertas anteriores del trabajador en el pedido (con el pedido bloqueado).
   * Una VIGENTE sin vencer es un duplicado; una VIGENTE ya vencida se marca
   * VENCIDA con su evento, para liberar el indice unico; ACEPTADA, RECHAZADA,
   * RETIRADA o SIN_EFECTO impiden volver a ofertar. VENCIDA lo permite.
   */
  private async closePreviousOffers(
    tx: Prisma.TransactionClient,
    workerUserId: string,
    orderId: string,
    now: Date,
  ): Promise<void> {
    const previous = await tx.offer.findMany({
      where: { orderId, workerId: workerUserId },
      select: { id: true, status: true, round: true, expiresAt: true },
    });
    const blocking = previous.find((offer) =>
      OFFER_REOFFER_BLOCKING_STATUSES.includes(offer.status),
    );
    if (blocking) {
      throw new ConflictException(REOFFER_BLOCKED_MESSAGE[blocking.status]);
    }
    for (const offer of previous) {
      if (offer.status !== OfferStatus.VIGENTE) {
        continue;
      }
      if (offer.expiresAt > now) {
        throw new ConflictException(DUPLICATE_OFFER_MESSAGE);
      }
      await tx.offer.update({
        where: { id: offer.id },
        data: { status: OfferStatus.VENCIDA, closedAt: now },
      });
      await tx.offerEvent.create({
        data: {
          offerId: offer.id,
          orderId,
          type: OfferEventType.VENCIDA,
          round: offer.round,
          actorType: OrderActorType.SISTEMA,
          systemProcess: OFFER_EXPIRATION_PROCESS,
        },
      });
    }
  }

  // ---------------------------------------------------------------------
  // Consultas del trabajador (sus ofertas)
  // ---------------------------------------------------------------------

  async listOwn(
    workerUserId: string,
    { status, page, limit }: ListOffersQueryDto,
  ): Promise<PaginatedOffers<OfferView>> {
    const now = await dbNow(this.prisma);
    const where: Prisma.OfferWhereInput = {
      AND: [{ workerId: workerUserId }, offerStatusWhere(status, now)],
    };
    const [offers, total] = await this.prisma.$transaction([
      this.prisma.offer.findMany({
        where,
        select: OFFER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.offer.count({ where }),
    ]);
    return paginated(
      offers.map((offer) => toOfferView(offer, now)),
      page,
      limit,
      total,
    );
  }

  /** Una oferta ajena responde igual que una inexistente (404). */
  async getOwn(
    workerUserId: string,
    offerId: string,
  ): Promise<OfferDetail<OfferView>> {
    const now = await dbNow(this.prisma);
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, workerId: workerUserId },
      select: { ...OFFER_SELECT, events: eventsQuery() },
    });
    if (!offer) {
      throw offerNotFound();
    }
    return {
      ...toOfferView(offer, now),
      history: offer.events.map(toOfferEventView),
    };
  }

  // ---------------------------------------------------------------------
  // Consultas del cliente (ofertas recibidas en sus pedidos)
  // ---------------------------------------------------------------------

  async listReceived(
    clientId: string,
    { orderId, status, page, limit }: ListReceivedOffersQueryDto,
  ): Promise<PaginatedOffers<ReceivedOfferView>> {
    if (orderId) {
      // Pedido ajeno o inexistente: 404, por el servicio de OrdersModule.
      await this.orders.getOwn(clientId, orderId);
    }
    const now = await dbNow(this.prisma);
    const where: Prisma.OfferWhereInput = {
      AND: [
        clientOffersWhere(clientId),
        ...(orderId ? [{ orderId }] : []),
        offerStatusWhere(status, now),
      ],
    };
    const [offers, total] = await this.prisma.$transaction([
      this.prisma.offer.findMany({
        where,
        select: RECEIVED_OFFER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.offer.count({ where }),
    ]);
    return paginated(
      offers.map((offer) => toReceivedOfferView(offer, now)),
      page,
      limit,
      total,
    );
  }

  // ---------------------------------------------------------------------
  // T6.6: contacto por WhatsApp (canal externo, no cambia la oferta)
  // ---------------------------------------------------------------------

  /**
   * El trabajador dueno de la oferta obtiene el enlace para escribir al
   * cliente del pedido. Mismo criterio de acceso que getOwn: una oferta
   * ajena responde 404. El telefono se lee por UsersService.
   */
  async workerContact(
    workerUserId: string,
    offerId: string,
  ): Promise<WhatsAppContact> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, workerId: workerUserId },
      select: { orderId: true, order: { select: { clientId: true } } },
    });
    if (!offer) {
      throw offerNotFound();
    }
    const client = await this.users.findById(offer.order.clientId);
    return buildWhatsAppContact(client.phone, 'CLIENTE', offer.orderId);
  }

  /**
   * El cliente dueno del pedido obtiene el enlace para escribir al
   * trabajador de la oferta. Mismo criterio de acceso que getReceived.
   */
  async clientContact(
    clientId: string,
    offerId: string,
  ): Promise<WhatsAppContact> {
    const offer = await this.prisma.offer.findFirst({
      where: { AND: [{ id: offerId }, clientOffersWhere(clientId)] },
      select: { orderId: true, workerId: true },
    });
    if (!offer) {
      throw offerNotFound();
    }
    const worker = await this.users.findById(offer.workerId);
    return buildWhatsAppContact(worker.phone, 'TRABAJADOR', offer.orderId);
  }

  async getReceived(
    clientId: string,
    offerId: string,
  ): Promise<OfferDetail<ReceivedOfferView>> {
    const now = await dbNow(this.prisma);
    const offer = await this.prisma.offer.findFirst({
      where: { AND: [{ id: offerId }, clientOffersWhere(clientId)] },
      select: { ...RECEIVED_OFFER_SELECT, events: eventsQuery() },
    });
    if (!offer) {
      throw offerNotFound();
    }
    return {
      ...toReceivedOfferView(offer, now),
      history: offer.events.map(toOfferEventView),
    };
  }
}

/**
 * Ofertas de los pedidos de un cliente. Filtro de solo lectura sobre la
 * relacion del pedido (mismo criterio que OrderVisibilityService con el
 * estado del cliente): OrdersService no expone los ids de los pedidos de un
 * cliente y el filtro debe resolverse en la misma consulta paginada.
 */
function clientOffersWhere(clientId: string): Prisma.OfferWhereInput {
  return { order: { clientId } };
}

function eventsQuery() {
  return {
    select: OFFER_EVENT_SELECT,
    orderBy: [{ createdAt: 'asc' as const }, { round: 'asc' as const }],
  };
}

function paginated<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
): PaginatedOffers<T> {
  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** RF-22 y RF-24: costo de visita solo si requiere visita (0 = gratis). */
function assertVisitCost(dto: CreateOfferDto): void {
  if (dto.requiresVisit && dto.visitCost === undefined) {
    throw new BadRequestException(
      'visitCost es obligatorio cuando la oferta requiere visita (use "0" si es gratis)',
    );
  }
  if (!dto.requiresVisit && dto.visitCost !== undefined) {
    throw new BadRequestException(
      'visitCost solo se indica cuando la oferta requiere visita',
    );
  }
}

function workerActor(userId: string): OrderActor {
  return { type: 'USUARIO', userId, role: RoleName.TRABAJADOR };
}

function clientActor(userId: string): OrderActor {
  return { type: 'USUARIO', userId, role: RoleName.CLIENTE };
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
