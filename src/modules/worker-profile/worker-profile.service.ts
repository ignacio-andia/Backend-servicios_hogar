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
  RoleName,
  UserStatus,
  WorkerProfileStatus,
  ZoneChangeRequestStatus,
} from '../../generated/prisma/client.js';
import type {
  WeekDay,
  ZoneChangeRequest,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from '../catalogs/catalogs.service.js';
import { PublicUser, UsersService } from '../users/users.service.js';
import { CreateWorkerProfileDto } from './dto/create-worker-profile.dto.js';
import { CreateZoneChangeRequestDto } from './dto/create-zone-change-request.dto.js';
import { UpdateSchedulesDto } from './dto/update-schedules.dto.js';
import { UpdateSpecialtiesDto } from './dto/update-specialties.dto.js';
import { UpdateWorkerProfileDto } from './dto/update-worker-profile.dto.js';
import { normalizeSchedules, toTime } from './schedules.js';
import {
  ADMIN_TRANSITIONS,
  EDITABLE_STATUSES,
  NOT_APPROVED_MESSAGES,
  STATUSES_REQUIRING_REASON,
  SUBMITTABLE_STATUSES,
  ZONE_DIRECTLY_EDITABLE_STATUS,
  ZONE_REQUEST_BLOCKED_STATUSES,
} from './worker-profile.rules.js';

type Db = Prisma.TransactionClient;

const PROFILE_SELECT = {
  id: true,
  userId: true,
  yearsOfExperience: true,
  description: true,
  zoneId: true,
  status: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
  specialties: { select: { categoryId: true } },
  schedules: {
    select: {
      id: true,
      dayOfWeek: true,
      startMinutes: true,
      endMinutes: true,
      isActive: true,
    },
    orderBy: [{ dayOfWeek: 'asc' }, { startMinutes: 'asc' }],
  },
} satisfies Prisma.WorkerProfileSelect;

type ProfileRecord = Prisma.WorkerProfileGetPayload<{
  select: typeof PROFILE_SELECT;
}>;

export interface CatalogRef {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ScheduleView {
  id: string;
  dayOfWeek: WeekDay;
  startTime: string;
  endTime: string;
  isActive: boolean;
}

export interface PendingRequirement {
  field: 'phone' | 'specialties' | 'zone' | 'schedules';
  message: string;
}

export interface WorkerProfileView {
  id: string;
  userId: string;
  status: WorkerProfileStatus;
  yearsOfExperience: number;
  description: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  zone: CatalogRef;
  /** La zona fue desactivada (RF-49): debe solicitar o elegir otra. */
  zoneRequiresChange: boolean;
  specialties: CatalogRef[];
  schedules: ScheduleView[];
  /** Lo que falta para poder enviar el perfil a revision (CU-06 A1). */
  pendingRequirements: PendingRequirement[];
  canEdit: boolean;
  canSubmit: boolean;
}

export interface StatusHistoryEntry {
  id: string;
  fromStatus: WorkerProfileStatus | null;
  toStatus: WorkerProfileStatus;
  reason: string | null;
  createdAt: Date;
  /** Quien hizo el cambio, sin exponer datos del administrador. */
  changedBy: 'TRABAJADOR' | 'ADMINISTRADOR';
}

export interface WorkerStatusView {
  status: WorkerProfileStatus;
  /** Comentario u observacion asociado al estado vigente, si existe. */
  statusReason: string | null;
  history: StatusHistoryEntry[];
}

export interface WorkerEligibility {
  eligible: boolean;
  status: WorkerProfileStatus | null;
  message: string;
  reason: string | null;
}

export interface ApprovedWorker {
  profileId: string;
  userId: string;
  zoneId: string;
  categoryIds: string[];
}

export interface AffectedProfile {
  profileId: string;
  userId: string;
  status: WorkerProfileStatus;
  zone: { id: string; name: string };
  hasPendingZoneChangeRequest: boolean;
}

export interface ZoneChangeRequestView {
  id: string;
  status: ZoneChangeRequestStatus;
  reason: string;
  fromZone: CatalogRef;
  toZone: CatalogRef;
  createdAt: Date;
  decidedAt: Date | null;
  decisionComment: string | null;
}

export interface AdminStatusChange {
  status: WorkerProfileStatus;
  reason?: string;
}

export interface ZoneChangeDecision {
  decision: 'APROBADA' | 'RECHAZADA';
  comment?: string;
}

const PRISMA_UNIQUE_VIOLATION = 'P2002';

// Cuentas que pueden registrar un perfil de trabajador (y recibir el rol).
const WORKER_PROFILE_CREATOR_ROLES: readonly RoleName[] = [
  RoleName.CLIENTE,
  RoleName.TRABAJADOR,
];

/**
 * Perfil del trabajador: registro (RF-06), estados e historial (RF-08),
 * elegibilidad (RF-09) y zona fija con solicitudes de cambio (RF-13).
 * Los documentos (RF-07) estan en WorkerDocumentsService.
 */
@Injectable()
export class WorkerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly catalogs: CatalogsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------
  // Autogestion del trabajador
  // ---------------------------------------------------------------------

  /**
   * Cualquier cuenta de cliente o trabajador puede registrar su perfil; al
   * hacerlo recibe el rol TRABAJADOR en la misma transaccion. El rol no
   * habilita funciones de trabajador: eso exige el perfil APROBADO (RF-03).
   */
  async create(
    userId: string,
    dto: CreateWorkerProfileDto,
  ): Promise<WorkerProfileView> {
    const user = await this.users.findById(userId);
    if (user.status !== UserStatus.ACTIVO) {
      throw new ForbiddenException('La cuenta no está activa');
    }
    if (
      !WORKER_PROFILE_CREATOR_ROLES.some((role) => user.roles.includes(role))
    ) {
      throw new ForbiddenException(
        'Solo una cuenta de cliente o de trabajador puede registrar un perfil de trabajador',
      );
    }
    if (await this.prisma.workerProfile.findUnique({ where: { userId } })) {
      throw duplicateProfile();
    }
    await this.catalogs.assertActive(CatalogKind.ZONE, dto.zoneId);
    await this.assertCategoriesActive(dto.categoryIds);
    const schedules = normalizeSchedules(dto.schedules ?? []);

    try {
      const record = await this.prisma.$transaction(async (tx) => {
        const { id } = await tx.workerProfile.create({
          data: {
            userId,
            yearsOfExperience: dto.yearsOfExperience,
            description: normalizeText(dto.description),
            zoneId: dto.zoneId,
            specialties: {
              createMany: {
                data: dto.categoryIds.map((categoryId) => ({ categoryId })),
              },
            },
            schedules: { createMany: { data: schedules } },
          },
          select: { id: true },
        });
        await this.users.grantWorkerRole(userId, tx);
        await tx.workerProfileStatusHistory.create({
          data: {
            profileId: id,
            fromStatus: null,
            toStatus: WorkerProfileStatus.BORRADOR,
            changedById: userId,
          },
        });
        return tx.workerProfile.findUniqueOrThrow({
          where: { id },
          select: PROFILE_SELECT,
        });
      });
      return this.buildView(record, user);
    } catch (error) {
      if (isPrismaError(error, PRISMA_UNIQUE_VIOLATION)) {
        throw duplicateProfile();
      }
      throw error;
    }
  }

  async getOwn(userId: string): Promise<WorkerProfileView> {
    return this.buildView(await this.getOwnRecord(this.prisma, userId));
  }

  async updateOwn(
    userId: string,
    dto: UpdateWorkerProfileDto,
  ): Promise<WorkerProfileView> {
    if (
      dto.yearsOfExperience === undefined &&
      dto.description === undefined &&
      dto.zoneId === undefined
    ) {
      throw new BadRequestException('Debe enviar al menos un dato a modificar');
    }
    const profile = await this.getOwnRecord(this.prisma, userId);
    const changesZone =
      dto.zoneId !== undefined && dto.zoneId !== profile.zoneId;
    if (changesZone && profile.status !== ZONE_DIRECTLY_EDITABLE_STATUS) {
      throw new ForbiddenException(
        'La zona de atención es fija. Para cambiarla, envíe una solicitud de cambio de zona.',
      );
    }
    assertEditable(profile.status);

    const data: Prisma.WorkerProfileUncheckedUpdateManyInput = {};
    if (dto.yearsOfExperience !== undefined) {
      data.yearsOfExperience = dto.yearsOfExperience;
    }
    if (dto.description !== undefined) {
      data.description = normalizeText(dto.description);
    }
    if (changesZone) {
      await this.catalogs.assertActive(CatalogKind.ZONE, dto.zoneId!);
      data.zoneId = dto.zoneId;
    }

    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, profile, data);
    });
    return this.getOwn(userId);
  }

  async replaceSpecialties(
    userId: string,
    dto: UpdateSpecialtiesDto,
  ): Promise<WorkerProfileView> {
    const profile = await this.getOwnRecord(this.prisma, userId);
    assertEditable(profile.status);
    await this.assertCategoriesActive(dto.categoryIds);

    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, profile, {});
      await tx.workerSpecialty.deleteMany({ where: { profileId: profile.id } });
      await tx.workerSpecialty.createMany({
        data: dto.categoryIds.map((categoryId) => ({
          profileId: profile.id,
          categoryId,
        })),
      });
    });
    return this.getOwn(userId);
  }

  /**
   * Los horarios de atencion (no las reservas de trabajos) se pueden
   * actualizar en cualquier estado: no forman parte de lo que se verifica.
   */
  async replaceSchedules(
    userId: string,
    dto: UpdateSchedulesDto,
  ): Promise<WorkerProfileView> {
    const profile = await this.getOwnRecord(this.prisma, userId);
    const schedules = normalizeSchedules(dto.schedules);

    await this.prisma.$transaction(async (tx) => {
      await tx.workerSchedule.deleteMany({ where: { profileId: profile.id } });
      await tx.workerSchedule.createMany({
        data: schedules.map((row) => ({ ...row, profileId: profile.id })),
      });
      await tx.workerProfile.update({
        where: { id: profile.id },
        data: { updatedAt: new Date() },
      });
    });
    return this.getOwn(userId);
  }

  /** Envia (o reenvia tras una observacion) el perfil: pasa a PENDIENTE. */
  async submit(userId: string): Promise<WorkerProfileView> {
    const profile = await this.getOwnRecord(this.prisma, userId);
    if (!SUBMITTABLE_STATUSES.includes(profile.status)) {
      throw new ConflictException(
        `No se puede enviar a revisión un perfil en estado ${profile.status}`,
      );
    }
    const view = await this.buildView(profile);
    if (view.pendingRequirements.length > 0) {
      throw new BadRequestException(
        view.pendingRequirements.map((item) => item.message),
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, profile, {
        status: WorkerProfileStatus.PENDIENTE,
        submittedAt: new Date(),
      });
      await tx.workerProfileStatusHistory.create({
        data: {
          profileId: profile.id,
          fromStatus: profile.status,
          toStatus: WorkerProfileStatus.PENDIENTE,
          changedById: userId,
        },
      });
    });
    return this.getOwn(userId);
  }

  async getOwnStatus(userId: string): Promise<WorkerStatusView> {
    const profile = await this.getOwnRecord(this.prisma, userId);
    const history = await this.prisma.workerProfileStatusHistory.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'desc' },
    });
    return {
      status: profile.status,
      statusReason:
        history.find((entry) => entry.toStatus === profile.status)?.reason ??
        null,
      history: history.map((entry) => ({
        id: entry.id,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        reason: entry.reason,
        createdAt: entry.createdAt,
        changedBy:
          entry.changedById === profile.userId ? 'TRABAJADOR' : 'ADMINISTRADOR',
      })),
    };
  }

  // ---------------------------------------------------------------------
  // RF-13: solicitudes de cambio de zona
  // ---------------------------------------------------------------------

  async requestZoneChange(
    userId: string,
    dto: CreateZoneChangeRequestDto,
  ): Promise<ZoneChangeRequestView> {
    const profile = await this.getOwnRecord(this.prisma, userId);
    if (profile.status === ZONE_DIRECTLY_EDITABLE_STATUS) {
      throw new ConflictException(
        'Su perfil aún no fue enviado a revisión: puede elegir la zona directamente al editar el perfil.',
      );
    }
    if (ZONE_REQUEST_BLOCKED_STATUSES.includes(profile.status)) {
      throw new ConflictException(
        `No se puede solicitar un cambio de zona con el perfil en estado ${profile.status}`,
      );
    }
    if (dto.toZoneId === profile.zoneId) {
      throw new BadRequestException('La zona solicitada es su zona actual');
    }
    await this.catalogs.assertActive(CatalogKind.ZONE, dto.toZoneId);

    try {
      const request = await this.prisma.zoneChangeRequest.create({
        data: {
          profileId: profile.id,
          fromZoneId: profile.zoneId,
          toZoneId: dto.toZoneId,
          reason: dto.reason,
        },
      });
      return (await this.toZoneRequestViews([request]))[0];
    } catch (error) {
      if (isPrismaError(error, PRISMA_UNIQUE_VIOLATION)) {
        throw new ConflictException(
          'Ya tiene una solicitud de cambio de zona pendiente',
        );
      }
      throw error;
    }
  }

  async listOwnZoneChangeRequests(
    userId: string,
  ): Promise<ZoneChangeRequestView[]> {
    const profile = await this.getOwnRecord(this.prisma, userId);
    const requests = await this.prisma.zoneChangeRequest.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'desc' },
    });
    return this.toZoneRequestViews(requests);
  }

  // ---------------------------------------------------------------------
  // RF-09: elegibilidad, para pedidos, ofertas y busquedas futuras
  // ---------------------------------------------------------------------

  async getEligibility(userId: string): Promise<WorkerEligibility> {
    const user = await this.users.findById(userId).catch((error: unknown) => {
      if (error instanceof NotFoundException) return null;
      throw error;
    });
    if (!user || user.status !== UserStatus.ACTIVO) {
      return notEligible(null, 'La cuenta no está activa.');
    }
    if (!user.roles.includes(RoleName.TRABAJADOR)) {
      return notEligible(null, 'La cuenta no tiene el rol de trabajador.');
    }
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });
    if (!profile) {
      return notEligible(null, 'Aún no registró su perfil de trabajador.');
    }
    if (profile.status === WorkerProfileStatus.APROBADO) {
      return {
        eligible: true,
        status: profile.status,
        message: NOT_APPROVED_MESSAGES.APROBADO,
        reason: null,
      };
    }
    const latest = await this.prisma.workerProfileStatusHistory.findFirst({
      where: { profileId: profile.id, toStatus: profile.status },
      orderBy: { createdAt: 'desc' },
      select: { reason: true },
    });
    return notEligible(
      profile.status,
      NOT_APPROVED_MESSAGES[profile.status],
      latest?.reason ?? null,
    );
  }

  /**
   * Bloquea funciones de trabajador (ofertar, recibir pedidos) a quien no
   * tenga perfil APROBADO y cuenta activa. Lanza 403 con el motivo (CU-03).
   */
  async assertWorkerApproved(userId: string): Promise<ApprovedWorker> {
    const eligibility = await this.getEligibility(userId);
    if (!eligibility.eligible) {
      throw new ForbiddenException(
        eligibility.reason
          ? `${eligibility.message} Motivo: ${eligibility.reason}`
          : eligibility.message,
      );
    }
    const profile = await this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId },
      select: PROFILE_SELECT,
    });
    return toApprovedWorker(profile);
  }

  /**
   * Trabajadores elegibles para una categoria y zona: perfil APROBADO,
   * cuenta activa y rol de trabajador vigente. Si la categoria o la zona
   * estan inactivas no hay elegibles (no se aceptan registros nuevos).
   */
  async findApprovedWorkers(filter: {
    categoryId: string;
    zoneId: string;
  }): Promise<ApprovedWorker[]> {
    const [category, zone] = await Promise.all([
      this.catalogs.findById(CatalogKind.CATEGORY, filter.categoryId),
      this.catalogs.findById(CatalogKind.ZONE, filter.zoneId),
    ]);
    if (!category.isActive || !zone.isActive) {
      return [];
    }
    const profiles = await this.prisma.workerProfile.findMany({
      where: {
        status: WorkerProfileStatus.APROBADO,
        zoneId: zone.id,
        specialties: { some: { categoryId: category.id } },
        user: {
          status: UserStatus.ACTIVO,
          roles: { some: { role: RoleName.TRABAJADOR } },
        },
      },
      select: PROFILE_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return profiles.map(toApprovedWorker);
  }

  // ---------------------------------------------------------------------
  // Integracion con RF-49 y con el futuro modulo de verificacion (modulo 4)
  // ---------------------------------------------------------------------

  /** Perfiles cuya zona fue desactivada; la zona no se cambia sola. */
  async findProfilesWithInactiveZone(
    zoneId?: string,
  ): Promise<AffectedProfile[]> {
    const inactiveZones = (
      await this.catalogs.findAll(CatalogKind.ZONE, { isActive: false })
    ).filter((zone) => !zoneId || zone.id === zoneId);
    if (inactiveZones.length === 0) {
      return [];
    }
    const zonesById = new Map(inactiveZones.map((zone) => [zone.id, zone]));
    const profiles = await this.prisma.workerProfile.findMany({
      where: { zoneId: { in: [...zonesById.keys()] } },
      select: {
        id: true,
        userId: true,
        status: true,
        zoneId: true,
        zoneChangeRequests: {
          where: { status: ZoneChangeRequestStatus.PENDIENTE },
          select: { id: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return profiles.map((profile) => {
      const zone = zonesById.get(profile.zoneId)!;
      return {
        profileId: profile.id,
        userId: profile.userId,
        status: profile.status,
        zone: { id: zone.id, name: zone.name },
        hasPendingZoneChangeRequest: profile.zoneChangeRequests.length > 0,
      };
    });
  }

  /**
   * Cambio de estado administrativo (aprobar, observar, rechazar, suspender,
   * reactivar). Lo usara el modulo de verificacion; aqui no tiene endpoint.
   * Registra historial y bitacora en la misma transaccion.
   */
  async changeStatusByAdmin(
    adminId: string,
    profileId: string,
    { status, reason }: AdminStatusChange,
  ): Promise<WorkerProfileView> {
    await this.assertAdmin(adminId);
    const profile = await this.prisma.workerProfile.findUnique({
      where: { id: profileId },
      select: PROFILE_SELECT,
    });
    if (!profile) {
      throw new NotFoundException('El perfil de trabajador no existe');
    }
    if (!ADMIN_TRANSITIONS[profile.status]?.includes(status)) {
      throw new ConflictException(
        `No se puede pasar un perfil de ${profile.status} a ${status}`,
      );
    }
    const cleanReason = normalizeText(reason);
    if (STATUSES_REQUIRING_REASON.includes(status) && !cleanReason) {
      throw new BadRequestException(
        `Debe indicar el motivo para el estado ${status}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, profile, { status });
      await tx.workerProfileStatusHistory.create({
        data: {
          profileId,
          fromStatus: profile.status,
          toStatus: status,
          changedById: adminId,
          reason: cleanReason,
        },
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: AuditAction.CAMBIO_ESTADO,
          entityType: AuditEntityType.PERFIL_TRABAJADOR,
          entityId: profileId,
          details: { from: profile.status, to: status, reason: cleanReason },
        },
        tx,
      );
    });
    return this.buildView(
      await this.prisma.workerProfile.findUniqueOrThrow({
        where: { id: profileId },
        select: PROFILE_SELECT,
      }),
    );
  }

  /**
   * Decision administrativa sobre una solicitud de cambio de zona. Si se
   * aprueba, la nueva zona reemplaza a la anterior; si se rechaza, el perfil
   * conserva su zona. Lo usara el modulo de verificacion.
   */
  async decideZoneChangeRequest(
    adminId: string,
    requestId: string,
    { decision, comment }: ZoneChangeDecision,
  ): Promise<ZoneChangeRequestView> {
    await this.assertAdmin(adminId);
    const request = await this.prisma.zoneChangeRequest.findUnique({
      where: { id: requestId },
      include: { profile: { select: { zoneId: true } } },
    });
    if (!request) {
      throw new NotFoundException('La solicitud de cambio de zona no existe');
    }
    if (request.status !== ZoneChangeRequestStatus.PENDIENTE) {
      throw new ConflictException('La solicitud ya fue resuelta');
    }
    const cleanComment = normalizeText(comment);
    const approved = decision === ZoneChangeRequestStatus.APROBADA;
    if (!approved && !cleanComment) {
      throw new BadRequestException('Debe indicar el motivo del rechazo');
    }
    if (approved) {
      await this.catalogs.assertActive(CatalogKind.ZONE, request.toZoneId);
      if (request.profile.zoneId !== request.fromZoneId) {
        throw new ConflictException(
          'La zona del perfil cambió desde que se creó la solicitud',
        );
      }
    }

    const decided = await this.prisma.$transaction(async (tx) => {
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
        throw new ConflictException('La solicitud ya fue resuelta');
      }
      if (approved) {
        const moved = await tx.workerProfile.updateMany({
          where: { id: request.profileId, zoneId: request.fromZoneId },
          data: { zoneId: request.toZoneId },
        });
        if (moved.count === 0) {
          throw new ConflictException(
            'La zona del perfil cambió desde que se creó la solicitud',
          );
        }
      }
      await this.audit.record(
        {
          actorId: adminId,
          action: approved ? AuditAction.APROBACION : AuditAction.RECHAZO,
          entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
          entityId: requestId,
          details: {
            profileId: request.profileId,
            fromZoneId: request.fromZoneId,
            toZoneId: request.toZoneId,
            comment: cleanComment,
          },
        },
        tx,
      );
      return tx.zoneChangeRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
    });
    return (await this.toZoneRequestViews([decided]))[0];
  }

  // ---------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------

  private async getOwnRecord(db: Db, userId: string): Promise<ProfileRecord> {
    const profile = await db.workerProfile.findUnique({
      where: { userId },
      select: PROFILE_SELECT,
    });
    if (!profile) {
      throw new NotFoundException('Aún no tiene un perfil de trabajador');
    }
    return profile;
  }

  private async assertCategoriesActive(categoryIds: string[]): Promise<void> {
    const found = await this.catalogs.findByIds(
      CatalogKind.CATEGORY,
      categoryIds,
    );
    const foundIds = new Set(found.map((item) => item.id));
    const problems = [
      ...categoryIds
        .filter((id) => !foundIds.has(id))
        .map((id) => `La categoría ${id} no existe`),
      ...found
        .filter((item) => !item.isActive)
        .map((item) => `La categoría "${item.name}" no está activa`),
    ];
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }
  }

  private async assertAdmin(adminId: string): Promise<PublicUser> {
    const admin = await this.users.findById(adminId).catch(() => null);
    if (
      !admin ||
      admin.status !== UserStatus.ACTIVO ||
      !admin.roles.includes(RoleName.ADMINISTRADOR)
    ) {
      throw new ForbiddenException('Operación reservada a administradores');
    }
    return admin;
  }

  private async buildView(
    profile: ProfileRecord,
    knownUser?: PublicUser,
  ): Promise<WorkerProfileView> {
    const [zone, categories, user] = await Promise.all([
      this.catalogs.findById(CatalogKind.ZONE, profile.zoneId),
      this.catalogs.findByIds(
        CatalogKind.CATEGORY,
        profile.specialties.map((item) => item.categoryId),
      ),
      knownUser ?? this.users.findById(profile.userId),
    ]);
    const schedules = profile.schedules.map((row) => ({
      id: row.id,
      dayOfWeek: row.dayOfWeek,
      startTime: toTime(row.startMinutes),
      endTime: toTime(row.endMinutes),
      isActive: row.isActive,
    }));
    const pendingRequirements = pendingRequirementsFor(
      profile,
      user,
      zone,
      categories,
    );
    const canEdit = EDITABLE_STATUSES.includes(profile.status);
    return {
      id: profile.id,
      userId: profile.userId,
      status: profile.status,
      yearsOfExperience: profile.yearsOfExperience,
      description: profile.description,
      submittedAt: profile.submittedAt,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      zone: toRef(zone),
      zoneRequiresChange: !zone.isActive,
      specialties: categories.map(toRef),
      schedules,
      pendingRequirements,
      canEdit,
      canSubmit:
        SUBMITTABLE_STATUSES.includes(profile.status) &&
        pendingRequirements.length === 0,
    };
  }

  private async toZoneRequestViews(
    requests: ZoneChangeRequest[],
  ): Promise<ZoneChangeRequestView[]> {
    const zones = await this.catalogs.findByIds(
      CatalogKind.ZONE,
      requests.flatMap((r) => [r.fromZoneId, r.toZoneId]),
    );
    const byId = new Map(zones.map((zone) => [zone.id, toRef(zone)]));
    return requests.map((request) => ({
      id: request.id,
      status: request.status,
      reason: request.reason,
      fromZone: byId.get(request.fromZoneId)!,
      toZone: byId.get(request.toZoneId)!,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
      decisionComment: request.decisionComment,
    }));
  }
}

/**
 * Aplica `data` solo si el estado no cambio desde que se leyo el perfil
 * (control optimista ante envios o decisiones simultaneas).
 */
async function lockStatus(
  tx: Db,
  profile: ProfileRecord,
  data: Prisma.WorkerProfileUncheckedUpdateManyInput,
): Promise<void> {
  const { count } = await tx.workerProfile.updateMany({
    where: { id: profile.id, status: profile.status },
    data: { ...data, updatedAt: new Date() },
  });
  if (count === 0) {
    throw new ConflictException(
      'El perfil cambió de estado mientras se procesaba la solicitud. Vuelva a intentarlo.',
    );
  }
}

function pendingRequirementsFor(
  profile: ProfileRecord,
  user: PublicUser,
  zone: CatalogItem,
  categories: CatalogItem[],
): PendingRequirement[] {
  const missing: PendingRequirement[] = [];
  if (!user.phone) {
    missing.push({
      field: 'phone',
      message: 'Registre un teléfono de contacto en su cuenta',
    });
  }
  const inactive = categories.filter((item) => !item.isActive);
  if (inactive.length > 0) {
    missing.push({
      field: 'specialties',
      message: `Quite las especialidades inactivas: ${inactive.map((item) => item.name).join(', ')}`,
    });
  } else if (categories.length === 0) {
    missing.push({
      field: 'specialties',
      message: 'Seleccione al menos una especialidad',
    });
  }
  if (!zone.isActive) {
    missing.push({
      field: 'zone',
      message:
        profile.status === ZONE_DIRECTLY_EDITABLE_STATUS
          ? `La zona "${zone.name}" fue desactivada: elija otra zona`
          : `La zona "${zone.name}" fue desactivada: solicite un cambio de zona`,
    });
  }
  if (!profile.schedules.some((row) => row.isActive)) {
    missing.push({
      field: 'schedules',
      message: 'Defina al menos un horario de atención activo',
    });
  }
  return missing;
}

function assertEditable(status: WorkerProfileStatus): void {
  if (!EDITABLE_STATUSES.includes(status)) {
    throw new ConflictException(
      `No se puede modificar el perfil en estado ${status}`,
    );
  }
}

function notEligible(
  status: WorkerProfileStatus | null,
  message: string,
  reason: string | null = null,
): WorkerEligibility {
  return { eligible: false, status, message, reason };
}

function toApprovedWorker(profile: ProfileRecord): ApprovedWorker {
  return {
    profileId: profile.id,
    userId: profile.userId,
    zoneId: profile.zoneId,
    categoryIds: profile.specialties.map((item) => item.categoryId),
  };
}

function toRef({ id, name, isActive }: CatalogItem): CatalogRef {
  return { id, name, isActive };
}

function normalizeText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function duplicateProfile(): ConflictException {
  return new ConflictException('Esta cuenta ya tiene un perfil de trabajador');
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}
