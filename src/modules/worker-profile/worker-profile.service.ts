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
import type { WeekDay } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from '../catalogs/catalogs.service.js';
import { PublicUser, UsersService } from '../users/users.service.js';
import { CreateWorkerProfileDto } from './dto/create-worker-profile.dto.js';
import { ListAdminWorkerProfilesQueryDto } from './dto/list-admin-worker-profiles-query.dto.js';
import { UpdateSchedulesDto } from './dto/update-schedules.dto.js';
import { UpdateSpecialtiesDto } from './dto/update-specialties.dto.js';
import { UpdateWorkerProfileDto } from './dto/update-worker-profile.dto.js';
import { WorkerActiveWorkRegistry } from './active-work.registry.js';
import { normalizeSchedules, toTime } from './schedules.js';
import {
  ADMIN_TRANSITIONS,
  EDITABLE_STATUSES,
  NOT_APPROVED_MESSAGES,
  STATUSES_REQUIRING_REASON,
  SUBMITTABLE_STATUSES,
  ZONE_DIRECTLY_EDITABLE_STATUS,
} from './worker-profile.rules.js';
import {
  assertActiveAdmin,
  CatalogRef,
  isPrismaError,
  normalizeText,
  PRISMA_UNIQUE_VIOLATION,
  toRef,
} from './worker-profile.utils.js';

export type { CatalogRef };

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

// Listado administrativo: perfil, especialidades y datos basicos de la cuenta.
const ADMIN_PROFILE_SELECT = {
  id: true,
  userId: true,
  zoneId: true,
  status: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
  specialties: { select: { categoryId: true } },
  user: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
    },
  },
} satisfies Prisma.WorkerProfileSelect;

type ProfileRecord = Prisma.WorkerProfileGetPayload<{
  select: typeof PROFILE_SELECT;
}>;

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

/** Datos de la cuenta que ve un administrador (nunca el hash). */
export interface AdminAccountSummary {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
}

/** Fila del listado administrativo de perfiles. */
export interface AdminWorkerProfileSummary {
  id: string;
  userId: string;
  status: WorkerProfileStatus;
  account: AdminAccountSummary;
  zone: CatalogRef;
  specialties: CatalogRef[];
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedAdminWorkerProfiles {
  data: AdminWorkerProfileSummary[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/** Entrada del historial vista por un administrador: incluye quien decidio. */
export interface AdminStatusHistoryEntry extends StatusHistoryEntry {
  changedByUser: { id: string; firstName: string; lastName: string };
}

/** Detalle de un perfil para revisarlo (RF-10, RF-47). */
export interface AdminWorkerProfileView {
  profile: WorkerProfileView;
  account: AdminAccountSummary & { roles: RoleName[] };
  /** Motivo del cambio mas reciente al estado vigente (privado). */
  statusReason: string | null;
  history: AdminStatusHistoryEntry[];
  /** Estados a los que puede pasar ahora (ADMIN_TRANSITIONS). */
  allowedDecisions: WorkerProfileStatus[];
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

export interface AdminStatusChange {
  status: WorkerProfileStatus;
  reason?: string;
}

// Cuentas que pueden registrar un perfil de trabajador (y recibir el rol).
const WORKER_PROFILE_CREATOR_ROLES: readonly RoleName[] = [
  RoleName.CLIENTE,
  RoleName.TRABAJADOR,
];

/**
 * Perfil del trabajador: registro (RF-06), estados e historial (RF-08),
 * elegibilidad (RF-09) y zona fija (RF-13). Los documentos (RF-07) estan en
 * WorkerDocumentsService y las solicitudes de cambio de zona en
 * ZoneChangeRequestsService.
 */
@Injectable()
export class WorkerProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly catalogs: CatalogsService,
    private readonly audit: AuditService,
    private readonly activeWork: WorkerActiveWorkRegistry,
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
      throw notApprovedError(eligibility);
    }
    const profile = await this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId },
      select: PROFILE_SELECT,
    });
    return toApprovedWorker(profile);
  }

  /**
   * Version transaccional de assertWorkerApproved para operaciones que crean
   * o cambian trabajo del trabajador (ofertas, asignacion de pedidos). Dentro
   * de la transaccion `tx` del llamador bloquea la fila del perfil y lo
   * vuelve a leer con ese bloqueo: zona, especialidades y aprobacion no
   * cambian hasta que la transaccion termine. Los datos del guard
   * (ApprovedWorkerGuard) se leyeron antes y no sirven para decidir aqui.
   *
   * Orden de bloqueos del proyecto: primero el trabajador (este metodo),
   * despues el pedido. Lanza 403 con el mismo mensaje que assertWorkerApproved.
   */
  async lockApprovedWorker(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<ApprovedWorker> {
    await this.activeWork.lockWorker(tx, userId);
    const profile = await tx.workerProfile.findUnique({
      where: { userId },
      select: {
        ...PROFILE_SELECT,
        user: {
          select: { status: true, roles: { select: { role: true } } },
        },
      },
    });
    const approved =
      profile !== null &&
      profile.status === WorkerProfileStatus.APROBADO &&
      profile.user.status === UserStatus.ACTIVO &&
      profile.user.roles.some((item) => item.role === RoleName.TRABAJADOR);
    if (!approved) {
      // Solo para armar el mensaje; la decision ya se tomo con el bloqueo.
      const eligibility = await this.getEligibility(userId);
      throw notApprovedError(
        eligibility.eligible
          ? notEligible(null, 'La cuenta no está habilitada como trabajador.')
          : eligibility,
      );
    }
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
    await assertActiveAdmin(this.users, adminId);
    const profile = await this.prisma.workerProfile.findUnique({
      where: { id: profileId },
      select: PROFILE_SELECT,
    });
    if (!profile) {
      throw new NotFoundException('El perfil de trabajador no existe');
    }
    // Un administrador no revisa ni decide sobre su propio perfil (v1.0 §5).
    // La identidad sale del token, nunca del cuerpo de la peticion.
    if (profile.userId === adminId) {
      throw new ForbiddenException(
        'No puede revisar ni decidir sobre su propio perfil de trabajador',
      );
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
    if (
      profile.status === WorkerProfileStatus.PENDIENTE &&
      status === WorkerProfileStatus.APROBADO
    ) {
      await this.assertMeetsApprovalRequirements(profile);
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

  // ---------------------------------------------------------------------
  // RF-10 y RF-47: revision administrativa (listado y detalle)
  // ---------------------------------------------------------------------

  /**
   * Listado paginado de perfiles para revisar. Excluye el perfil del propio
   * administrador: no puede revisar su propio perfil (v1.0 §5). Orden de
   * cola: primero los enviados hace mas tiempo; los nunca enviados al final.
   */
  async listForAdmin(
    adminId: string,
    {
      status,
      zoneId,
      categoryId,
      page,
      limit,
    }: ListAdminWorkerProfilesQueryDto,
  ): Promise<PaginatedAdminWorkerProfiles> {
    await assertActiveAdmin(this.users, adminId);
    const where: Prisma.WorkerProfileWhereInput = {
      userId: { not: adminId },
      ...(status ? { status } : {}),
      ...(zoneId ? { zoneId } : {}),
      ...(categoryId ? { specialties: { some: { categoryId } } } : {}),
    };
    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.workerProfile.findMany({
        where,
        select: ADMIN_PROFILE_SELECT,
        orderBy: [
          { submittedAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.workerProfile.count({ where }),
    ]);
    const [zones, categories] = await Promise.all([
      this.catalogs.findByIds(
        CatalogKind.ZONE,
        profiles.map((profile) => profile.zoneId),
      ),
      this.catalogs.findByIds(
        CatalogKind.CATEGORY,
        profiles.flatMap((profile) =>
          profile.specialties.map((item) => item.categoryId),
        ),
      ),
    ]);
    const zoneRefs = new Map(zones.map((zone) => [zone.id, toRef(zone)]));
    const categoryRefs = new Map(
      categories.map((category) => [category.id, toRef(category)]),
    );
    return {
      data: profiles.map((profile) => ({
        id: profile.id,
        userId: profile.userId,
        status: profile.status,
        account: toAccountSummary(profile.user),
        zone: zoneRefs.get(profile.zoneId)!,
        specialties: profile.specialties
          .map((item) => categoryRefs.get(item.categoryId)!)
          .sort((a, b) => a.name.localeCompare(b.name)),
        submittedAt: profile.submittedAt,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Detalle de un perfil para revisarlo: datos del perfil, cuenta, motivo
   * vigente, historial completo y decisiones posibles. Un administrador no
   * puede revisar su propio perfil (403). No incluye los documentos: su
   * consulta y descarga administrativa es una tarea aparte (con bitacora).
   */
  async getForAdmin(
    adminId: string,
    profileId: string,
  ): Promise<AdminWorkerProfileView> {
    await assertActiveAdmin(this.users, adminId);
    const record = await this.prisma.workerProfile.findUnique({
      where: { id: profileId },
      select: PROFILE_SELECT,
    });
    if (!record) {
      throw new NotFoundException('El perfil de trabajador no existe');
    }
    if (record.userId === adminId) {
      throw new ForbiddenException(
        'No puede revisar ni decidir sobre su propio perfil de trabajador',
      );
    }
    const [account, history] = await Promise.all([
      this.users.findById(record.userId),
      this.prisma.workerProfileStatusHistory.findMany({
        where: { profileId },
        orderBy: { createdAt: 'desc' },
        include: {
          changedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    ]);
    return {
      profile: await this.buildView(record, account),
      account: {
        firstName: account.firstName,
        lastName: account.lastName,
        email: account.email,
        phone: account.phone,
        status: account.status,
        roles: account.roles,
      },
      statusReason:
        history.find((entry) => entry.toStatus === record.status)?.reason ??
        null,
      history: history.map((entry) => ({
        id: entry.id,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        reason: entry.reason,
        createdAt: entry.createdAt,
        changedBy:
          entry.changedById === record.userId ? 'TRABAJADOR' : 'ADMINISTRADOR',
        changedByUser: entry.changedBy,
      })),
      allowedDecisions: [...(ADMIN_TRANSITIONS[record.status] ?? [])],
    };
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

  /**
   * Un perfil PENDIENTE solo se aprueba si sigue cumpliendo lo que se exigio
   * al enviarlo (zona y especialidades activas, telefono, horario activo):
   * pudo cambiar despues del envio, por ejemplo si se desactivo su zona.
   * Decision del equipo: bloquear con 409 y mostrar lo que falta. La
   * reactivacion SUSPENDIDO -> APROBADO no se valida aqui: un perfil aprobado
   * conserva su estado aunque se desactive su zona (RF-49).
   */
  private async assertMeetsApprovalRequirements(
    profile: ProfileRecord,
  ): Promise<void> {
    const { pendingRequirements } = await this.buildView(profile);
    if (pendingRequirements.length > 0) {
      throw new ConflictException([
        'El perfil no cumple los requisitos para ser aprobado. Obsérvelo para que el trabajador lo corrija.',
        ...pendingRequirements.map((item) => item.message),
      ]);
    }
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

function toAccountSummary(user: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
}): AdminAccountSummary {
  const { firstName, lastName, email, phone, status } = user;
  return { firstName, lastName, email, phone, status };
}

function notApprovedError(eligibility: WorkerEligibility): ForbiddenException {
  return new ForbiddenException(
    eligibility.reason
      ? `${eligibility.message} Motivo: ${eligibility.reason}`
      : eligibility.message,
  );
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

function duplicateProfile(): ConflictException {
  return new ConflictException('Esta cuenta ya tiene un perfil de trabajador');
}
