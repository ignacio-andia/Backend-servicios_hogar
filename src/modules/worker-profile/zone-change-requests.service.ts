import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  UserStatus,
  WorkerProfileStatus,
  ZoneChangeCancellationCause,
  ZoneChangeRequestStatus,
} from '../../generated/prisma/client.js';
import type { ZoneChangeRequest } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CatalogKind, CatalogsService } from '../catalogs/catalogs.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PublicUser, UsersService } from '../users/users.service.js';
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from './active-work.registry.js';
import { CreateZoneChangeRequestDto } from './dto/create-zone-change-request.dto.js';
import { DecideZoneChangeRequestDto } from './dto/decide-zone-change-request.dto.js';
import { ListZoneChangeRequestsQueryDto } from './dto/list-zone-change-requests-query.dto.js';
import {
  zoneRequestCancelledBySuspensionNotification,
  zoneRequestDecisionNotification,
  ZoneRequestNames,
  zoneRequestWithdrawnNotification,
} from './worker-profile.notifications.js';
import {
  ZONE_APPROVAL_BLOCKED_STATUSES,
  ZONE_CHANGE_POLICY,
  ZONE_REQUEST_ALLOWED_STATUSES,
} from './worker-profile.rules.js';
import {
  assertActiveAdmin,
  CatalogRef,
  isPrismaError,
  normalizeText,
  PRISMA_UNIQUE_VIOLATION,
  toRef,
} from './worker-profile.utils.js';

type Db = Prisma.TransactionClient;

export interface ZoneChangeRequestView {
  id: string;
  status: ZoneChangeRequestStatus;
  reason: string;
  fromZone: CatalogRef;
  toZone: CatalogRef;
  createdAt: Date;
  decidedAt: Date | null;
  decisionComment: string | null;
  /** Solo en CANCELADA: por que se cerro sin decision administrativa. */
  cancellationCause: ZoneChangeCancellationCause | null;
}

export type ZoneChangeBlockerCode =
  | 'PERFIL_EN_BORRADOR'
  | 'ESTADO_NO_PERMITIDO'
  | 'SOLICITUD_PENDIENTE'
  | 'TRABAJO_ACTIVO'
  | 'VERIFICACION_NO_DISPONIBLE';

export interface ZoneChangeBlocker {
  code: ZoneChangeBlockerCode;
  message: string;
}

/** Lo que el trabajador consulta antes de pedir un cambio. */
export interface ZoneStatusView {
  currentZone: CatalogRef;
  /** La zona actual fue desactivada (RF-49): conviene pedir otra. */
  zoneRequiresChange: boolean;
  pendingRequest: ZoneChangeRequestView | null;
  canRequestChange: boolean;
  blockers: ZoneChangeBlocker[];
}

export interface AdminZoneChangeRequestView extends ZoneChangeRequestView {
  worker: {
    userId: string;
    profileId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    accountStatus: UserStatus;
    profileStatus: WorkerProfileStatus;
    currentZone: CatalogRef;
  };
  decidedBy: { id: string; firstName: string; lastName: string } | null;
}

export interface PaginatedZoneChangeRequests {
  data: AdminZoneChangeRequestView[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

const OWN_PROFILE_SELECT = {
  id: true,
  userId: true,
  zoneId: true,
  status: true,
} satisfies Prisma.WorkerProfileSelect;

type OwnProfile = Prisma.WorkerProfileGetPayload<{
  select: typeof OWN_PROFILE_SELECT;
}>;

type RequestWithProfile = ZoneChangeRequest & { profile: OwnProfile };

const ACTIVE_WORK_LABELS: Record<ActiveWorkKind, string> = {
  PEDIDOS: 'pedidos',
  OFERTAS: 'ofertas',
};

/**
 * Solicitudes de cambio de zona (RF-13). La zona es fija: solo cambia cuando
 * un administrador aprueba una solicitud del trabajador. El historial de
 * solicitudes y decisiones nunca se borra (lo protege un trigger en la BD).
 */
@Injectable()
export class ZoneChangeRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly catalogs: CatalogsService,
    private readonly audit: AuditService,
    private readonly activeWork: WorkerActiveWorkRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Trabajador
  // ---------------------------------------------------------------------

  /** Zona actual, solicitud pendiente y si puede pedir un cambio (y por que no). */
  async getOwnZoneStatus(userId: string): Promise<ZoneStatusView> {
    const profile = await this.getOwnProfile(this.prisma, userId);
    const [zone, pending, blockers] = await Promise.all([
      this.catalogs.findById(CatalogKind.ZONE, profile.zoneId),
      this.prisma.zoneChangeRequest.findFirst({
        where: {
          profileId: profile.id,
          status: ZoneChangeRequestStatus.PENDIENTE,
        },
      }),
      this.findBlockers(profile, this.prisma),
    ]);
    return {
      currentZone: toRef(zone),
      zoneRequiresChange: !zone.isActive,
      pendingRequest: pending ? (await this.toViews([pending]))[0] : null,
      canRequestChange: blockers.length === 0,
      blockers,
    };
  }

  async requestZoneChange(
    userId: string,
    dto: CreateZoneChangeRequestDto,
  ): Promise<ZoneChangeRequestView> {
    const current = await this.getOwnProfile(this.prisma, userId);
    if (dto.toZoneId === current.zoneId) {
      throw sameZone();
    }
    await this.catalogs.assertActive(CatalogKind.ZONE, dto.toZoneId);

    try {
      const request = await this.prisma.$transaction(async (tx) => {
        // De a una operacion por trabajador: entre la verificacion y el
        // registro no puede aparecer otra solicitud ni trabajo nuevo.
        await this.activeWork.lockWorker(tx, userId);
        const profile = await this.getOwnProfile(tx, userId);
        if (dto.toZoneId === profile.zoneId) {
          throw sameZone();
        }
        const blockers = await this.findBlockers(profile, tx);
        if (blockers.length > 0) {
          throw new ConflictException(
            blockers.map((blocker) => blocker.message),
          );
        }
        // Se vuelve a validar la zona con un bloqueo compartido: no puede
        // desactivarse entre esta verificacion y el registro.
        await this.catalogs.assertActiveForShare(
          tx,
          CatalogKind.ZONE,
          dto.toZoneId,
        );
        return tx.zoneChangeRequest.create({
          data: {
            profileId: profile.id,
            fromZoneId: profile.zoneId,
            toZoneId: dto.toZoneId,
            reason: dto.reason,
          },
        });
      });
      return (await this.toViews([request]))[0];
    } catch (error) {
      // El indice unico parcial resuelve solicitudes simultaneas.
      if (isPrismaError(error, PRISMA_UNIQUE_VIOLATION)) {
        throw new ConflictException(pendingRequestMessage());
      }
      throw error;
    }
  }

  /**
   * Retiro voluntario (T4.3): el trabajador cancela su propia solicitud
   * PENDIENTE. Queda CANCELADA con la causa RETIRO_TRABAJADOR; decidedBy y
   * decidedAt registran que el trabajador la retiro y cuando. La zona no
   * cambia y el registro no se borra. Una solicitud ajena responde 404, sin
   * revelar si existe. Avisa al trabajador en la misma transaccion.
   *
   * Es una accion del trabajador: igual que el envio de su perfil (T3.1), no
   * va a la bitacora administrativa; su constancia es la propia solicitud.
   */
  async withdraw(
    userId: string,
    requestId: string,
  ): Promise<ZoneChangeRequestView> {
    const withdrawn = await this.prisma.$transaction(async (tx) => {
      // Misma fila que bloquean la decision administrativa y la suspension:
      // el retiro y una decision simultanea se ejecutan de a una.
      await this.activeWork.lockWorker(tx, userId);
      const request = await tx.zoneChangeRequest.findFirst({
        where: { id: requestId, profile: { userId } },
      });
      if (!request) {
        throw new NotFoundException('La solicitud de cambio de zona no existe');
      }
      if (request.status !== ZoneChangeRequestStatus.PENDIENTE) {
        throw alreadyResolved();
      }
      const { count } = await tx.zoneChangeRequest.updateMany({
        where: { id: requestId, status: ZoneChangeRequestStatus.PENDIENTE },
        data: {
          status: ZoneChangeRequestStatus.CANCELADA,
          cancellationCause: ZoneChangeCancellationCause.RETIRO_TRABAJADOR,
          decidedAt: new Date(),
          decidedById: userId,
        },
      });
      if (count === 0) {
        throw alreadyResolved();
      }
      await this.notifications.create(
        userId,
        zoneRequestWithdrawnNotification(
          requestId,
          await this.zoneNames(request),
        ),
        tx,
      );
      return tx.zoneChangeRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
    });
    return (await this.toViews([withdrawn]))[0];
  }

  async listOwn(userId: string): Promise<ZoneChangeRequestView[]> {
    const profile = await this.getOwnProfile(this.prisma, userId);
    const requests = await this.prisma.zoneChangeRequest.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'desc' },
    });
    return this.toViews(requests);
  }

  // ---------------------------------------------------------------------
  // Administrador (la autorizacion HTTP la hace @Auth en el controller)
  // ---------------------------------------------------------------------

  async listForAdmin(
    query: ListZoneChangeRequestsQueryDto,
  ): Promise<PaginatedZoneChangeRequests> {
    const { page, limit } = query;
    const where = buildAdminWhere(query);
    const [requests, total] = await this.prisma.$transaction([
      this.prisma.zoneChangeRequest.findMany({
        where,
        include: { profile: { select: OWN_PROFILE_SELECT } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.zoneChangeRequest.count({ where }),
    ]);
    return {
      data: await this.toAdminViews(requests),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getForAdmin(requestId: string): Promise<AdminZoneChangeRequestView> {
    return (await this.toAdminViews([await this.findRequest(requestId)]))[0];
  }

  /**
   * Aprueba o rechaza una solicitud PENDIENTE. Al aprobar, la nueva zona
   * reemplaza a la anterior; al rechazar, el perfil conserva su zona. La
   * decision, el cambio de zona, la bitacora y la notificacion al trabajador
   * van en una sola transaccion: si algo falla, no queda nada a medias.
   */
  async decide(
    adminId: string,
    requestId: string,
    { decision, comment }: DecideZoneChangeRequestDto,
  ): Promise<AdminZoneChangeRequestView> {
    await assertActiveAdmin(this.users, adminId);
    const request = await this.findRequest(requestId);
    if (request.profile.userId === adminId) {
      throw new ForbiddenException(
        'No puede resolver su propia solicitud de cambio de zona',
      );
    }
    if (request.status !== ZoneChangeRequestStatus.PENDIENTE) {
      throw alreadyResolved();
    }
    const cleanComment = normalizeText(comment);
    const approved = decision === ZoneChangeRequestStatus.APROBADA;
    if (
      !approved &&
      ZONE_CHANGE_POLICY.rejectionCommentRequired &&
      !cleanComment
    ) {
      throw new BadRequestException('Debe indicar el motivo del rechazo');
    }
    const names = await this.zoneNames(request);

    await this.prisma.$transaction(async (tx) => {
      // Misma fila bloqueada que al solicitar, al suspender el perfil (su
      // UPDATE espera) y en pedidos y ofertas: la decision no se cruza con
      // esas operaciones. El estado del perfil se relee con el bloqueo.
      await this.activeWork.lockWorker(tx, request.profile.userId);
      if (approved) {
        const profile = await tx.workerProfile.findUniqueOrThrow({
          where: { id: request.profileId },
          select: OWN_PROFILE_SELECT,
        });
        if (ZONE_APPROVAL_BLOCKED_STATUSES.includes(profile.status)) {
          throw new ConflictException(
            `No se puede aprobar: el perfil del trabajador está en estado ${profile.status}`,
          );
        }
        // Ultimo eslabon del orden de bloqueos: la zona (FOR SHARE).
        await this.assertTargetZoneActive(tx, request.toZoneId);
        if (profile.zoneId !== request.fromZoneId) {
          throw zoneChangedMeanwhile();
        }
        if (ZONE_CHANGE_POLICY.recheckActiveWorkOnApproval) {
          await this.assertNoActiveWorkForApproval(tx, request.profile.userId);
        }
      }
      // Solo una decision gana: la otra encuentra la solicitud ya resuelta.
      const { count } = await tx.zoneChangeRequest.updateMany({
        where: { id: requestId, status: ZoneChangeRequestStatus.PENDIENTE },
        data: {
          status: decision,
          decidedAt: new Date(),
          decidedById: adminId,
          decisionComment: cleanComment,
        },
      });
      if (count === 0) {
        throw alreadyResolved();
      }
      if (approved) {
        await this.applyApprovedChange(tx, request);
      }
      await this.audit.record(
        {
          actorId: adminId,
          action: approved ? AuditAction.APROBACION : AuditAction.RECHAZO,
          entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
          entityId: requestId,
          details: {
            profileId: request.profileId,
            workerUserId: request.profile.userId,
            fromZoneId: request.fromZoneId,
            toZoneId: request.toZoneId,
            fromStatus: ZoneChangeRequestStatus.PENDIENTE,
            toStatus: decision,
            comment: cleanComment,
          },
        },
        tx,
      );
      await this.notifications.create(
        request.profile.userId,
        zoneRequestDecisionNotification(
          requestId,
          decision,
          names,
          cleanComment,
        ),
        tx,
      );
    });
    return this.getForAdmin(requestId);
  }

  /**
   * Al suspender un perfil (WorkerProfileService.changeStatusByAdmin), cancela
   * su solicitud pendiente dentro de la MISMA transaccion. No es un rechazo:
   * queda CANCELADA con la causa SUSPENSION_PERFIL, y decidedBy y decidedAt
   * registran que administrador la provoco y cuando. La zona no cambia. Deja
   * constancia en la bitacora y avisa al trabajador. Devuelve si cancelo algo.
   *
   * El llamador ya tiene bloqueada la fila del perfil (su UPDATE de estado),
   * asi que una decision simultanea espera y luego la encuentra resuelta.
   */
  async cancelPendingOnSuspension(
    tx: Db,
    adminId: string,
    profile: { id: string; userId: string },
  ): Promise<boolean> {
    const pending = await tx.zoneChangeRequest.findFirst({
      where: {
        profileId: profile.id,
        status: ZoneChangeRequestStatus.PENDIENTE,
      },
    });
    if (!pending) {
      return false;
    }
    const { count } = await tx.zoneChangeRequest.updateMany({
      where: { id: pending.id, status: ZoneChangeRequestStatus.PENDIENTE },
      data: {
        status: ZoneChangeRequestStatus.CANCELADA,
        cancellationCause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
        decidedAt: new Date(),
        decidedById: adminId,
      },
    });
    if (count === 0) {
      return false;
    }
    await this.audit.record(
      {
        actorId: adminId,
        action: AuditAction.CAMBIO_ESTADO,
        entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
        entityId: pending.id,
        details: {
          profileId: profile.id,
          workerUserId: profile.userId,
          fromZoneId: pending.fromZoneId,
          toZoneId: pending.toZoneId,
          fromStatus: ZoneChangeRequestStatus.PENDIENTE,
          toStatus: ZoneChangeRequestStatus.CANCELADA,
          cause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
        },
      },
      tx,
    );
    await this.notifications.create(
      profile.userId,
      zoneRequestCancelledBySuspensionNotification(
        pending.id,
        await this.zoneNames(pending),
      ),
      tx,
    );
    return true;
  }

  // ---------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------

  /**
   * Efecto de aprobar: la nueva zona reemplaza a la anterior. Si el docente
   * confirma que el perfil debe volver a revision (decision B), se agrega aqui.
   */
  private async applyApprovedChange(
    tx: Db,
    request: RequestWithProfile,
  ): Promise<void> {
    const { count } = await tx.workerProfile.updateMany({
      where: { id: request.profileId, zoneId: request.fromZoneId },
      data: { zoneId: request.toZoneId },
    });
    if (count === 0) {
      throw zoneChangedMeanwhile();
    }
  }

  /**
   * La zona destino debe seguir activa; si no, se informa que corresponde
   * rechazar. Se lee con FOR SHARE dentro de la transaccion de la decision:
   * una desactivacion simultanea espera a que termine.
   */
  private async assertTargetZoneActive(tx: Db, zoneId: string): Promise<void> {
    const [zone] = await this.catalogs.findByIdsForShare(tx, CatalogKind.ZONE, [
      zoneId,
    ]);
    if (!zone?.isActive) {
      throw new ConflictException(
        `No se puede aprobar: la zona solicitada "${zone?.name ?? zoneId}" fue desactivada. Rechace la solicitud para que el trabajador pueda pedir otra zona.`,
      );
    }
  }

  /**
   * Segunda verificacion de pedidos y ofertas al aprobar. Solo se ejecuta si
   * ZONE_CHANGE_POLICY.recheckActiveWorkOnApproval esta activada (pendiente
   * del docente). Sin las consultas registradas no aprueba: no simula datos.
   */
  private async assertNoActiveWorkForApproval(
    tx: Db,
    workerUserId: string,
  ): Promise<void> {
    const activeWork = await this.activeWork.check(
      workerUserId,
      ZONE_CHANGE_POLICY.activeWorkSources,
      tx,
    );
    if (!activeWork.verifiable) {
      throw new ConflictException(
        `No se puede aprobar: no es posible verificar si el trabajador tiene ${describeMissing(activeWork.missingSources)} activos.`,
      );
    }
    const active = describeActive(activeWork.counts);
    if (active) {
      throw new ConflictException(
        `No se puede aprobar: el trabajador tiene trabajo activo (${active} activos).`,
      );
    }
  }

  /** Motivos por los que hoy no puede pedir un cambio (vacio: puede). */
  private async findBlockers(
    profile: OwnProfile,
    db: Db,
  ): Promise<ZoneChangeBlocker[]> {
    const blockers: ZoneChangeBlocker[] = [];
    if (profile.status === WorkerProfileStatus.BORRADOR) {
      blockers.push({
        code: 'PERFIL_EN_BORRADOR',
        message:
          'Su perfil aún no fue enviado a revisión: puede elegir la zona directamente al editar el perfil.',
      });
    } else if (!ZONE_REQUEST_ALLOWED_STATUSES.includes(profile.status)) {
      blockers.push({
        code: 'ESTADO_NO_PERMITIDO',
        message: `No se puede solicitar un cambio de zona con el perfil en estado ${profile.status}`,
      });
    }
    const [pending, activeWork] = await Promise.all([
      db.zoneChangeRequest.count({
        where: {
          profileId: profile.id,
          status: ZoneChangeRequestStatus.PENDIENTE,
        },
      }),
      this.activeWork.check(
        profile.userId,
        ZONE_CHANGE_POLICY.activeWorkSources,
        db,
      ),
    ]);
    if (pending > 0) {
      blockers.push({
        code: 'SOLICITUD_PENDIENTE',
        message: pendingRequestMessage(),
      });
    }
    if (!activeWork.verifiable) {
      // Sin la consulta de pedidos u ofertas no se acepta la solicitud.
      blockers.push({
        code: 'VERIFICACION_NO_DISPONIBLE',
        message: `Por ahora no se puede verificar si tiene ${describeMissing(activeWork.missingSources)} activos, así que la solicitud de cambio de zona todavía no está disponible.`,
      });
    } else {
      const active = describeActive(activeWork.counts);
      if (active) {
        blockers.push({
          code: 'TRABAJO_ACTIVO',
          message: `No puede solicitar un cambio de zona mientras tenga trabajo activo (${active} activos).`,
        });
      }
    }
    return blockers;
  }

  private async getOwnProfile(db: Db, userId: string): Promise<OwnProfile> {
    const profile = await db.workerProfile.findUnique({
      where: { userId },
      select: OWN_PROFILE_SELECT,
    });
    if (!profile) {
      throw new NotFoundException('Aún no tiene un perfil de trabajador');
    }
    return profile;
  }

  private async findRequest(requestId: string): Promise<RequestWithProfile> {
    const request = await this.prisma.zoneChangeRequest.findUnique({
      where: { id: requestId },
      include: { profile: { select: OWN_PROFILE_SELECT } },
    });
    if (!request) {
      throw new NotFoundException('La solicitud de cambio de zona no existe');
    }
    return request;
  }

  private async toViews(
    requests: ZoneChangeRequest[],
  ): Promise<ZoneChangeRequestView[]> {
    const zones = await this.zoneRefs(
      requests.flatMap((r) => [r.fromZoneId, r.toZoneId]),
    );
    return requests.map((request) => toView(request, zones));
  }

  private async toAdminViews(
    requests: RequestWithProfile[],
  ): Promise<AdminZoneChangeRequestView[]> {
    const userIds = [
      ...new Set(
        requests.flatMap((r) =>
          r.decidedById
            ? [r.profile.userId, r.decidedById]
            : [r.profile.userId],
        ),
      ),
    ];
    const [zones, accounts] = await Promise.all([
      this.zoneRefs(
        requests.flatMap((r) => [r.fromZoneId, r.toZoneId, r.profile.zoneId]),
      ),
      Promise.all(userIds.map((id) => this.users.findById(id))),
    ]);
    const usersById = new Map<string, PublicUser>(
      accounts.map((account) => [account.id, account]),
    );
    return requests.map((request) => {
      const worker = usersById.get(request.profile.userId)!;
      const decider = request.decidedById
        ? usersById.get(request.decidedById)!
        : null;
      return {
        ...toView(request, zones),
        worker: {
          userId: worker.id,
          profileId: request.profile.id,
          firstName: worker.firstName,
          lastName: worker.lastName,
          email: worker.email,
          phone: worker.phone,
          accountStatus: worker.status,
          profileStatus: request.profile.status,
          currentZone: zones.get(request.profile.zoneId)!,
        },
        decidedBy: decider
          ? {
              id: decider.id,
              firstName: decider.firstName,
              lastName: decider.lastName,
            }
          : null,
      };
    });
  }

  /** Nombres de las zonas de una solicitud, para el texto de las notificaciones. */
  private async zoneNames(
    request: Pick<ZoneChangeRequest, 'fromZoneId' | 'toZoneId'>,
  ): Promise<ZoneRequestNames> {
    const zones = await this.zoneRefs([request.fromZoneId, request.toZoneId]);
    return {
      fromZone: zones.get(request.fromZoneId)?.name ?? '',
      toZone: zones.get(request.toZoneId)?.name ?? '',
    };
  }

  private async zoneRefs(ids: string[]): Promise<Map<string, CatalogRef>> {
    const zones = await this.catalogs.findByIds(CatalogKind.ZONE, ids);
    return new Map(zones.map((zone) => [zone.id, toRef(zone)]));
  }
}

function toView(
  request: ZoneChangeRequest,
  zones: Map<string, CatalogRef>,
): ZoneChangeRequestView {
  return {
    id: request.id,
    status: request.status,
    reason: request.reason,
    fromZone: zones.get(request.fromZoneId)!,
    toZone: zones.get(request.toZoneId)!,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    decisionComment: request.decisionComment,
    cancellationCause: request.cancellationCause,
  };
}

function buildAdminWhere({
  status,
  resolved,
  workerUserId,
}: ListZoneChangeRequestsQueryDto): Prisma.ZoneChangeRequestWhereInput {
  const conditions: Prisma.ZoneChangeRequestWhereInput[] = [];
  if (status) {
    conditions.push({ status });
  }
  if (resolved !== undefined) {
    conditions.push(
      resolved
        ? { status: { not: ZoneChangeRequestStatus.PENDIENTE } }
        : { status: ZoneChangeRequestStatus.PENDIENTE },
    );
  }
  if (workerUserId) {
    conditions.push({ profile: { userId: workerUserId } });
  }
  return { AND: conditions };
}

function describeMissing(missing: readonly ActiveWorkKind[]): string {
  return missing.map((kind) => ACTIVE_WORK_LABELS[kind]).join(' u ');
}

/** "1 pedidos y 2 ofertas", o cadena vacia si no hay trabajo activo. */
function describeActive(counts: Record<ActiveWorkKind, number>): string {
  return ZONE_CHANGE_POLICY.activeWorkSources
    .filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${ACTIVE_WORK_LABELS[kind]}`)
    .join(' y ');
}

function sameZone(): BadRequestException {
  return new BadRequestException('La zona solicitada es su zona actual');
}

function pendingRequestMessage(): string {
  return 'Ya tiene una solicitud de cambio de zona pendiente';
}

function alreadyResolved(): ConflictException {
  return new ConflictException('La solicitud ya fue resuelta');
}

function zoneChangedMeanwhile(): ConflictException {
  return new ConflictException(
    'La zona del perfil cambió desde que se creó la solicitud',
  );
}
