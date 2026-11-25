import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  NotificationResourceType,
  NotificationType,
  RoleName,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersService, lockOrder } from '../orders/orders.service.js';
import { WorkflowQueryService } from '../service-workflow/workflow-query.service.js';
import { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import { CreateReviewDto } from './dto/create-review.dto.js';
import type { SearchWorkersQueryDto } from './dto/search-workers-query.dto.js';
import { resolveReviewTarget, summarizeRatings } from './review-rules.js';
import {
  type AdminReviewView,
  type MyReviewStatus,
  type Paginated,
  type PublicOpinionView,
  type PublicWorkerProfileView,
  type ReviewView,
  type WorkerSearchPage,
  authorLabel,
} from './review-views.js';
import { ReviewsConfig } from './reviews.config.js';

type Db = Prisma.TransactionClient;

const PRISMA_UNIQUE_VIOLATION = 'P2002';
const RECENT_OPINIONS = 5;
// RF-16: sin prometer disponibilidad (RNF-08).
export const NO_WORKERS_MESSAGE =
  'No encontramos trabajadores para esa categoría y zona. Puede publicar su pedido igualmente.';
const UNFINISHED_WORK_MESSAGE =
  'El trabajo se cerró sin terminarse (presupuesto adicional rechazado): no se puede calificar.';

const REVIEW_SELECT = {
  id: true,
  orderId: true,
  authorRole: true,
  rating: true,
  comment: true,
  createdAt: true,
  hiddenAt: true,
} satisfies Prisma.ReviewSelect;

type ReviewRecord = Prisma.ReviewGetPayload<{ select: typeof REVIEW_SELECT }>;

const toReviewView = (review: ReviewRecord): ReviewView => ({
  id: review.id,
  orderId: review.orderId,
  authorRole: review.authorRole,
  rating: review.rating,
  comment: review.comment,
  createdAt: review.createdAt,
  hidden: review.hiddenAt !== null,
});

/**
 * Calificaciones mutuas (RF-44 a RF-46). Reglas inmutables: solo el cliente y
 * el trabajador asignado califican, a la otra parte, una vez por pedido (la BD
 * lo respalda con un indice unico y un CHECK de autocalificacion). Que estados
 * del pedido habilitan calificar lo decide la politica configurable
 * (ReviewsConfig); aqui no se asume ninguno.
 *
 * Privacidad: las vistas publicas solo muestran puntaje, comentario, fecha y el
 * nombre con la inicial del apellido del autor, nunca ids, correo ni telefono.
 * Las opiniones ocultas por un administrador no se muestran ni cuentan.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly notifications: NotificationsService,
    private readonly config: ReviewsConfig,
    private readonly workflow: WorkflowQueryService,
  ) {}

  /** Califica a la otra parte del pedido (RF-44, RF-45). */
  async create(
    authorId: string,
    orderId: string,
    dto: CreateReviewDto,
  ): Promise<ReviewView> {
    const summary = await this.orders.findOrderSummary(this.prisma, orderId);
    if (!summary || !isParticipant(summary, authorId)) {
      throw orderNotFound();
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await lockOrder(tx, orderId);
        if (!order || !isParticipant(order, authorId)) {
          throw orderNotFound();
        }
        const alreadyReviewed =
          (await tx.review.count({ where: { orderId, authorId } })) > 0;
        const { targetId, authorRole } = resolveReviewTarget({
          authorId,
          order,
          alreadyReviewed,
          policy: this.config.policy,
        });
        // RF-45: un trabajo detenido por rechazar un adicional no se termino.
        if (await this.workflow.hasRejectedBudget(orderId, tx)) {
          throw new ConflictException(UNFINISHED_WORK_MESSAGE);
        }
        const review = await tx.review.create({
          data: {
            orderId,
            authorId,
            targetId,
            authorRole,
            rating: dto.rating,
            comment: dto.comment ?? null,
          },
          select: REVIEW_SELECT,
        });
        await this.notifications.create(
          targetId,
          {
            type: NotificationType.CALIFICACION_RECIBIDA,
            title: 'Nueva calificación',
            message:
              authorRole === 'CLIENTE'
                ? 'El cliente calificó tu trabajo.'
                : 'El trabajador te calificó.',
            resource: { type: NotificationResourceType.PEDIDO, id: orderId },
          },
          tx,
        );
        return toReviewView(review);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException('Ya calificó este pedido.');
      }
      throw error;
    }
  }

  /**
   * Si el usuario puede calificar este pedido y, si ya lo hizo, su
   * calificacion (CU-45 paso 5: "si no, muestra el motivo").
   */
  async getMine(userId: string, orderId: string): Promise<MyReviewStatus> {
    const order = await this.orders.findOrderSummary(this.prisma, orderId);
    if (!order || !isParticipant(order, userId)) {
      throw orderNotFound();
    }
    const review = await this.prisma.review.findUnique({
      where: { orderId_authorId: { orderId, authorId: userId } },
      select: REVIEW_SELECT,
    });
    let reason: string | null = null;
    if (!review) {
      if (order.assignedWorkerId === null) {
        reason = 'El pedido no tiene otra parte a la que calificar.';
      } else {
        reason =
          this.config.policy.denialReason(order) ??
          ((await this.workflow.hasRejectedBudget(orderId))
            ? UNFINISHED_WORK_MESSAGE
            : null);
      }
    }
    return {
      orderId,
      canReview: !review && reason === null,
      reason,
      alreadyReviewed: review !== null,
      review: review ? toReviewView(review) : null,
    };
  }

  /** Calificaciones que el usuario recibio (por ejemplo, el historial del cliente). */
  async listReceived(
    userId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<ReviewView>> {
    const where: Prisma.ReviewWhereInput = { targetId: userId, hiddenAt: null };
    const [reviews, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        select: REVIEW_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({ where }),
    ]);
    return paginated(reviews.map(toReviewView), page, limit, total);
  }

  // ---------------------------------------------------------------------
  // Perfil publico del trabajador (RF-46)
  // ---------------------------------------------------------------------

  /** Registros para los reportes (RF-52): calificaciones creadas en el rango. Sin datos personales. */
  async listForReport({
    start,
    end,
  }: {
    start: Date;
    end: Date;
  }): Promise<{ authorRole: RoleName; rating: number; hidden: boolean }[]> {
    const reviews = await this.prisma.review.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: { authorRole: true, rating: true, hiddenAt: true },
    });
    return reviews.map(({ hiddenAt, ...review }) => ({
      ...review,
      hidden: hiddenAt !== null,
    }));
  }

  /**
   * Busqueda de trabajadores por categoria y zona (RF-16): perfil publico,
   * horarios y promedio de las opiniones de clientes visibles.
   */
  async searchWorkers(
    clientId: string,
    { categoryId, zoneId, page, limit }: SearchWorkersQueryDto,
  ): Promise<WorkerSearchPage> {
    const { data, total } = await this.workerProfiles.searchApprovedWorkers(
      { categoryId, zoneId },
      clientId,
      { page, limit },
    );
    const reviews = await this.prisma.review.findMany({
      where: {
        targetId: { in: data.map((worker) => worker.workerId) },
        authorRole: RoleName.CLIENTE,
        hiddenAt: null,
      },
      select: { targetId: true, rating: true },
    });
    const results = data.map((worker) => ({
      ...worker,
      rating: summarizeRatings(
        reviews
          .filter((review) => review.targetId === worker.workerId)
          .map((review) => ({ rating: review.rating, hidden: false })),
      ),
    }));
    return {
      ...paginated(results, page, limit, total),
      message: total === 0 ? NO_WORKERS_MESSAGE : null,
    };
  }

  /** Perfil publico, promedio y opiniones recientes de un trabajador aprobado. */
  async getPublicProfile(workerId: string): Promise<PublicWorkerProfileView> {
    const profile = await this.workerProfiles.getPublicProfile(workerId);
    const [rating, recent] = await Promise.all([
      this.ratingSummary(this.prisma, workerId),
      this.listPublicOpinions(workerId, 1, RECENT_OPINIONS),
    ]);
    return {
      profile,
      rating: {
        ...rating,
        message:
          rating.count === 0
            ? 'Este trabajador aún no tiene calificaciones.'
            : null,
      },
      recentOpinions: recent.data,
    };
  }

  /** Opiniones visibles de los clientes sobre un trabajador aprobado, paginadas. */
  async listPublicOpinions(
    workerId: string,
    page: number,
    limit: number,
  ): Promise<Paginated<PublicOpinionView>> {
    // 404 si el trabajador no es publico (mismo criterio que el perfil).
    await this.workerProfiles.getPublicProfile(workerId);
    const where: Prisma.ReviewWhereInput = {
      targetId: workerId,
      authorRole: RoleName.CLIENTE,
      hiddenAt: null,
    };
    const [reviews, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          author: { select: { firstName: true, lastName: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({ where }),
    ]);
    return paginated(
      reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        author: authorLabel(review.author.firstName, review.author.lastName),
      })),
      page,
      limit,
      total,
    );
  }

  /** Promedio y cantidad de las opiniones de clientes visibles (sin ocultas). */
  private async ratingSummary(db: Db | PrismaService, workerId: string) {
    const rows = await db.review.findMany({
      where: { targetId: workerId, authorRole: RoleName.CLIENTE },
      select: { rating: true, hiddenAt: true },
    });
    return summarizeRatings(
      rows.map((row) => ({
        rating: row.rating,
        hidden: row.hiddenAt !== null,
      })),
    );
  }

  // ---------------------------------------------------------------------
  // Moderacion (RF-46 A1)
  // ---------------------------------------------------------------------

  async listForAdmin(
    page: number,
    limit: number,
  ): Promise<Paginated<AdminReviewView>> {
    const [reviews, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        select: {
          ...REVIEW_SELECT,
          authorId: true,
          targetId: true,
          hiddenById: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count(),
    ]);
    return paginated(
      reviews.map((review) => ({
        ...toReviewView(review),
        authorId: review.authorId,
        targetId: review.targetId,
        hiddenAt: review.hiddenAt,
        hiddenById: review.hiddenById,
      })),
      page,
      limit,
      total,
    );
  }

  /**
   * El administrador oculta una opinion que incumple las reglas: no se borra,
   * deja de mostrarse y el promedio se recalcula sin ella. Ocultar una ya
   * oculta es idempotente (conserva quien y cuando).
   */
  async hide(adminId: string, reviewId: string): Promise<AdminReviewView> {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, hiddenAt: true },
      });
      if (!review) {
        throw new NotFoundException('La calificación no existe');
      }
      if (review.hiddenAt === null) {
        await tx.review.update({
          where: { id: reviewId },
          data: { hiddenAt: new Date(), hiddenById: adminId },
        });
      }
      const updated = await tx.review.findUniqueOrThrow({
        where: { id: reviewId },
        select: {
          ...REVIEW_SELECT,
          authorId: true,
          targetId: true,
          hiddenById: true,
        },
      });
      return {
        ...toReviewView(updated),
        authorId: updated.authorId,
        targetId: updated.targetId,
        hiddenAt: updated.hiddenAt,
        hiddenById: updated.hiddenById,
      };
    });
  }
}

function isParticipant(
  order: { clientId: string; assignedWorkerId: string | null },
  userId: string,
): boolean {
  return (
    order.clientId === userId ||
    (order.assignedWorkerId !== null && order.assignedWorkerId === userId)
  );
}

function orderNotFound(): NotFoundException {
  return new NotFoundException('El pedido no existe');
}

function paginated<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
): Paginated<T> {
  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
