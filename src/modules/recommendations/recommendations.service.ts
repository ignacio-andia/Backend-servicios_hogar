import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AuditAction,
  AuditEntityType,
  OfferStatus,
  OrderStatus,
  RoleName,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OffersService } from '../offers/offers.service.js';
import { dbNow } from '../orders/order-support.js';
import { ORDER_WORKER_VISIBLE_STATUSES } from '../orders/orders.rules.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  type RecommendationCandidate,
  WorkerProfileService,
} from '../worker-profile/worker-profile.service.js';
import type { UpdateRecommendationSettingsDto } from './dto/update-recommendation-settings.dto.js';
import {
  AVAILABILITY_WINDOW_DAYS,
  type CandidateFacts,
  MAX_RECOMMENDED_WORKERS,
  minutesWithin,
  rankCandidates,
} from './recommendation-scoring.js';
import {
  RECOMMENDATION_SELECT,
  type RecommendationSettingsOverview,
  type RecommendationView,
  SETTINGS_SELECT,
  type SettingsRecord,
  toRecommendationView,
  toSettingsView,
} from './recommendation-views.js';

type Db = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** Cuantas recomendaciones anteriores de un pedido se devuelven. */
export const RECOMMENDATION_HISTORY_LIMIT = 10;

/**
 * Estados en los que el cliente todavia elige trabajador: los mismos en los
 * que los trabajadores ven el pedido y pueden ofertar.
 */
export const RECOMMENDABLE_ORDER_STATUSES = ORDER_WORKER_VISIBLE_STATUSES;

/** Trabajos que cuentan como servicio completado: terminados, con fecha de fin. */
const COMPLETED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.TERMINADO,
  OrderStatus.CERRADO,
];

export const NOT_RECOMMENDABLE_MESSAGE =
  'Solo se recomiendan trabajadores mientras el pedido está publicado o en negociación.';
export const WEIGHTS_SUM_MESSAGE =
  'Los pesos de reputación, servicios completados y disponibilidad deben sumar 100.';
export const SAME_SETTINGS_MESSAGE =
  'La configuración ya tiene esos valores: no se creó una versión nueva.';
export const CONCURRENT_SETTINGS_MESSAGE =
  'Otro administrador cambió la configuración al mismo tiempo. Vuelve a intentarlo.';

const SETTINGS_FIELDS = [
  'reputationWeight',
  'completedServicesWeight',
  'availabilityWeight',
  'reviewsForConfidence',
  'completedServicesTarget',
  'availabilityHoursTarget',
] as const;

type SettingsValues = Pick<
  UpdateRecommendationSettingsDto,
  (typeof SETTINGS_FIELDS)[number]
>;

/**
 * Recomendacion de trabajadores para un pedido, por reputacion, servicios
 * completados y disponibilidad (ver recommendation-scoring.ts).
 *
 * Cada recomendacion se GUARDA con la version de criterios usada y los datos
 * de cada trabajador en ese momento: el cliente ve por que se recomendo a cada
 * uno y el historial no cambia aunque el administrador cambie los pesos. Los
 * criterios son versionados (una fila por version) y cada cambio queda en la
 * bitacora (RF-53). La BD respalda las reglas con CHECK y triggers de solo
 * insercion.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Genera y guarda una recomendacion para el pedido del cliente. 404 si el
   * pedido no existe o es de otro cliente; 409 si ya no esta publicado ni en
   * negociacion (con trabajador acordado, vencido, cancelado o cerrado).
   */
  async generate(
    clientId: string,
    orderId: string,
  ): Promise<RecommendationView> {
    const order = await this.orders.getOwn(clientId, orderId);
    if (!RECOMMENDABLE_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictException(NOT_RECOMMENDABLE_MESSAGE);
    }
    return this.prisma.$transaction(async (tx) => {
      const settings = await currentSettings(tx);
      const now = await dbNow(tx);
      const candidates = await this.workerProfiles.findRecommendationCandidates(
        tx,
        { categoryId: order.category.id, zoneId: order.zone.id },
        clientId,
      );
      const facts = await this.collectFacts(tx, candidates, now);
      const ranked = rankCandidates(facts, settings).slice(
        0,
        MAX_RECOMMENDED_WORKERS,
      );
      const openOffers = await this.openOffersByWorker(
        tx,
        order.id,
        ranked.map((candidate) => candidate.workerId),
      );
      const created = await tx.workerRecommendation.create({
        data: {
          orderId: order.id,
          requestedById: clientId,
          settingsId: settings.id,
          candidatesCount: candidates.length,
          items: {
            create: ranked.map((candidate) => ({
              workerId: candidate.workerId,
              rank: candidate.rank,
              totalScore: candidate.totalScore.toFixed(2),
              reviewsCount: candidate.reputation.reviewsCount,
              averageRating:
                candidate.reputation.averageRating?.toFixed(2) ?? null,
              adjustedRating: candidate.reputation.adjustedRating.toFixed(2),
              reputationScore: candidate.reputation.score.toFixed(2),
              completedServices: candidate.completedServices,
              completedServicesScore:
                candidate.completedServicesScore.toFixed(2),
              weeklyScheduleMinutes: candidate.weeklyScheduleMinutes,
              bookedMinutes: candidate.bookedMinutes,
              freeMinutes: candidate.availability.freeMinutes,
              availabilityScore: candidate.availability.score.toFixed(2),
              openOfferId: openOffers.get(candidate.workerId) ?? null,
            })),
          },
        },
        select: RECOMMENDATION_SELECT,
      });
      return toRecommendationView(created);
    });
  }

  /** Recomendaciones guardadas del pedido, de la mas reciente a la mas antigua. */
  async listForOrder(
    clientId: string,
    orderId: string,
  ): Promise<RecommendationView[]> {
    await this.orders.getOwn(clientId, orderId);
    const records = await this.prisma.workerRecommendation.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECOMMENDATION_HISTORY_LIMIT,
      select: RECOMMENDATION_SELECT,
    });
    return records.map(toRecommendationView);
  }

  /** Criterios vigentes y todas sus versiones. */
  async getSettings(): Promise<RecommendationSettingsOverview> {
    const versions = await this.prisma.recommendationSettings.findMany({
      orderBy: { version: 'desc' },
      select: SETTINGS_SELECT,
    });
    if (versions.length === 0) {
      throw missingSettings();
    }
    const history = versions.map(toSettingsView);
    return { current: history[0], history };
  }

  /**
   * Crea una version nueva de los criterios (las anteriores no se modifican) y
   * la registra en la bitacora en la misma transaccion. 400 si los pesos no
   * suman 100; 409 si los valores son iguales a los vigentes o si otro
   * administrador creo la misma version al mismo tiempo.
   */
  async updateSettings(
    adminId: string,
    dto: UpdateRecommendationSettingsDto,
  ): Promise<RecommendationSettingsOverview> {
    if (
      dto.reputationWeight +
        dto.completedServicesWeight +
        dto.availabilityWeight !==
      100
    ) {
      throw new BadRequestException(WEIGHTS_SUM_MESSAGE);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await currentSettings(tx);
        if (SETTINGS_FIELDS.every((field) => current[field] === dto[field])) {
          throw new ConflictException(SAME_SETTINGS_MESSAGE);
        }
        const values = pickSettings(dto);
        const created = await tx.recommendationSettings.create({
          data: {
            ...values,
            version: current.version + 1,
            createdById: adminId,
          },
          select: { id: true, version: true },
        });
        await this.audit.record(
          {
            actorId: adminId,
            action: AuditAction.EDICION,
            entityType: AuditEntityType.CONFIGURACION_RECOMENDACION,
            entityId: created.id,
            details: {
              version: created.version,
              previousVersion: current.version,
              before: pickSettings(current),
              after: values,
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException(CONCURRENT_SETTINGS_MESSAGE);
      }
      throw error;
    }
    return this.getSettings();
  }

  /**
   * Datos reales de cada candidato: calificaciones visibles de clientes,
   * trabajos terminados y minutos de trabajos acordados en los proximos 7 dias
   * (misma fuente que la agenda, RF-30).
   */
  private async collectFacts(
    tx: Db,
    candidates: readonly RecommendationCandidate[],
    now: Date,
  ): Promise<CandidateFacts[]> {
    if (candidates.length === 0) {
      return [];
    }
    const ids = candidates.map((candidate) => candidate.workerId);
    const [reviews, completed] = await Promise.all([
      tx.review.findMany({
        where: {
          targetId: { in: ids },
          authorRole: RoleName.CLIENTE,
          hiddenAt: null,
        },
        select: { targetId: true, rating: true },
      }),
      tx.order.groupBy({
        by: ['assignedWorkerId'],
        where: {
          assignedWorkerId: { in: ids },
          status: { in: [...COMPLETED_ORDER_STATUSES] },
          execution: { is: { finishedAt: { not: null } } },
        },
        _count: { _all: true },
      }),
    ]);
    const until = new Date(now.getTime() + AVAILABILITY_WINDOW_DAYS * DAY_MS);
    const facts: CandidateFacts[] = [];
    for (const candidate of candidates) {
      const orderIds = await this.orders.findActiveAssignedOrderIds(
        tx,
        candidate.workerId,
      );
      const jobs = await this.offers.findAcceptedJobSlots(
        tx,
        candidate.workerId,
        orderIds,
      );
      facts.push({
        workerId: candidate.workerId,
        ratings: reviews
          .filter((review) => review.targetId === candidate.workerId)
          .map((review) => review.rating),
        completedServices:
          completed.find((row) => row.assignedWorkerId === candidate.workerId)
            ?._count._all ?? 0,
        weeklyScheduleMinutes: candidate.weeklyScheduleMinutes,
        bookedMinutes: jobs.reduce(
          (total, job) =>
            total +
            minutesWithin(
              {
                startAt: job.proposedStartAt,
                durationMinutes: job.estimatedDurationMinutes,
              },
              now,
              until,
            ),
          0,
        ),
      });
    }
    return facts;
  }

  /** Oferta VIGENTE de cada trabajador en el pedido (a lo sumo una). */
  private async openOffersByWorker(
    tx: Db,
    orderId: string,
    workerIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (workerIds.length === 0) {
      return new Map();
    }
    const offers = await tx.offer.findMany({
      where: {
        orderId,
        status: OfferStatus.VIGENTE,
        workerId: { in: [...workerIds] },
      },
      select: { id: true, workerId: true },
    });
    return new Map(offers.map((offer) => [offer.workerId, offer.id]));
  }
}

/** Version vigente: la de numero mayor. La migracion crea la version 1. */
async function currentSettings(db: Db): Promise<SettingsRecord> {
  const settings = await db.recommendationSettings.findFirst({
    orderBy: { version: 'desc' },
    select: SETTINGS_SELECT,
  });
  if (!settings) {
    throw missingSettings();
  }
  return settings;
}

function pickSettings(values: SettingsValues): SettingsValues {
  return {
    reputationWeight: values.reputationWeight,
    completedServicesWeight: values.completedServicesWeight,
    availabilityWeight: values.availabilityWeight,
    reviewsForConfidence: values.reviewsForConfidence,
    completedServicesTarget: values.completedServicesTarget,
    availabilityHoursTarget: values.availabilityHoursTarget,
  };
}

function missingSettings(): Error {
  // Solo pasa si no se aplico la migracion: es un error de instalacion.
  return new Error(
    'Falta la configuración de recomendaciones: aplica las migraciones (npx prisma migrate deploy).',
  );
}
