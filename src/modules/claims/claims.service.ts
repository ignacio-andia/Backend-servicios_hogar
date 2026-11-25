import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ClaimStatus,
  OrderStatus,
  Prisma,
  RoleName,
  AuditAction,
  AuditEntityType,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UploadedImageFile } from '../orders/images/order-image.processor.js';
import { clientActor } from '../orders/order-history.js';
import {
  lockOrder,
  orderNotFound,
  OrdersService,
} from '../orders/orders.service.js';
import type { PublicUser } from '../users/users.service.js';
import {
  WorkflowEvent,
  WorkflowEventRegistry,
} from '../service-workflow/workflow-events.registry.js';
import { WorkflowQueryService } from '../service-workflow/workflow-query.service.js';
import { adminActor, dbClock } from '../service-workflow/workflow-support.js';
import { isWithinConformityWindow } from '../service-workflow/workflow.rules.js';
import {
  ClaimImageDownload,
  ClaimImagesService,
  type StoredClaimImage,
} from './claim-images.service.js';
import {
  ClaimPartyView,
  ClaimSummary,
  ClaimView,
  PaginatedClaims,
} from './claim-views.js';
import { ClaimsConfig } from './claims.config.js';
import {
  CreateClaimDto,
  DecideClaimDto,
  ListClaimsQueryDto,
} from './dto/claim.dto.js';

type Db = Prisma.TransactionClient;

const PRISMA_UNIQUE_VIOLATION = 'P2002';

const CLAIM_INCLUDE = {
  images: { orderBy: { position: 'asc' } },
} satisfies Prisma.ClaimInclude;
type ClaimWithImages = Prisma.ClaimGetPayload<{
  include: typeof CLAIM_INCLUDE;
}>;

/**
 * Reclamos (RF-37, RF-38). Un reclamo por pedido.
 *
 * Concurrencia con la conformidad y el cierre por plazo (RN-10): presentar el
 * reclamo bloquea el pedido (FOR UPDATE) y, DENTRO del bloqueo, exige que siga
 * TERMINADO y que ahora (reloj de la BD) sea anterior al limite
 * conformityDeadline. El cierre por plazo y la conformidad toman el mismo
 * bloqueo: solo uno gana y el otro responde 409 sin efectos.
 *
 * Las fotos son evidencia: se procesan antes de la transaccion y, si el reclamo
 * no se confirma, se descartan; una vez confirmado el reclamo no se borran.
 * PENDIENTE DE CONFIRMAR CON EL DOCENTE: minimo/maximo de fotos (ver ClaimsConfig)
 * y los resultados posibles de la decision (aqui es texto libre sin efectos).
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly workflow: WorkflowQueryService,
    private readonly events: WorkflowEventRegistry,
    private readonly images: ClaimImagesService,
    private readonly settings: ClaimsConfig,
    private readonly audit: AuditService,
  ) {}

  /**
   * RF-53: decision administrativa sobre un reclamo, en la bitacora y dentro de
   * su transaccion. Solo estados e identificadores: ni la descripcion del
   * reclamo ni el texto de la decision (quedan en el propio reclamo).
   */
  private recordClaimDecision(
    tx: Db,
    adminId: string,
    claim: { id: string; orderId: string },
    fromStatus: ClaimStatus,
    toStatus: ClaimStatus,
  ): Promise<void> {
    return this.audit.record(
      {
        actorId: adminId,
        action: AuditAction.CAMBIO_ESTADO,
        entityType: AuditEntityType.RECLAMO,
        entityId: claim.id,
        details: { orderId: claim.orderId, fromStatus, toStatus },
      },
      tx,
    );
  }

  // ---------------------------------------------------------------------
  // RF-37: presentar el reclamo
  // ---------------------------------------------------------------------

  async create(
    clientId: string,
    orderId: string,
    dto: CreateClaimDto,
    files: UploadedImageFile[],
  ): Promise<ClaimView> {
    const { minImages, maxImages } = this.settings;
    if (files.length < minImages || files.length > maxImages) {
      throw new BadRequestException(
        minImages === 0
          ? `Puede adjuntar hasta ${maxImages} fotografía(s) en el campo "images"`
          : `Debe adjuntar entre ${minImages} y ${maxImages} fotografías en el campo "images"`,
      );
    }
    // Rechazo rapido antes de procesar fotos (la decision real se toma abajo,
    // con el pedido bloqueado).
    const participation = await this.orders.findParticipation(
      this.prisma,
      clientId,
      orderId,
    );
    if (!participation || participation.role !== 'CLIENTE') {
      throw orderNotFound();
    }
    if (participation.status !== OrderStatus.TERMINADO) {
      throw this.notClaimable(participation.status);
    }

    const stored = await this.images.processAndStore(files);
    const events: WorkflowEvent[] = [];
    let claimId: string;
    try {
      claimId = await this.prisma.$transaction(async (tx) => {
        const order = await lockOrder(tx, orderId, clientId);
        if (!order) {
          throw orderNotFound();
        }
        if (order.status !== OrderStatus.TERMINADO) {
          throw this.notClaimable(order.status);
        }
        const deadline = await this.workflow.getConformityDeadline(orderId, tx);
        if (!deadline) {
          throw new ConflictException('El trabajo todavía no fue terminado.');
        }
        if (!isWithinConformityWindow(await dbClock(tx), deadline)) {
          throw new ConflictException(
            'El plazo de 7 días para presentar un reclamo ya venció.',
          );
        }
        const claim = await tx.claim.create({
          data: {
            orderId,
            clientId,
            description: dto.description,
            images: {
              create: stored.map((image, index) =>
                toImageData(image, index + 1),
              ),
            },
          },
        });
        await this.orders.transition(tx, {
          orderId,
          from: OrderStatus.TERMINADO,
          to: OrderStatus.EN_RECLAMO,
          actor: clientActor(clientId),
          reason: 'Reclamo presentado',
        });
        events.push({ type: 'RECLAMO_PRESENTADO', orderId, claimId: claim.id });
        await this.events.runInTransaction(events, tx);
        return claim.id;
      });
    } catch (error) {
      // Nada se confirmo: las fotos guardadas no pertenecen a ningun reclamo.
      await this.images.discard(stored);
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException('El pedido ya tiene un reclamo.');
      }
      throw error;
    }
    await this.events.runAfterCommit(events);
    return this.getForClient(clientId, claimId);
  }

  // ---------------------------------------------------------------------
  // Consultas de las partes
  // ---------------------------------------------------------------------

  /** Reclamo propio del cliente, con el id de reclamo. 404 si no es suyo. */
  async getForClient(clientId: string, claimId: string): Promise<ClaimView> {
    const claim = await this.prisma.claim.findFirst({
      where: { id: claimId, clientId },
      include: CLAIM_INCLUDE,
    });
    if (!claim) {
      throw new NotFoundException('El reclamo no existe');
    }
    return toClaimView(claim);
  }

  /**
   * Reclamo de un pedido para sus partes: el cliente ve el reclamo completo;
   * el trabajador asignado, solo el estado y la decision comunicada.
   */
  async getByOrderFor(
    userId: string,
    orderId: string,
  ): Promise<ClaimView | ClaimPartyView> {
    const participation = await this.orders.findParticipation(
      this.prisma,
      userId,
      orderId,
    );
    const claim = participation
      ? await this.prisma.claim.findUnique({
          where: { orderId },
          include: CLAIM_INCLUDE,
        })
      : null;
    if (!participation || !claim) {
      throw new NotFoundException('El pedido no tiene un reclamo');
    }
    return participation.role === 'CLIENTE'
      ? toClaimView(claim)
      : toPartyView(claim);
  }

  /** Foto del reclamo: solo el cliente que lo presento o un administrador. */
  async openImage(
    user: PublicUser,
    claimId: string,
    imageId: string,
    variant: 'full' | 'thumb',
  ): Promise<ClaimImageDownload> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { clientId: true },
    });
    const isAdmin = user.roles.includes(RoleName.ADMINISTRADOR);
    if (!claim || (!isAdmin && claim.clientId !== user.id)) {
      throw new NotFoundException('La fotografía no existe');
    }
    return this.images.open(claimId, imageId, variant);
  }

  // ---------------------------------------------------------------------
  // RF-38: administrador
  // ---------------------------------------------------------------------

  async listForAdmin({
    status,
    page,
    limit,
  }: ListClaimsQueryDto): Promise<PaginatedClaims> {
    const where: Prisma.ClaimWhereInput = status ? { status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.claim.findMany({
        where,
        select: {
          id: true,
          orderId: true,
          status: true,
          createdAt: true,
          _count: { select: { images: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claim.count({ where }),
    ]);
    const data: ClaimSummary[] = rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      status: row.status,
      imageCount: row._count.images,
      createdAt: row.createdAt,
    }));
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Registros para los reportes (RF-52): reclamos presentados en el rango, con su estado actual. Sin datos personales. */
  async listForReport({
    start,
    end,
  }: {
    start: Date;
    end: Date;
  }): Promise<{ categoryId: string; zoneId: string; status: ClaimStatus }[]> {
    const claims = await this.prisma.claim.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: {
        status: true,
        order: { select: { categoryId: true, zoneId: true } },
      },
    });
    return claims.map(({ status, order }) => ({ ...order, status }));
  }

  /**
   * Detalle para el administrador: reclamo y fotos. El historial del pedido
   * lo da el detalle administrativo del pedido (GET /orders/admin/:id); las
   * constancias de pago las expone PaymentsModule (RF-38 criterio 1).
   */
  async getForAdmin(claimId: string): Promise<ClaimView> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: CLAIM_INCLUDE,
    });
    if (!claim) {
      throw new NotFoundException('El reclamo no existe');
    }
    return toClaimView(claim);
  }

  /** ABIERTO -> EN_REVISION (CU-38 A1: se requiere mas evidencia). */
  async markInReview(adminId: string, claimId: string): Promise<ClaimView> {
    const events: WorkflowEvent[] = [];
    await this.withLockedClaim(claimId, async (tx, claim, orderId) => {
      if (claim.status !== ClaimStatus.ABIERTO) {
        throw new ConflictException(
          `El reclamo no se puede poner en revisión desde ${claim.status}.`,
        );
      }
      await tx.claim.update({
        where: { id: claimId },
        data: { status: ClaimStatus.EN_REVISION },
      });
      await this.recordClaimDecision(
        tx,
        adminId,
        { id: claimId, orderId },
        claim.status,
        ClaimStatus.EN_REVISION,
      );
      events.push({ type: 'RECLAMO_EN_REVISION', orderId, claimId });
      await this.events.runInTransaction(events, tx);
    });
    await this.events.runAfterCommit(events);
    return this.getForAdmin(claimId);
  }

  /**
   * Registra la decision y su justificacion (RF-38): el reclamo queda
   * RESUELTO y el pedido pasa a CERRADO. Es solo un registro: no aplica
   * sanciones, suspensiones ni efectos economicos (RF-47 y dinero quedan
   * fuera). Decidir dos veces responde 409.
   */
  async decide(
    adminId: string,
    claimId: string,
    dto: DecideClaimDto,
  ): Promise<ClaimView> {
    const events: WorkflowEvent[] = [];
    await this.withLockedClaim(claimId, async (tx, claim, orderId) => {
      if (claim.status === ClaimStatus.RESUELTO) {
        throw new ConflictException('El reclamo ya fue resuelto.');
      }
      await tx.claim.update({
        where: { id: claimId },
        data: {
          status: ClaimStatus.RESUELTO,
          decision: dto.decision,
          justification: dto.justification,
          decidedById: adminId,
          decidedAt: await dbClock(tx),
        },
      });
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.EN_RECLAMO,
        to: OrderStatus.CERRADO,
        actor: adminActor(adminId),
        reason: 'Reclamo resuelto por el administrador',
      });
      await this.recordClaimDecision(
        tx,
        adminId,
        { id: claimId, orderId },
        claim.status,
        ClaimStatus.RESUELTO,
      );
      events.push({
        type: 'RECLAMO_RESUELTO',
        orderId,
        claimId,
        closedFrom: OrderStatus.EN_RECLAMO,
      });
      await this.events.runInTransaction(events, tx);
    });
    await this.events.runAfterCommit(events);
    return this.getForAdmin(claimId);
  }

  // ---------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------

  /** Bloquea el pedido del reclamo (EN_RECLAMO) y relee el reclamo ya bloqueado. */
  private async withLockedClaim(
    claimId: string,
    work: (
      tx: Db,
      claim: { status: ClaimStatus },
      orderId: string,
    ) => Promise<void>,
  ): Promise<void> {
    const located = await this.prisma.claim.findUnique({
      where: { id: claimId },
      select: { orderId: true },
    });
    if (!located) {
      throw new NotFoundException('El reclamo no existe');
    }
    await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, located.orderId);
      if (!order) {
        throw orderNotFound();
      }
      if (order.status !== OrderStatus.EN_RECLAMO) {
        throw new ConflictException(
          `El pedido ya no está en reclamo (estado ${order.status}).`,
        );
      }
      const claim = await tx.claim.findUniqueOrThrow({
        where: { id: claimId },
        select: { status: true },
      });
      await work(tx, claim, located.orderId);
    });
  }

  private notClaimable(status: OrderStatus): ConflictException {
    if (status === OrderStatus.EN_RECLAMO) {
      return new ConflictException('El pedido ya tiene un reclamo.');
    }
    return new ConflictException(
      `Solo se puede reclamar un trabajo terminado dentro del plazo (el pedido está ${status}).`,
    );
  }
}

function toImageData(image: StoredClaimImage, position: number) {
  return { position, ...image };
}

function toClaimView(claim: ClaimWithImages): ClaimView {
  return {
    id: claim.id,
    orderId: claim.orderId,
    status: claim.status,
    description: claim.description,
    images: claim.images.map((image) => ({
      id: image.id,
      position: image.position,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      sizeBytes: image.sizeBytes,
    })),
    decision: claim.decision,
    justification: claim.justification,
    decidedAt: claim.decidedAt,
    createdAt: claim.createdAt,
  };
}

function toPartyView(claim: ClaimWithImages): ClaimPartyView {
  const resolved = claim.status === ClaimStatus.RESUELTO;
  return {
    id: claim.id,
    orderId: claim.orderId,
    status: claim.status,
    decision: resolved ? claim.decision : null,
    justification: resolved ? claim.justification : null,
    decidedAt: resolved ? claim.decidedAt : null,
  };
}
