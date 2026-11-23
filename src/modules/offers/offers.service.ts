import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  OfferEventType,
  OfferParty,
  OfferStatus,
  OrderActorType,
  Prisma,
  RoleName,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogKind, CatalogsService } from '../catalogs/catalogs.service.js';
import { OrderVisibilityService } from '../orders/order-visibility.service.js';
import { ORDER_OPEN_FOR_OFFERS_STATUSES } from '../orders/orders.rules.js';
import { lockOrder, OrdersService } from '../orders/orders.service.js';
import { UsersService } from '../users/users.service.js';
import { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import type { CounterOfferDto } from './dto/counter-offer.dto.js';
import type { CreateOfferDto } from './dto/create-offer.dto.js';
import {
  assertCanCounter,
  lockOffer,
  offerNotFound,
  otherParty,
  partyOf,
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
  OFFER_EXPIRATION_PROCESS,
  OFFER_REOFFER_BLOCKING_STATUSES,
  OFFER_VALIDITY_HOURS,
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
@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: OrderVisibilityService,
    private readonly orders: OrdersService,
    private readonly users: UsersService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly catalogs: CatalogsService,
  ) {}

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
        await this.visibility.assertOpenForOffers(tx, workerUserId, orderId);
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

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}
