import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
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
import { PublicUser, UsersService } from '../users/users.service.js';
import { WorkerProfileService } from './worker-profile.service.js';

const USER_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const ADMIN_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const PROFILE_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const ZONE_A = '11111111-1111-4111-8111-111111111111';
const ZONE_B = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

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
      'create' | 'findMany' | 'findUnique' | 'findUniqueOrThrow' | 'updateMany',
      ReturnType<typeof vi.fn>
    >;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let users: Record<'findById' | 'grantWorkerRole', ReturnType<typeof vi.fn>>;
  let catalogs: Record<
    'assertActive' | 'findById' | 'findByIds' | 'findAll',
    ReturnType<typeof vi.fn>
  >;
  let audit: { record: ReturnType<typeof vi.fn> };
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
        'findMany',
        'findUnique',
        'findUniqueOrThrow',
        'updateMany',
      ),
      $transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) =>
        work(prisma),
      ),
    };
    prisma.workerProfile.updateMany.mockResolvedValue({ count: 1 });
    users = {
      findById: vi.fn().mockResolvedValue(user()),
      grantWorkerRole: vi.fn().mockResolvedValue(undefined),
    };
    catalogs = mockFns('assertActive', 'findById', 'findByIds', 'findAll');
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
    service = new WorkerProfileService(
      prisma as unknown as PrismaService,
      users as unknown as UsersService,
      catalogs as unknown as CatalogsService,
      audit as unknown as AuditService,
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
      WorkerProfileStatus.RECHAZADO,
      WorkerProfileStatus.SUSPENDIDO,
    ])('no permite enviar desde %s', async (status) => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile({ status }));

      await expect(service.submit(USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
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

  describe('changeStatusByAdmin (preparado para el modulo 4)', () => {
    beforeEach(() => {
      users.findById.mockResolvedValue(
        user({ id: ADMIN_ID, roles: [RoleName.ADMINISTRADOR] }),
      );
      prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(profile());
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

    it('solo lo puede hacer un administrador', async () => {
      users.findById.mockResolvedValue(user());

      await expect(
        service.changeStatusByAdmin(USER_ID, PROFILE_ID, {
          status: WorkerProfileStatus.APROBADO,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
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
  });

  describe('cambio de zona (RF-13)', () => {
    it('crea una solicitud PENDIENTE con la zona actual como origen', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.APROBADO }),
      );
      prisma.zoneChangeRequest.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: REQUEST_ID,
          status: ZoneChangeRequestStatus.PENDIENTE,
          createdAt: new Date(),
          decidedAt: null,
          decisionComment: null,
          ...data,
        }),
      );

      const view = await service.requestZoneChange(USER_ID, {
        toZoneId: ZONE_B,
        reason: 'Me mudé',
      });

      expect(prisma.zoneChangeRequest.create).toHaveBeenCalledWith({
        data: {
          profileId: PROFILE_ID,
          fromZoneId: ZONE_A,
          toZoneId: ZONE_B,
          reason: 'Me mudé',
        },
      });
      expect(view).toMatchObject({
        status: ZoneChangeRequestStatus.PENDIENTE,
        fromZone: { id: ZONE_A },
        toZone: { id: ZONE_B },
      });
    });

    it('en BORRADOR la zona se elige directamente, sin solicitud', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile());

      await expect(
        service.requestZoneChange(USER_ID, {
          toZoneId: ZONE_B,
          reason: 'xxxxx',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza pedir la misma zona', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.APROBADO }),
      );

      await expect(
        service.requestZoneChange(USER_ID, {
          toZoneId: ZONE_A,
          reason: 'xxxxx',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una segunda solicitud pendiente responde 409 (indice unico parcial)', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile({ status: WorkerProfileStatus.APROBADO }),
      );
      prisma.zoneChangeRequest.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.requestZoneChange(USER_ID, {
          toZoneId: ZONE_B,
          reason: 'xxxxx',
        }),
      ).rejects.toThrow('Ya tiene una solicitud de cambio de zona pendiente');
    });

    describe('decideZoneChangeRequest', () => {
      const pending = {
        id: REQUEST_ID,
        profileId: PROFILE_ID,
        fromZoneId: ZONE_A,
        toZoneId: ZONE_B,
        reason: 'Me mudé',
        status: ZoneChangeRequestStatus.PENDIENTE,
        createdAt: new Date(),
        decidedAt: null,
        decidedById: null,
        decisionComment: null,
        profile: { zoneId: ZONE_A },
      };

      beforeEach(() => {
        users.findById.mockResolvedValue(
          user({ id: ADMIN_ID, roles: [RoleName.ADMINISTRADOR] }),
        );
        prisma.zoneChangeRequest.findUnique.mockResolvedValue(pending);
        prisma.zoneChangeRequest.updateMany.mockResolvedValue({ count: 1 });
        prisma.zoneChangeRequest.findUniqueOrThrow.mockResolvedValue(pending);
      });

      it('al rechazar, el perfil conserva su zona', async () => {
        await service.decideZoneChangeRequest(ADMIN_ID, REQUEST_ID, {
          decision: 'RECHAZADA',
          comment: 'Zona sin cobertura',
        });

        expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
        expect(audit.record.mock.calls[0][0]).toMatchObject({
          action: AuditAction.RECHAZO,
          entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
        });
      });

      it('al aprobar, la nueva zona reemplaza a la anterior', async () => {
        await service.decideZoneChangeRequest(ADMIN_ID, REQUEST_ID, {
          decision: 'APROBADA',
        });

        expect(prisma.workerProfile.updateMany).toHaveBeenCalledWith({
          where: { id: PROFILE_ID, zoneId: ZONE_A },
          data: { zoneId: ZONE_B },
        });
        expect(audit.record.mock.calls[0][0].action).toBe(
          AuditAction.APROBACION,
        );
      });

      it('exige motivo para rechazar', async () => {
        await expect(
          service.decideZoneChangeRequest(ADMIN_ID, REQUEST_ID, {
            decision: 'RECHAZADA',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('no permite decidir dos veces', async () => {
        prisma.zoneChangeRequest.findUnique.mockResolvedValue({
          ...pending,
          status: ZoneChangeRequestStatus.APROBADA,
        });

        await expect(
          service.decideZoneChangeRequest(ADMIN_ID, REQUEST_ID, {
            decision: 'APROBADA',
          }),
        ).rejects.toBeInstanceOf(ConflictException);
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
});
