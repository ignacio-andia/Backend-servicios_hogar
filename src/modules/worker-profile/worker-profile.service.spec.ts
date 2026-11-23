import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  NotificationResourceType,
  NotificationType,
  Prisma,
  RoleName,
  UserStatus,
  WeekDay,
  WorkerProfileStatus,
  ZoneChangeRequestStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from '../catalogs/catalogs.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PublicUser, UsersService } from '../users/users.service.js';
import { WorkerActiveWorkRegistry } from './active-work.registry.js';
import { WorkerProfileStatusRegistry } from './profile-status.registry.js';
import {
  AdminWorkerProfileView,
  WorkerProfileService,
} from './worker-profile.service.js';
import { ZoneChangeRequestsService } from './zone-change-requests.service.js';

const USER_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const ADMIN_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const PROFILE_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const ZONE_A = '11111111-1111-4111-8111-111111111111';
const ZONE_B = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '33333333-3333-4333-8333-333333333333';

const user = (overrides: Partial<PublicUser> = {}): PublicUser => ({
  id: USER_ID,
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'juan@example.com',
  phone: '70000000',
  status: UserStatus.ACTIVO,
  roles: [RoleName.CLIENTE, RoleName.TRABAJADOR],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const catalogItem = (id: string, overrides: Partial<CatalogItem> = {}) => ({
  id,
  name: `Item ${id.slice(0, 4)}`,
  description: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: PROFILE_ID,
  userId: USER_ID,
  yearsOfExperience: 5,
  description: null,
  zoneId: ZONE_A,
  status: WorkerProfileStatus.BORRADOR,
  submittedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  specialties: [{ categoryId: CATEGORY }],
  schedules: [
    {
      id: 's1',
      dayOfWeek: WeekDay.LUNES,
      startMinutes: 480,
      endMinutes: 720,
      isActive: true,
    },
  ],
  ...overrides,
});

const mockFns = <K extends string>(...names: K[]) =>
  Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
    K,
    ReturnType<typeof vi.fn>
  >;

describe('WorkerProfileService', () => {
  let prisma: {
    workerProfile: Record<
      | 'findUnique'
      | 'findUniqueOrThrow'
      | 'findMany'
      | 'create'
      | 'update'
      | 'updateMany',
      ReturnType<typeof vi.fn>
    >;
    workerSpecialty: Record<
      'deleteMany' | 'createMany',
      ReturnType<typeof vi.fn>
    >;
    workerSchedule: Record<
      'deleteMany' | 'createMany',
      ReturnType<typeof vi.fn>
    >;
    workerProfileStatusHistory: Record<
      'create' | 'findMany' | 'findFirst',
      ReturnType<typeof vi.fn>
    >;
    zoneChangeRequest: Record<
      | 'create'
      | 'count'
      | 'findFirst'
      | 'findMany'
      | 'findUnique'
      | 'findUniqueOrThrow'
      | 'updateMany',
      ReturnType<typeof vi.fn>
    >;
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let users: Record<
    'findById' | 'findByIdForShare' | 'grantWorkerRole',
    ReturnType<typeof vi.fn>
  >;
  let catalogs: Record<
    'assertActive' | 'findById' | 'findByIds' | 'findAll' | 'findByIdsForShare',
    ReturnType<typeof vi.fn>
  >;
  let audit: { record: ReturnType<typeof vi.fn> };
  let zoneRequests: { cancelPendingOnSuspension: ReturnType<typeof vi.fn> };
  let profileStatus: WorkerProfileStatusRegistry;
  let onProfileSuspended: ReturnType<
    typeof vi.fn<(tx: unknown, event: unknown) => Promise<void>>
  >;
  let notifications: Record<
    'create' | 'createForRole',
    ReturnType<typeof vi.fn>
  >;
  let service: WorkerProfileService;

  beforeEach(() => {
    prisma = {
      workerProfile: mockFns(
        'findUnique',
        'findUniqueOrThrow',
        'findMany',
        'create',
        'update',
        'updateMany',
      ),
      workerSpecialty: mockFns('deleteMany', 'createMany'),
      workerSchedule: mockFns('deleteMany', 'createMany'),
      workerProfileStatusHistory: mockFns('create', 'findMany', 'findFirst'),
      zoneChangeRequest: mockFns(
        'create',
        'count',
        'findFirst',
        'findMany',
        'findUnique',
        'findUniqueOrThrow',
        'updateMany',
      ),
      $transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) =>
        work(prisma),
      ),
      // lockWorker: SELECT ... FOR UPDATE dentro de la transaccion.
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    prisma.zoneChangeRequest.count.mockResolvedValue(0);
    prisma.zoneChangeRequest.findFirst.mockResolvedValue(null);
    prisma.workerProfile.updateMany.mockResolvedValue({ count: 1 });
    users = {
      findById: vi.fn().mockResolvedValue(user()),
      // Cuenta del trabajador leida con FOR SHARE dentro de la transaccion.
      findByIdForShare: vi.fn().mockResolvedValue(user()),
      grantWorkerRole: vi.fn().mockResolvedValue(undefined),
    };
    catalogs = mockFns(
      'assertActive',
      'findById',
      'findByIds',
      'findAll',
      'findByIdsForShare',
    );
    catalogs.findByIdsForShare.mockImplementation((_tx, _kind, ids: string[]) =>
      Promise.resolve(ids.map((id) => catalogItem(id))),
    );
    catalogs.assertActive.mockImplementation((_kind, id: string) =>
      Promise.resolve(catalogItem(id)),
    );
    catalogs.findById.mockImplementation((_kind, id: string) =>
      Promise.resolve(catalogItem(id)),
    );
    catalogs.findByIds.mockImplementation((_kind, ids: string[]) =>
      Promise.resolve(ids.map((id) => catalogItem(id))),
    );
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    notifications = {
      create: vi.fn().mockResolvedValue(undefined),
      createForRole: vi.fn().mockResolvedValue(1),
    };
    zoneRequests = {
      cancelPendingOnSuspension: vi.fn().mockResolvedValue(false),
    };
    onProfileSuspended = vi
      .fn<(tx: unknown, event: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    profileStatus = new WorkerProfileStatusRegistry();
    profileStatus.register({
      name: 'prueba',
      onSuspended: (tx, event) =>
        onProfileSuspended(tx, event) as Promise<void>,
    });
    service = new WorkerProfileService(
      prisma as unknown as PrismaService,
      users as unknown as UsersService,
      catalogs as unknown as CatalogsService,
      audit as unknown as AuditService,
      new WorkerActiveWorkRegistry(),
      notifications as unknown as NotificationsService,
      zoneRequests as unknown as ZoneChangeRequestsService,
      profileStatus,
    );
  });

  const createDto = {
    yearsOfExperience: 5,
    zoneId: ZONE_A,
    categoryIds: [CATEGORY],
    schedules: [
      { dayOfWeek: WeekDay.LUNES, startTime: '08:00', endTime: '12:00' },
    ],
  };

  describe('create', () => {
    it('crea el perfil en BORRADOR con especialidades, horarios e historial', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(null);
      prisma.workerProfile.create.mockResolvedValue({ id: PROFILE_ID });
      prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(profile());

      const view = await service.create(USER_ID, createDto);

      expect(prisma.workerProfile.create.mock.calls[0][0].data).toMatchObject({
        userId: USER_ID,
        zoneId: ZONE_A,
        specialties: { createMany: { data: [{ categoryId: CATEGORY }] } },
        schedules: {
          createMany: {
            data: [
              {
                dayOfWeek: WeekDay.LUNES,
                startMinutes: 480,
                endMinutes: 720,
                isActive: true,
              },
            ],
          },
        },
      });
      expect(
        prisma.workerProfile.create.mock.calls[0][0].data,
      ).not.toHaveProperty('status');
      expect(prisma.workerProfileStatusHistory.create).toHaveBeenCalledWith({
        data: {
          profileId: PROFILE_ID,
          fromStatus: null,
          toStatus: WorkerProfileStatus.BORRADOR,
          changedById: USER_ID,
        },
      });
      expect(view).toMatchObject({
        status: WorkerProfileStatus.BORRADOR,
        schedules: [{ startTime: '08:00', endTime: '12:00' }],
        pendingRequirements: [],
        canSubmit: true,
      });
    });

    it('una cuenta de cliente recibe el rol TRABAJADOR en la misma transaccion', async () => {
      users.findById.mockResolvedValue(user({ roles: [RoleName.CLIENTE] }));
      prisma.workerProfile.findUnique.mockResolvedValue(null);
      prisma.workerProfile.create.mockResolvedValue({ id: PROFILE_ID });
      prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(profile());

      await service.create(USER_ID, createDto);

      // El tx del mock es el propio objeto prisma: el rol usa esa transaccion.
      expect(users.grantWorkerRole).toHaveBeenCalledWith(USER_ID, prisma);
    });

    it('si falla la creacion no se otorga el rol (rollback de la transaccion)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(null);
      prisma.workerProfile.create.mockResolvedValue({ id: PROFILE_ID });
      prisma.workerProfileStatusHistory.create.mockRejectedValue(
        new Error('fallo de BD'),
      );

      await expect(service.create(USER_ID, createDto)).rejects.toThrow(
        'fallo de BD',
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(users.grantWorkerRole.mock.calls[0][1]).toBe(prisma);
    });

    it.each([
      ['solo administradora', { roles: [RoleName.ADMINISTRADOR] }],
      ['inactiva', { status: UserStatus.INACTIVO }],
    ])('una cuenta %s no puede crear perfil', async (_label, overrides) => {
      users.findById.mockResolvedValue(user(overrides));

      await expect(service.create(USER_ID, createDto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.workerProfile.create).not.toHaveBeenCalled();
      expect(users.grantWorkerRole).not.toHaveBeenCalled();
    });

    it('impide un segundo perfil para la misma cuenta', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue({ id: PROFILE_ID });

      await expect(service.create(USER_ID, createDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('traduce la unicidad simultanea de userId a 409', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.create(USER_ID, createDto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rechaza categorias inactivas o inexistentes', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(null);
      const missing = '99999999-9999-4999-8999-999999999999';
      catalogs.findByIds.mockResolvedValue([
        catalogItem(CATEGORY, { name: 'Pintura', isActive: false }),
      ]);

      await expect(
        service.create(USER_ID, {
          ...createDto,
          categoryIds: [CATEGORY, missing],
        }),
      ).rejects.toMatchObject({
        response: {
          message: [
            `La categoría ${missing} no existe`,
            'La categoría "Pintura" no está activa',
          ],
        },
      });
    });

    it('rechaza zonas inactivas (via CatalogsService.assertActive)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(null);
      catalogs.assertActive.mockRejectedValue(
        new BadRequestException('La zona seleccionada no está activa'),
      );

      await expect(service.create(USER_ID, createDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(catalogs.assertActive).toHaveBeenCalledWith(
        CatalogKind.ZONE,
        ZONE_A,
      );
    });
  });

  describe('updateOwn', () => {
    it('permite elegir otra zona mientras el perfil es BORRADOR', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile());

      await service.updateOwn(USER_ID, { zoneId: ZONE_B });

      expect(catalogs.assertActive).toHaveBeenCalledWith(
        CatalogKind.ZONE,
        ZONE_B,
      );
      expect(prisma.workerProfile.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: PROFILE_ID, status: WorkerProfileStatus.BORRADOR },
        data: { zoneId: ZONE_B },
      });
    });

    it('impide cambiar la zona directamente despues del primer envio', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.OBSERVADO }),
      );

      await expect(
        service.updateOwn(USER_ID, { zoneId: ZONE_B }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
    });

    it('no permite editar un perfil en revision', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.PENDIENTE }),
      );

      await expect(
        service.updateOwn(USER_ID, { yearsOfExperience: 6 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('responde 409 si el estado cambio mientras se editaba', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile());
      prisma.workerProfile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateOwn(USER_ID, { yearsOfExperience: 6 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('exige al menos un campo', async () => {
      await expect(service.updateOwn(USER_ID, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('responde 404 si la cuenta aun no tiene perfil', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.updateOwn(USER_ID, { yearsOfExperience: 6 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('submit', () => {
    it('pasa de BORRADOR a PENDIENTE y lo registra en el historial', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile());

      await service.submit(USER_ID);

      expect(prisma.workerProfile.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: PROFILE_ID, status: WorkerProfileStatus.BORRADOR },
        data: { status: WorkerProfileStatus.PENDIENTE },
      });
      expect(prisma.workerProfileStatusHistory.create).toHaveBeenCalledWith({
        data: {
          profileId: PROFILE_ID,
          fromStatus: WorkerProfileStatus.BORRADOR,
          toStatus: WorkerProfileStatus.PENDIENTE,
          changedById: USER_ID,
        },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('reenvia un perfil OBSERVADO a PENDIENTE', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.OBSERVADO }),
      );

      await service.submit(USER_ID);

      expect(
        prisma.workerProfileStatusHistory.create.mock.calls[0][0].data,
      ).toMatchObject({
        fromStatus: WorkerProfileStatus.OBSERVADO,
        toStatus: WorkerProfileStatus.PENDIENTE,
      });
    });

    it('indica todo lo que falta y no envia', async () => {
      users.findById.mockResolvedValue(user({ phone: null }));
      catalogs.findById.mockResolvedValue(
        catalogItem(ZONE_A, { name: 'Norte', isActive: false }),
      );
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ specialties: [], schedules: [] }),
      );

      await expect(service.submit(USER_ID)).rejects.toMatchObject({
        response: {
          message: [
            'Registre un teléfono de contacto en su cuenta',
            'Seleccione al menos una especialidad',
            'La zona "Norte" fue desactivada: elija otra zona',
            'Defina al menos un horario de atención activo',
          ],
        },
      });
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      WorkerProfileStatus.PENDIENTE,
      WorkerProfileStatus.APROBADO,
      WorkerProfileStatus.SUSPENDIDO,
    ])('no permite enviar desde %s', async (status) => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile({ status }));

      await expect(service.submit(USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('reenvia un perfil RECHAZADO a PENDIENTE con una entrada nueva de historial (T3.1)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.RECHAZADO }),
      );

      await service.submit(USER_ID);

      expect(prisma.workerProfile.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: PROFILE_ID, status: WorkerProfileStatus.RECHAZADO },
        data: { status: WorkerProfileStatus.PENDIENTE },
      });
      // Se agrega una entrada; el rechazo anterior no se modifica.
      expect(prisma.workerProfileStatusHistory.create).toHaveBeenCalledWith({
        data: {
          profileId: PROFILE_ID,
          fromStatus: WorkerProfileStatus.RECHAZADO,
          toStatus: WorkerProfileStatus.PENDIENTE,
          changedById: USER_ID,
        },
      });
      // Decision del equipo: el reenvio va al historial, no a la bitacora
      // administrativa.
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('no reenvia un perfil RECHAZADO con requisitos pendientes', async () => {
      users.findById.mockResolvedValue(user({ phone: null }));
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.RECHAZADO }),
      );

      await expect(service.submit(USER_ID)).rejects.toMatchObject({
        response: {
          message: ['Registre un teléfono de contacto en su cuenta'],
        },
      });
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
      expect(prisma.workerProfileStatusHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('notificaciones del envio a verificacion (T3.2)', () => {
    it.each([
      [WorkerProfileStatus.BORRADOR, NotificationType.VERIFICACION_SOLICITADA],
      [
        WorkerProfileStatus.OBSERVADO,
        NotificationType.VERIFICACION_REENVIADA_OBSERVACION,
      ],
      [
        WorkerProfileStatus.RECHAZADO,
        NotificationType.VERIFICACION_REENVIADA_RECHAZO,
      ],
    ])(
      'desde %s avisa a los administradores activos con %s, sin incluir a quien envia',
      async (from, type) => {
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({ status: from }),
        );

        await service.submit(USER_ID);

        expect(notifications.createForRole).toHaveBeenCalledTimes(1);
        expect(notifications.createForRole).toHaveBeenCalledWith(
          RoleName.ADMINISTRADOR,
          expect.objectContaining({
            type,
            resource: {
              type: NotificationResourceType.PERFIL_TRABAJADOR,
              id: PROFILE_ID,
            },
          }),
          { excludeUserIds: [USER_ID] },
          // El cliente de la transaccion del envio.
          prisma,
        );
        // El trabajador no recibe aviso de su propio envio.
        expect(notifications.create).not.toHaveBeenCalled();
      },
    );

    it('si la notificacion falla, el envio falla (misma transaccion)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile());
      notifications.createForRole.mockRejectedValue(new Error('sin conexion'));

      await expect(service.submit(USER_ID)).rejects.toThrow('sin conexion');
    });

    it('no notifica si el envio no procede', async () => {
      users.findById.mockResolvedValue(user({ phone: null }));
      prisma.workerProfile.findUnique.mockResolvedValue(profile());

      await expect(service.submit(USER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(notifications.createForRole).not.toHaveBeenCalled();
    });
  });

  describe('correccion de un perfil RECHAZADO (T3.1)', () => {
    beforeEach(() => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.RECHAZADO }),
      );
    });

    it('permite editar los datos y las especialidades', async () => {
      await service.updateOwn(USER_ID, { yearsOfExperience: 8 });
      await service.replaceSpecialties(USER_ID, { categoryIds: [CATEGORY] });

      expect(prisma.workerProfile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PROFILE_ID, status: WorkerProfileStatus.RECHAZADO },
        }),
      );
      expect(prisma.workerSpecialty.createMany).toHaveBeenCalled();
    });

    it('la zona sigue fija (403, RF-13)', async () => {
      await expect(
        service.updateOwn(USER_ID, { zoneId: ZONE_B }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('la vista indica que se puede editar y reenviar', async () => {
      const view = await service.getOwn(USER_ID);
      expect(view).toMatchObject({
        status: WorkerProfileStatus.RECHAZADO,
        canEdit: true,
        canSubmit: true,
      });
    });
  });

  describe('regularizacion de un perfil SUSPENDIDO (T4-F7)', () => {
    beforeEach(() => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.SUSPENDIDO }),
      );
    });

    it('permite editar los datos y las especialidades sin cambiar el estado', async () => {
      await service.updateOwn(USER_ID, { yearsOfExperience: 8 });
      await service.replaceSpecialties(USER_ID, { categoryIds: [CATEGORY] });

      expect(prisma.workerProfile.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PROFILE_ID, status: WorkerProfileStatus.SUSPENDIDO },
        }),
      );
      for (const [args] of prisma.workerProfile.updateMany.mock.calls as [
        { data: Record<string, unknown> },
      ][]) {
        expect(args.data).not.toHaveProperty('status');
      }
      expect(prisma.workerSpecialty.createMany).toHaveBeenCalled();
      expect(prisma.workerProfileStatusHistory.create).not.toHaveBeenCalled();
    });

    it('no puede cambiar su zona por cuenta propia (403, RF-13)', async () => {
      await expect(
        service.updateOwn(USER_ID, { zoneId: ZONE_B }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('no puede enviarse a revision: editar no levanta la suspension', async () => {
      await expect(service.submit(USER_ID)).rejects.toThrow(
        new ConflictException(
          'No se puede enviar a revisión un perfil en estado SUSPENDIDO',
        ),
      );
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
    });

    it('la vista indica que puede editar pero no enviar', async () => {
      await expect(service.getOwn(USER_ID)).resolves.toMatchObject({
        status: WorkerProfileStatus.SUSPENDIDO,
        canEdit: true,
        canSubmit: false,
      });
    });

    it('sigue sin poder tomar trabajos ni ofertar (403)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue({
        ...profile({ status: WorkerProfileStatus.SUSPENDIDO }),
        user: {
          status: UserStatus.ACTIVO,
          roles: [{ role: RoleName.TRABAJADOR }],
        },
      });
      prisma.workerProfileStatusHistory.findFirst.mockResolvedValue(null);

      await expect(
        service.lockApprovedWorker(prisma as never, USER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.assertWorkerApproved(USER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('elegibilidad (RF-09)', () => {
    it('solo un perfil APROBADO con cuenta activa es elegible', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID,
        status: WorkerProfileStatus.APROBADO,
      });

      await expect(service.getEligibility(USER_ID)).resolves.toMatchObject({
        eligible: true,
      });
    });

    it.each([
      WorkerProfileStatus.BORRADOR,
      WorkerProfileStatus.PENDIENTE,
      WorkerProfileStatus.OBSERVADO,
      WorkerProfileStatus.RECHAZADO,
      WorkerProfileStatus.SUSPENDIDO,
    ])('un perfil %s no es elegible', async (status) => {
      prisma.workerProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID,
        status,
      });
      prisma.workerProfileStatusHistory.findFirst.mockResolvedValue(null);

      await expect(
        service.assertWorkerApproved(USER_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('incluye el motivo del estado vigente', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID,
        status: WorkerProfileStatus.SUSPENDIDO,
      });
      prisma.workerProfileStatusHistory.findFirst.mockResolvedValue({
        reason: 'Reclamos reiterados',
      });

      await expect(service.assertWorkerApproved(USER_ID)).rejects.toThrow(
        'Su perfil de trabajador está suspendido. Motivo: Reclamos reiterados',
      );
    });

    describe('cambio de zona pendiente en la elegibilidad (T4-F4)', () => {
      it('aprobado sin solicitud pendiente puede tomar trabajos nuevos', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue({
          id: PROFILE_ID,
          status: WorkerProfileStatus.APROBADO,
        });

        await expect(service.getEligibility(USER_ID)).resolves.toEqual({
          eligible: true,
          status: WorkerProfileStatus.APROBADO,
          message: 'Su perfil de trabajador está aprobado.',
          reason: null,
          pendingZoneChangeRequest: null,
          canTakeNewWork: true,
        });
      });

      it('aprobado con solicitud pendiente sigue elegible pero no puede tomar trabajos nuevos', async () => {
        const createdAt = new Date('2026-11-20T10:00:00.000Z');
        prisma.workerProfile.findUnique.mockResolvedValue({
          id: PROFILE_ID,
          status: WorkerProfileStatus.APROBADO,
        });
        prisma.zoneChangeRequest.findFirst.mockResolvedValue({
          id: 'solicitud-1',
          toZoneId: ZONE_B,
          createdAt,
        });

        await expect(service.getEligibility(USER_ID)).resolves.toMatchObject({
          eligible: true,
          canTakeNewWork: false,
          pendingZoneChangeRequest: {
            id: 'solicitud-1',
            toZone: { id: ZONE_B, isActive: true },
            createdAt,
          },
        });
        expect(prisma.zoneChangeRequest.findFirst).toHaveBeenCalledWith({
          where: {
            profileId: PROFILE_ID,
            status: ZoneChangeRequestStatus.PENDIENTE,
          },
          select: { id: true, toZoneId: true, createdAt: true },
        });
      });

      it('sin perfil aprobado nunca puede tomar trabajos nuevos', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue({
          id: PROFILE_ID,
          status: WorkerProfileStatus.SUSPENDIDO,
        });
        prisma.workerProfileStatusHistory.findFirst.mockResolvedValue(null);

        await expect(service.getEligibility(USER_ID)).resolves.toMatchObject({
          eligible: false,
          canTakeNewWork: false,
          pendingZoneChangeRequest: null,
        });
      });
    });

    it('una cuenta inactiva o sin rol de trabajador no es elegible', async () => {
      users.findById.mockResolvedValueOnce(
        user({ status: UserStatus.SUSPENDIDO }),
      );
      await expect(service.getEligibility(USER_ID)).resolves.toMatchObject({
        eligible: false,
        message: 'La cuenta no está activa.',
      });

      users.findById.mockResolvedValueOnce(user({ roles: [RoleName.CLIENTE] }));
      await expect(service.getEligibility(USER_ID)).resolves.toMatchObject({
        eligible: false,
      });
      expect(prisma.workerProfile.findUnique).not.toHaveBeenCalled();
    });

    it('la busqueda de elegibles filtra por APROBADO, zona, categoria y cuenta activa', async () => {
      prisma.workerProfile.findMany.mockResolvedValue([
        profile({ status: WorkerProfileStatus.APROBADO }),
      ]);

      const result = await service.findApprovedWorkers({
        categoryId: CATEGORY,
        zoneId: ZONE_A,
      });

      expect(prisma.workerProfile.findMany.mock.calls[0][0].where).toEqual({
        status: WorkerProfileStatus.APROBADO,
        zoneId: ZONE_A,
        specialties: { some: { categoryId: CATEGORY } },
        // T4.3: con un cambio de zona pendiente no es candidato.
        zoneChangeRequests: {
          none: { status: ZoneChangeRequestStatus.PENDIENTE },
        },
        user: {
          status: UserStatus.ACTIVO,
          roles: { some: { role: RoleName.TRABAJADOR } },
        },
      });
      expect(result).toEqual([
        {
          profileId: PROFILE_ID,
          userId: USER_ID,
          zoneId: ZONE_A,
          categoryIds: [CATEGORY],
        },
      ]);
    });

    describe('lockApprovedWorker con un cambio de zona pendiente (T4.3)', () => {
      const lockedProfile = () => ({
        ...profile({ status: WorkerProfileStatus.APROBADO }),
        user: {
          status: UserStatus.ACTIVO,
          roles: [{ role: RoleName.TRABAJADOR }],
        },
      });

      it('sin solicitud pendiente devuelve el trabajador aprobado', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue(lockedProfile());

        await expect(
          service.lockApprovedWorker(prisma as never, USER_ID),
        ).resolves.toMatchObject({ profileId: PROFILE_ID, userId: USER_ID });
        expect(prisma.zoneChangeRequest.count).toHaveBeenCalledWith({
          where: {
            profileId: PROFILE_ID,
            status: ZoneChangeRequestStatus.PENDIENTE,
          },
        });
        // La consulta va despues del bloqueo del trabajador.
        expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.zoneChangeRequest.count.mock.invocationCallOrder[0],
        );
      });

      it('con una solicitud pendiente no puede tomar trabajos nuevos (409)', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue(lockedProfile());
        prisma.zoneChangeRequest.count.mockResolvedValue(1);

        await expect(
          service.lockApprovedWorker(prisma as never, USER_ID),
        ).rejects.toThrow(
          new ConflictException(
            'Tiene una solicitud de cambio de zona pendiente: no puede ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire.',
          ),
        );
      });
    });

    it('no hay elegibles si la categoria o la zona estan inactivas', async () => {
      catalogs.findById.mockResolvedValueOnce(
        catalogItem(CATEGORY, { isActive: false }),
      );

      await expect(
        service.findApprovedWorkers({ categoryId: CATEGORY, zoneId: ZONE_A }),
      ).resolves.toEqual([]);
      expect(prisma.workerProfile.findMany).not.toHaveBeenCalled();
    });
  });

  describe('reassignZoneForRejected (T4.4)', () => {
    const dto = { zoneId: ZONE_B, justification: '  La zona A se cerró  ' };
    const zonesFor = (current: boolean, target: boolean | null) =>
      catalogs.findByIdsForShare.mockResolvedValue([
        catalogItem(ZONE_A, { name: 'Zona A', isActive: current }),
        ...(target === null
          ? []
          : [catalogItem(ZONE_B, { name: 'Zona B', isActive: target })]),
      ]);

    beforeEach(() => {
      users.findById.mockResolvedValue(
        user({ id: ADMIN_ID, roles: [RoleName.ADMINISTRADOR] }),
      );
      const rejected = profile({ status: WorkerProfileStatus.RECHAZADO });
      prisma.workerProfile.findUnique.mockResolvedValue(rejected);
      prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(rejected);
      zonesFor(false, true);
      // La vista final (detalle administrativo) ya tiene sus propias pruebas.
      vi.spyOn(service, 'getForAdmin').mockResolvedValue(
        {} as AdminWorkerProfileView,
      );
    });

    it('cambia solo la zona, audita y avisa al trabajador; el perfil sigue RECHAZADO', async () => {
      await service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto);

      expect(prisma.workerProfile.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.workerProfile.updateMany).toHaveBeenCalledWith({
        where: {
          id: PROFILE_ID,
          status: WorkerProfileStatus.RECHAZADO,
          zoneId: ZONE_A,
        },
        data: { zoneId: ZONE_B },
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorId: ADMIN_ID,
          action: AuditAction.EDICION,
          entityType: AuditEntityType.PERFIL_TRABAJADOR,
          entityId: PROFILE_ID,
          details: {
            operation: 'REASIGNACION_ZONA',
            workerUserId: USER_ID,
            profileStatus: WorkerProfileStatus.RECHAZADO,
            fromZoneId: ZONE_A,
            toZoneId: ZONE_B,
            justification: 'La zona A se cerró',
          },
        },
        prisma,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        USER_ID,
        {
          type: NotificationType.ZONA_REASIGNADA,
          title: 'Zona de atención reasignada',
          message:
            'Su zona "Zona A" fue desactivada y un administrador le asignó la zona "Zona B". Puede corregir su perfil y volver a enviarlo a revisión.',
          resource: {
            type: NotificationResourceType.PERFIL_TRABAJADOR,
            id: PROFILE_ID,
          },
        },
        prisma,
      );
      // Ni historial de estados, ni solicitud de cambio de zona, ni avisos a otros.
      expect(prisma.workerProfileStatusHistory.create).not.toHaveBeenCalled();
      expect(prisma.zoneChangeRequest.create).not.toHaveBeenCalled();
      expect(notifications.createForRole).not.toHaveBeenCalled();
    });

    it('bloquea al trabajador y luego las dos zonas (FOR SHARE) antes de decidir', async () => {
      await service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto);

      expect(prisma.$queryRaw.mock.calls[0][1]).toBe(USER_ID);
      expect(catalogs.findByIdsForShare).toHaveBeenCalledWith(
        prisma,
        CatalogKind.ZONE,
        [ZONE_A, ZONE_B],
      );
      const lock = prisma.$queryRaw.mock.invocationCallOrder[0];
      const reread =
        prisma.workerProfile.findUniqueOrThrow.mock.invocationCallOrder[0];
      const zones = catalogs.findByIdsForShare.mock.invocationCallOrder[0];
      const update =
        prisma.workerProfile.updateMany.mock.invocationCallOrder[0];
      expect(lock).toBeLessThan(reread);
      expect(reread).toBeLessThan(zones);
      expect(zones).toBeLessThan(update);
    });

    it.each([WorkerProfileStatus.BORRADOR, WorkerProfileStatus.APROBADO])(
      'un perfil %s no usa esta operacion (409)',
      async (status) => {
        prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(
          profile({ status }),
        );

        await expect(
          service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
        ).rejects.toThrow(
          new ConflictException(
            `Solo se puede reasignar la zona de un perfil RECHAZADO, OBSERVADO, PENDIENTE o SUSPENDIDO (estado actual: ${status})`,
          ),
        );
        expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        WorkerProfileStatus.OBSERVADO,
        'Puede corregir su perfil y volver a enviarlo a revisión.',
      ],
      [WorkerProfileStatus.PENDIENTE, 'Su perfil sigue en revisión.'],
      [
        WorkerProfileStatus.SUSPENDIDO,
        'Su perfil sigue suspendido: un administrador podrá reactivarlo cuando cumpla todos los requisitos.',
      ],
    ])(
      'un perfil %s tambien se reasigna y conserva su estado (T4-F2)',
      async (status, next) => {
        prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(
          profile({ status }),
        );

        await service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto);

        expect(prisma.workerProfile.updateMany).toHaveBeenCalledWith({
          where: { id: PROFILE_ID, status, zoneId: ZONE_A },
          data: { zoneId: ZONE_B },
        });
        expect(audit.record.mock.calls[0][0].details).toMatchObject({
          profileStatus: status,
        });
        expect(notifications.create.mock.calls[0][1].message).toBe(
          `Su zona "Zona A" fue desactivada y un administrador le asignó la zona "Zona B". ${next}`,
        );
      },
    );

    it('si la zona actual sigue activa, no es un cambio de zona general (409)', async () => {
      zonesFor(true, true);

      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
      ).rejects.toThrow(
        new ConflictException(
          'La zona actual "Zona A" sigue activa: la reasignación administrativa solo se usa cuando la zona del perfil fue desactivada',
        ),
      );
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
    });

    it('valida la zona destino: inexistente (404), inactiva (400) o la actual (400)', async () => {
      zonesFor(false, null);
      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
      ).rejects.toThrow(new NotFoundException('La zona no existe'));

      zonesFor(false, false);
      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
      ).rejects.toThrow(
        new BadRequestException('La zona seleccionada no está activa'),
      );

      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, {
          ...dto,
          zoneId: ZONE_A,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'La zona nueva debe ser distinta de la zona actual',
        ),
      );
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('exige una justificacion no vacia', async () => {
      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, {
          ...dto,
          justification: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('un administrador no modifica su propio perfil (403)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ userId: ADMIN_ID, status: WorkerProfileStatus.RECHAZADO }),
      );

      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
      ).rejects.toThrow(
        new ForbiddenException(
          'No puede modificar su propio perfil de trabajador',
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('solo un administrador activo (403) y sobre un perfil existente (404)', async () => {
      users.findById.mockResolvedValue(user());
      await expect(
        service.reassignZoneForRejected(USER_ID, PROFILE_ID, dto),
      ).rejects.toBeInstanceOf(ForbiddenException);

      users.findById.mockResolvedValue(
        user({ id: ADMIN_ID, roles: [RoleName.ADMINISTRADOR] }),
      );
      prisma.workerProfile.findUnique.mockResolvedValue(null);
      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('si el perfil cambio entre la lectura y la escritura, responde 409 sin auditar', async () => {
      prisma.workerProfile.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('si la bitacora o la notificacion fallan, la operacion falla (misma transaccion)', async () => {
      notifications.create.mockRejectedValue(new Error('sin conexion'));

      await expect(
        service.reassignZoneForRejected(ADMIN_ID, PROFILE_ID, dto),
      ).rejects.toThrow('sin conexion');
    });
  });

  describe('changeStatusByAdmin (preparado para el modulo 4)', () => {
    beforeEach(() => {
      users.findById.mockResolvedValue(
        user({ id: ADMIN_ID, roles: [RoleName.ADMINISTRADOR] }),
      );
      // La relectura dentro de la transaccion ve el mismo perfil.
      prisma.workerProfile.findUniqueOrThrow.mockImplementation(
        (args: unknown) =>
          (prisma.workerProfile.findUnique as (a: unknown) => unknown)(args),
      );
    });

    it('registra historial y bitacora en la misma transaccion', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.PENDIENTE }),
      );

      await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
        status: WorkerProfileStatus.OBSERVADO,
        reason: '  Falta la cédula  ',
      });

      expect(prisma.workerProfileStatusHistory.create).toHaveBeenCalledWith({
        data: {
          profileId: PROFILE_ID,
          fromStatus: WorkerProfileStatus.PENDIENTE,
          toStatus: WorkerProfileStatus.OBSERVADO,
          changedById: ADMIN_ID,
          reason: 'Falta la cédula',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorId: ADMIN_ID,
          action: AuditAction.CAMBIO_ESTADO,
          entityType: AuditEntityType.PERFIL_TRABAJADOR,
          entityId: PROFILE_ID,
          details: {
            from: WorkerProfileStatus.PENDIENTE,
            to: WorkerProfileStatus.OBSERVADO,
            reason: 'Falta la cédula',
          },
        },
        prisma,
      );
    });

    it.each([
      [
        WorkerProfileStatus.PENDIENTE,
        WorkerProfileStatus.OBSERVADO,
        NotificationType.PERFIL_OBSERVADO,
      ],
      [
        WorkerProfileStatus.PENDIENTE,
        WorkerProfileStatus.RECHAZADO,
        NotificationType.PERFIL_RECHAZADO,
      ],
      [
        WorkerProfileStatus.APROBADO,
        WorkerProfileStatus.SUSPENDIDO,
        NotificationType.PERFIL_SUSPENDIDO,
      ],
    ])(
      '%s -> %s notifica al trabajador (%s) con el motivo (T3.2)',
      async (from, to, type) => {
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({ status: from }),
        );

        await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: to,
          reason: '  Documento ilegible  ',
        });

        expect(notifications.create).toHaveBeenCalledTimes(1);
        const [recipient, notification, db] = notifications.create.mock
          .calls[0] as [string, { type: string; message: string }, unknown];
        expect(recipient).toBe(USER_ID);
        expect(notification).toMatchObject({
          type,
          resource: {
            type: NotificationResourceType.PERFIL_TRABAJADOR,
            id: PROFILE_ID,
          },
        });
        expect(notification.message).toContain('Motivo: Documento ilegible');
        expect(db).toBe(prisma);
        expect(notifications.createForRole).not.toHaveBeenCalled();
      },
    );

    it.each([
      [WorkerProfileStatus.PENDIENTE, NotificationType.PERFIL_APROBADO],
      [WorkerProfileStatus.SUSPENDIDO, NotificationType.PERFIL_REACTIVADO],
    ])(
      'aprobar desde %s notifica al trabajador con %s (T3.2)',
      async (from, type) => {
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({ status: from }),
        );

        await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.APROBADO,
        });

        expect(notifications.create).toHaveBeenCalledWith(
          USER_ID,
          expect.objectContaining({ type }),
          prisma,
        );
      },
    );

    it('si la notificacion falla, la decision falla (misma transaccion)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.PENDIENTE }),
      );
      notifications.create.mockRejectedValue(new Error('sin conexion'));

      await expect(
        service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.RECHAZADO,
          reason: 'x',
        }),
      ).rejects.toThrow('sin conexion');
    });

    it('al suspender cancela la solicitud de zona pendiente en la misma transaccion (T4.2)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.APROBADO }),
      );

      await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Reclamos reiterados',
      });

      expect(zoneRequests.cancelPendingOnSuspension).toHaveBeenCalledWith(
        prisma,
        ADMIN_ID,
        { id: PROFILE_ID, userId: USER_ID },
      );
      // Despues de bloquear el perfil con el cambio de estado.
      expect(
        prisma.workerProfile.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        zoneRequests.cancelPendingOnSuspension.mock.invocationCallOrder[0],
      );
    });

    it('al suspender avisa a los modulos registrados en la misma transaccion (T6.5.2)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.APROBADO }),
      );

      await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Reclamos reiterados',
      });

      expect(onProfileSuspended).toHaveBeenCalledWith(prisma, {
        profileId: PROFILE_ID,
        userId: USER_ID,
        actorId: ADMIN_ID,
      });
      // Con el perfil ya bloqueado por el cambio de estado.
      expect(
        prisma.workerProfile.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(onProfileSuspended.mock.invocationCallOrder[0]);
    });

    it('si un efecto de la suspension falla, la suspension falla', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.APROBADO }),
      );
      onProfileSuspended.mockRejectedValue(new Error('fallo de ofertas'));

      await expect(
        service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.SUSPENDIDO,
          reason: 'Motivo',
        }),
      ).rejects.toThrow('fallo de ofertas');
    });

    it.each([
      [WorkerProfileStatus.PENDIENTE, WorkerProfileStatus.OBSERVADO],
      [WorkerProfileStatus.PENDIENTE, WorkerProfileStatus.RECHAZADO],
      [WorkerProfileStatus.SUSPENDIDO, WorkerProfileStatus.APROBADO],
    ])('%s -> %s no toca las solicitudes de zona', async (from, to) => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: from }),
      );

      await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
        status: to,
        reason: 'Motivo',
      });

      expect(zoneRequests.cancelPendingOnSuspension).not.toHaveBeenCalled();
      expect(onProfileSuspended).not.toHaveBeenCalled();
    });

    it('si la cancelacion falla, la suspension falla (misma transaccion)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.APROBADO }),
      );
      zoneRequests.cancelPendingOnSuspension.mockRejectedValue(
        new Error('sin conexion'),
      );

      await expect(
        service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.SUSPENDIDO,
          reason: 'Motivo',
        }),
      ).rejects.toThrow('sin conexion');
    });

    it('solo lo puede hacer un administrador', async () => {
      users.findById.mockResolvedValue(user());

      await expect(
        service.changeStatusByAdmin(USER_ID, PROFILE_ID, {
          status: WorkerProfileStatus.APROBADO,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('impide que un administrador decida sobre su propio perfil', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ userId: ADMIN_ID, status: WorkerProfileStatus.PENDIENTE }),
      );

      await expect(
        service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.APROBADO,
        }),
      ).rejects.toThrow(
        new ForbiddenException(
          'No puede revisar ni decidir sobre su propio perfil de trabajador',
        ),
      );
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
      expect(prisma.workerProfileStatusHistory.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([
      [WorkerProfileStatus.BORRADOR, WorkerProfileStatus.APROBADO],
      [WorkerProfileStatus.OBSERVADO, WorkerProfileStatus.APROBADO],
      [WorkerProfileStatus.RECHAZADO, WorkerProfileStatus.APROBADO],
      [WorkerProfileStatus.PENDIENTE, WorkerProfileStatus.SUSPENDIDO],
    ])('rechaza la transicion %s -> %s', async (from, to) => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: from }),
      );

      await expect(
        service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: to,
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('exige motivo para observar, rechazar o suspender', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.PENDIENTE }),
      );

      await expect(
        service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.RECHAZADO,
          reason: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('aprobacion con requisitos pendientes', () => {
      it('no aprueba un perfil PENDIENTE cuya zona fue desactivada', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({ status: WorkerProfileStatus.PENDIENTE }),
        );
        catalogs.findByIdsForShare.mockImplementation(
          (_tx, kind: CatalogKind, ids: string[]) =>
            Promise.resolve(
              ids.map((id) =>
                catalogItem(id, {
                  name: 'Norte',
                  isActive: kind !== CatalogKind.ZONE,
                }),
              ),
            ),
        );

        await expect(
          service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
            status: WorkerProfileStatus.APROBADO,
          }),
        ).rejects.toMatchObject({
          status: 409,
          response: {
            message: [
              'El perfil no cumple los requisitos para ser aprobado. Obsérvelo para que el trabajador lo corrija.',
              'La zona "Norte" fue desactivada: solicite un cambio de zona',
            ],
          },
        });
        expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('lista todo lo que falta (telefono, especialidades, horarios)', async () => {
        users.findById.mockImplementation((id: string) =>
          Promise.resolve(
            id === ADMIN_ID
              ? user({ id: ADMIN_ID, roles: [RoleName.ADMINISTRADOR] })
              : user({ phone: null }),
          ),
        );
        users.findByIdForShare.mockResolvedValue(user({ phone: null }));
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({
            status: WorkerProfileStatus.PENDIENTE,
            specialties: [],
            schedules: [],
          }),
        );

        await expect(
          service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
            status: WorkerProfileStatus.APROBADO,
          }),
        ).rejects.toMatchObject({
          response: {
            message: expect.arrayContaining([
              'Registre un teléfono de contacto en su cuenta',
              'Seleccione al menos una especialidad',
              'Defina al menos un horario de atención activo',
            ]),
          },
        });
      });

      it('aprueba un perfil PENDIENTE que cumple los requisitos', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({ status: WorkerProfileStatus.PENDIENTE }),
        );

        await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.APROBADO,
        });

        expect(prisma.workerProfile.updateMany.mock.calls[0][0]).toMatchObject({
          where: { id: PROFILE_ID, status: WorkerProfileStatus.PENDIENTE },
          data: { status: WorkerProfileStatus.APROBADO },
        });
      });

      describe('reactivacion SUSPENDIDO -> APROBADO (T4-F1)', () => {
        const reactivate = () =>
          service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
            status: WorkerProfileStatus.APROBADO,
          });
        beforeEach(() => {
          prisma.workerProfile.findUnique.mockResolvedValue(
            profile({ status: WorkerProfileStatus.SUSPENDIDO }),
          );
        });

        it('reactiva un perfil que sigue cumpliendo los requisitos', async () => {
          await reactivate();

          expect(
            prisma.workerProfile.updateMany.mock.calls[0][0],
          ).toMatchObject({
            where: { id: PROFILE_ID, status: WorkerProfileStatus.SUSPENDIDO },
            data: { status: WorkerProfileStatus.APROBADO },
          });
        });

        it.each([
          [
            'la zona fue desactivada',
            () =>
              catalogs.findByIdsForShare.mockImplementation(
                (_tx, kind: CatalogKind, ids: string[]) =>
                  Promise.resolve(
                    ids.map((id) =>
                      catalogItem(id, {
                        name: 'Norte',
                        isActive: kind !== CatalogKind.ZONE,
                      }),
                    ),
                  ),
              ),
            'La zona "Norte" fue desactivada: solicite un cambio de zona',
          ],
          [
            'una especialidad fue desactivada',
            () =>
              catalogs.findByIdsForShare.mockImplementation(
                (_tx, kind: CatalogKind, ids: string[]) =>
                  Promise.resolve(
                    ids.map((id) =>
                      catalogItem(id, {
                        name: 'Gasfiteria',
                        isActive: kind !== CatalogKind.CATEGORY,
                      }),
                    ),
                  ),
              ),
            'Quite las especialidades inactivas: Gasfiteria',
          ],
          [
            'la cuenta ya no tiene telefono',
            () =>
              users.findByIdForShare.mockResolvedValue(user({ phone: null })),
            'Registre un teléfono de contacto en su cuenta',
          ],
        ])(
          'no reactiva si %s (409 con la lista)',
          async (_case, arrange, missing) => {
            arrange();

            await expect(reactivate()).rejects.toMatchObject({
              status: 409,
              response: {
                message: [
                  'El perfil no cumple los requisitos para ser reactivado. Deben corregirse antes de reactivarlo.',
                  missing,
                ],
              },
            });
            expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
            expect(
              prisma.workerProfileStatusHistory.create,
            ).not.toHaveBeenCalled();
            expect(audit.record).not.toHaveBeenCalled();
            expect(notifications.create).not.toHaveBeenCalled();
          },
        );

        it('no reactiva un perfil incompleto (sin especialidades ni horarios)', async () => {
          prisma.workerProfile.findUnique.mockResolvedValue(
            profile({
              status: WorkerProfileStatus.SUSPENDIDO,
              specialties: [],
              schedules: [],
            }),
          );

          await expect(reactivate()).rejects.toMatchObject({
            response: {
              message: expect.arrayContaining([
                'Seleccione al menos una especialidad',
                'Defina al menos un horario de atención activo',
              ]),
            },
          });
        });

        it('valida dentro de la transaccion: cuenta, perfil y catalogos bloqueados en orden', async () => {
          await reactivate();

          expect(users.findByIdForShare).toHaveBeenCalledWith(prisma, USER_ID);
          const account = users.findByIdForShare.mock.invocationCallOrder[0];
          const worker = prisma.$queryRaw.mock.invocationCallOrder[0];
          const reread =
            prisma.workerProfile.findUniqueOrThrow.mock.invocationCallOrder[0];
          const zones = catalogs.findByIdsForShare.mock.invocationCallOrder[0];
          const update =
            prisma.workerProfile.updateMany.mock.invocationCallOrder[0];
          expect(account).toBeLessThan(worker);
          expect(worker).toBeLessThan(reread);
          expect(reread).toBeLessThan(zones);
          expect(zones).toBeLessThan(update);
          expect(catalogs.findByIdsForShare).toHaveBeenCalledWith(
            prisma,
            CatalogKind.ZONE,
            [ZONE_A],
          );
          expect(catalogs.findByIdsForShare).toHaveBeenCalledWith(
            prisma,
            CatalogKind.CATEGORY,
            [CATEGORY],
          );
        });

        it('si el estado cambio antes del bloqueo, responde 409 sin escribir', async () => {
          prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(
            profile({ status: WorkerProfileStatus.APROBADO }),
          );

          await expect(reactivate()).rejects.toThrow(
            'El perfil cambió de estado mientras se procesaba la solicitud. Vuelva a intentarlo.',
          );
          expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
        });
      });

      it('aprobar desde PENDIENTE tambien valida dentro de la transaccion (T4-F5)', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({ status: WorkerProfileStatus.PENDIENTE }),
        );

        await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.APROBADO,
        });

        expect(users.findByIdForShare).toHaveBeenCalledTimes(1);
        expect(
          catalogs.findByIdsForShare.mock.invocationCallOrder[0],
        ).toBeLessThan(
          prisma.workerProfile.updateMany.mock.invocationCallOrder[0],
        );
      });

      it('las demas decisiones no bloquean la cuenta ni validan requisitos', async () => {
        prisma.workerProfile.findUnique.mockResolvedValue(
          profile({ status: WorkerProfileStatus.PENDIENTE }),
        );

        await service.changeStatusByAdmin(ADMIN_ID, PROFILE_ID, {
          status: WorkerProfileStatus.OBSERVADO,
          reason: 'Falta la foto',
        });

        expect(users.findByIdForShare).not.toHaveBeenCalled();
        expect(catalogs.findByIdsForShare).not.toHaveBeenCalled();
      });
    });
  });

  describe('findProfilesWithInactiveZone (RF-49)', () => {
    it('usa las zonas inactivas de CatalogsService y no cambia ninguna zona', async () => {
      catalogs.findAll.mockResolvedValue([
        catalogItem(ZONE_A, { name: 'Norte', isActive: false }),
      ]);
      prisma.workerProfile.findMany.mockResolvedValue([
        {
          id: PROFILE_ID,
          userId: USER_ID,
          status: WorkerProfileStatus.APROBADO,
          zoneId: ZONE_A,
          zoneChangeRequests: [],
        },
      ]);

      const result = await service.findProfilesWithInactiveZone();

      expect(catalogs.findAll).toHaveBeenCalledWith(CatalogKind.ZONE, {
        isActive: false,
      });
      expect(result).toEqual([
        {
          profileId: PROFILE_ID,
          userId: USER_ID,
          status: WorkerProfileStatus.APROBADO,
          zone: { id: ZONE_A, name: 'Norte' },
          hasPendingZoneChangeRequest: false,
        },
      ]);
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
    });

    it('sin zonas inactivas no consulta perfiles', async () => {
      catalogs.findAll.mockResolvedValue([]);

      await expect(service.findProfilesWithInactiveZone()).resolves.toEqual([]);
      expect(prisma.workerProfile.findMany).not.toHaveBeenCalled();
    });
  });

  describe('revision administrativa: listado y detalle (RF-10, RF-47)', () => {
    const admin = () => user({ id: ADMIN_ID, roles: [RoleName.ADMINISTRADOR] });
    let count: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      users.findById.mockImplementation((id: string) =>
        Promise.resolve(id === ADMIN_ID ? admin() : user()),
      );
      count = vi.fn().mockResolvedValue(1);
      (prisma.workerProfile as Record<string, unknown>).count = count;
      // El listado usa la forma de arreglo de $transaction.
      prisma.$transaction.mockImplementation((work: unknown) =>
        Array.isArray(work)
          ? Promise.all(work)
          : (work as (tx: unknown) => Promise<unknown>)(prisma),
      );
    });

    it('lista excluyendo el perfil propio y aplicando filtros y paginacion', async () => {
      prisma.workerProfile.findMany.mockResolvedValue([
        {
          ...profile({ status: WorkerProfileStatus.PENDIENTE }),
          user: {
            firstName: 'Juan',
            lastName: 'Pérez',
            email: 'juan@example.com',
            phone: '70000000',
            status: UserStatus.ACTIVO,
          },
        },
      ]);

      const result = await service.listForAdmin(ADMIN_ID, {
        status: WorkerProfileStatus.PENDIENTE,
        zoneId: ZONE_A,
        categoryId: CATEGORY,
        page: 2,
        limit: 10,
      });

      const where = {
        userId: { not: ADMIN_ID },
        status: WorkerProfileStatus.PENDIENTE,
        zoneId: ZONE_A,
        specialties: { some: { categoryId: CATEGORY } },
      };
      expect(prisma.workerProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where, skip: 10, take: 10 }),
      );
      expect(count).toHaveBeenCalledWith({ where });
      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
      expect(result.data[0]).toMatchObject({
        id: PROFILE_ID,
        status: WorkerProfileStatus.PENDIENTE,
        account: { email: 'juan@example.com', status: UserStatus.ACTIVO },
        zone: { id: ZONE_A },
        specialties: [{ id: CATEGORY }],
      });
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });

    it('solo un administrador activo puede listar', async () => {
      await expect(
        service.listForAdmin(USER_ID, { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.workerProfile.findMany).not.toHaveBeenCalled();
    });

    it('el detalle del perfil propio responde 403 sin leer el historial', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ userId: ADMIN_ID }),
      );

      await expect(
        service.getForAdmin(ADMIN_ID, PROFILE_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.workerProfileStatusHistory.findMany).not.toHaveBeenCalled();
    });

    it('responde 404 si el perfil no existe', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.getForAdmin(ADMIN_ID, PROFILE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('arma el detalle con cuenta, motivo vigente, historial y decisiones posibles', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.OBSERVADO }),
      );
      const changedBy = { id: ADMIN_ID, firstName: 'Ana', lastName: 'Admin' };
      prisma.workerProfileStatusHistory.findMany.mockResolvedValue([
        {
          id: 'h2',
          fromStatus: WorkerProfileStatus.PENDIENTE,
          toStatus: WorkerProfileStatus.OBSERVADO,
          reason: 'Falta la cédula',
          createdAt: new Date(),
          changedById: ADMIN_ID,
          changedBy,
        },
        {
          id: 'h1',
          fromStatus: WorkerProfileStatus.BORRADOR,
          toStatus: WorkerProfileStatus.PENDIENTE,
          reason: null,
          createdAt: new Date(),
          changedById: USER_ID,
          changedBy: { id: USER_ID, firstName: 'Juan', lastName: 'Pérez' },
        },
      ]);

      const view = await service.getForAdmin(ADMIN_ID, PROFILE_ID);

      expect(view).toMatchObject({
        profile: { id: PROFILE_ID, status: WorkerProfileStatus.OBSERVADO },
        account: {
          email: 'juan@example.com',
          roles: [RoleName.CLIENTE, RoleName.TRABAJADOR],
        },
        statusReason: 'Falta la cédula',
        history: [
          { id: 'h2', changedBy: 'ADMINISTRADOR', changedByUser: changedBy },
          { id: 'h1', changedBy: 'TRABAJADOR' },
        ],
        // OBSERVADO no tiene decisiones administrativas (el trabajador reenvia).
        allowedDecisions: [],
      });
    });

    it('ofrece las decisiones permitidas para un perfil PENDIENTE', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.PENDIENTE }),
      );
      prisma.workerProfileStatusHistory.findMany.mockResolvedValue([]);

      const view = await service.getForAdmin(ADMIN_ID, PROFILE_ID);

      expect(view.allowedDecisions).toEqual([
        WorkerProfileStatus.APROBADO,
        WorkerProfileStatus.OBSERVADO,
        WorkerProfileStatus.RECHAZADO,
      ]);
      expect(view.statusReason).toBeNull();
    });
  });
});
