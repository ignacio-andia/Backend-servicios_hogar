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
  WorkerProfileStatus,
  ZoneChangeCancellationCause,
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
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from './active-work.registry.js';
import { ZONE_CHANGE_POLICY } from './worker-profile.rules.js';
import { ZoneChangeRequestsService } from './zone-change-requests.service.js';

const WORKER_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const ADMIN_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const PROFILE_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const ZONE_A = '11111111-1111-4111-8111-111111111111';
const ZONE_B = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

const account = (overrides: Partial<PublicUser> = {}): PublicUser => ({
  id: WORKER_ID,
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
const admin = account({
  id: ADMIN_ID,
  firstName: 'Ana',
  roles: [RoleName.ADMINISTRADOR],
});

const zone = (id: string, overrides: Partial<CatalogItem> = {}) => ({
  id,
  name: `Zona ${id.slice(0, 1)}`,
  description: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const profile = (
  status: WorkerProfileStatus = WorkerProfileStatus.APROBADO,
) => ({
  id: PROFILE_ID,
  userId: WORKER_ID,
  zoneId: ZONE_A,
  status,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  profileId: PROFILE_ID,
  fromZoneId: ZONE_A,
  toZoneId: ZONE_B,
  reason: 'Me mudé de barrio',
  status: ZoneChangeRequestStatus.PENDIENTE,
  createdAt: new Date(),
  decidedAt: null,
  decidedById: null,
  decisionComment: null,
  cancellationCause: null,
  profile: profile(),
  ...overrides,
});

const fns = <K extends string>(...names: K[]) =>
  Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
    K,
    ReturnType<typeof vi.fn>
  >;

describe('ZoneChangeRequestsService', () => {
  let prisma: {
    workerProfile: Record<
      'findUnique' | 'findUniqueOrThrow' | 'updateMany',
      ReturnType<typeof vi.fn>
    >;
    zoneChangeRequest: Record<
      | 'create'
      | 'count'
      | 'findFirst'
      | 'findMany'
      | 'findUnique'
      | 'updateMany',
      ReturnType<typeof vi.fn>
    >;
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let users: { findById: ReturnType<typeof vi.fn> };
  let catalogs: Record<
    | 'assertActive'
    | 'assertActiveForShare'
    | 'findById'
    | 'findByIds'
    | 'findByIdsForShare',
    ReturnType<typeof vi.fn>
  >;
  let audit: { record: ReturnType<typeof vi.fn> };
  let notifications: { create: ReturnType<typeof vi.fn> };
  let registry: WorkerActiveWorkRegistry;
  let activeCounts: Record<ActiveWorkKind, number>;
  let service: ZoneChangeRequestsService;

  const registerSources = () => {
    for (const kind of [ActiveWorkKind.PEDIDOS, ActiveWorkKind.OFERTAS]) {
      registry.register({
        kind,
        countActive: () => Promise.resolve(activeCounts[kind]),
      });
    }
  };

  beforeEach(() => {
    prisma = {
      workerProfile: fns('findUnique', 'findUniqueOrThrow', 'updateMany'),
      zoneChangeRequest: fns(
        'create',
        'count',
        'findFirst',
        'findMany',
        'findUnique',
        'updateMany',
      ),
      $transaction: vi.fn((work: unknown) =>
        typeof work === 'function'
          ? (work as (tx: unknown) => Promise<unknown>)(prisma)
          : Promise.all(work as Promise<unknown>[]),
      ),
      // lockWorker: SELECT ... FOR UPDATE dentro de la transaccion.
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    prisma.workerProfile.findUnique.mockResolvedValue(profile());
    prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(profile());
    prisma.workerProfile.updateMany.mockResolvedValue({ count: 1 });
    prisma.zoneChangeRequest.count.mockResolvedValue(0);
    prisma.zoneChangeRequest.findFirst.mockResolvedValue(null);
    prisma.zoneChangeRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.zoneChangeRequest.create.mockImplementation(({ data }) =>
      Promise.resolve({ ...request(), ...data, profile: undefined }),
    );
    users = {
      findById: vi.fn((id: string) =>
        Promise.resolve(id === ADMIN_ID ? admin : account()),
      ),
    };
    catalogs = fns(
      'assertActive',
      'assertActiveForShare',
      'findById',
      'findByIds',
      'findByIdsForShare',
    );
    catalogs.assertActiveForShare.mockImplementation((_tx, _k, id: string) =>
      Promise.resolve(zone(id)),
    );
    catalogs.findByIdsForShare.mockImplementation((_tx, _k, ids: string[]) =>
      Promise.resolve(ids.map((id) => zone(id))),
    );
    catalogs.assertActive.mockImplementation((_k, id: string) =>
      Promise.resolve(zone(id)),
    );
    catalogs.findById.mockImplementation((_k, id: string) =>
      Promise.resolve(zone(id)),
    );
    catalogs.findByIds.mockImplementation((_k, ids: string[]) =>
      Promise.resolve([...new Set(ids)].map((id) => zone(id))),
    );
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    notifications = { create: vi.fn().mockResolvedValue(undefined) };
    registry = new WorkerActiveWorkRegistry();
    activeCounts = { PEDIDOS: 0, OFERTAS: 0 };
    service = new ZoneChangeRequestsService(
      prisma as unknown as PrismaService,
      users as unknown as UsersService,
      catalogs as unknown as CatalogsService,
      audit as unknown as AuditService,
      registry,
      notifications as unknown as NotificationsService,
    );
  });

  const dto = { toZoneId: ZONE_B, reason: 'Me mudé de barrio' };

  describe('pedidos y ofertas activas', () => {
    it('sin las consultas de pedidos y ofertas bloquea la solicitud e informa el motivo', async () => {
      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          message: [
            'Por ahora no se puede verificar si tiene pedidos u ofertas activos, así que la solicitud de cambio de zona todavía no está disponible.',
          ],
        },
      });
      expect(prisma.zoneChangeRequest.create).not.toHaveBeenCalled();
    });

    it('con trabajo activo bloquea la solicitud e indica cuanto tiene', async () => {
      registerSources();
      activeCounts = { PEDIDOS: 1, OFERTAS: 2 };

      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).rejects.toMatchObject({
        response: {
          message: [
            'No puede solicitar un cambio de zona mientras tenga trabajo activo (1 pedidos y 2 ofertas activos).',
          ],
        },
      });
      expect(prisma.zoneChangeRequest.create).not.toHaveBeenCalled();
    });

    it('la consulta del trabajador muestra los mismos motivos', async () => {
      const status = await service.getOwnZoneStatus(WORKER_ID);

      expect(status).toMatchObject({
        currentZone: { id: ZONE_A },
        pendingRequest: null,
        canRequestChange: false,
        blockers: [{ code: 'VERIFICACION_NO_DISPONIBLE' }],
      });
    });
  });

  describe('requestZoneChange', () => {
    beforeEach(registerSources);

    it('crea una solicitud PENDIENTE con la zona actual como origen', async () => {
      const view = await service.requestZoneChange(WORKER_ID, dto);

      expect(prisma.zoneChangeRequest.create).toHaveBeenCalledWith({
        data: {
          profileId: PROFILE_ID,
          fromZoneId: ZONE_A,
          toZoneId: ZONE_B,
          reason: dto.reason,
        },
      });
      expect(view).toMatchObject({
        status: ZoneChangeRequestStatus.PENDIENTE,
        fromZone: { id: ZONE_A },
        toZone: { id: ZONE_B },
      });
      // La zona del perfil no se toca al solicitar.
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
    });

    it('rechaza pedir la zona actual', async () => {
      await expect(
        service.requestZoneChange(WORKER_ID, { ...dto, toZoneId: ZONE_A }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza zonas inactivas o inexistentes (CatalogsService.assertActive)', async () => {
      catalogs.assertActive.mockRejectedValueOnce(
        new BadRequestException('La zona seleccionada no está activa'),
      );
      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).rejects.toBeInstanceOf(BadRequestException);

      catalogs.assertActive.mockRejectedValueOnce(new NotFoundException());
      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(catalogs.assertActive).toHaveBeenCalledWith(
        CatalogKind.ZONE,
        ZONE_B,
      );
    });

    it('no admite una segunda solicitud pendiente', async () => {
      prisma.zoneChangeRequest.count.mockResolvedValue(1);

      await expect(service.requestZoneChange(WORKER_ID, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.zoneChangeRequest.create).not.toHaveBeenCalled();
    });

    it('si dos llegan a la vez, el indice unico parcial responde 409', async () => {
      prisma.zoneChangeRequest.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.requestZoneChange(WORKER_ID, dto)).rejects.toThrow(
        'Ya tiene una solicitud de cambio de zona pendiente',
      );
    });

    it('en BORRADOR la zona se elige directamente, sin solicitud', async () => {
      prisma.workerProfile.findUnique.mockResolvedValue(
        profile(WorkerProfileStatus.BORRADOR),
      );

      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).rejects.toMatchObject({
        status: 409,
      });
    });

    it.each([
      WorkerProfileStatus.PENDIENTE,
      WorkerProfileStatus.OBSERVADO,
      WorkerProfileStatus.RECHAZADO,
      WorkerProfileStatus.SUSPENDIDO,
    ])('un perfil %s no puede pedir el cambio (T4.2)', async (status) => {
      prisma.workerProfile.findUnique.mockResolvedValue(profile(status));

      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          message: [
            `No se puede solicitar un cambio de zona con el perfil en estado ${status}`,
          ],
        },
      });
      expect(prisma.zoneChangeRequest.create).not.toHaveBeenCalled();
    });

    it('un perfil APROBADO puede pedirlo', async () => {
      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).resolves.toMatchObject({ status: ZoneChangeRequestStatus.PENDIENTE });
    });

    it('vuelve a validar la zona destino con bloqueo dentro de la transaccion', async () => {
      catalogs.assertActiveForShare.mockRejectedValueOnce(
        new BadRequestException('La zona seleccionada no está activa'),
      );

      await expect(
        service.requestZoneChange(WORKER_ID, dto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(catalogs.assertActiveForShare).toHaveBeenCalledWith(
        prisma,
        CatalogKind.ZONE,
        ZONE_B,
      );
      // Despues del bloqueo del trabajador (orden: trabajador y luego catalogos).
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        catalogs.assertActiveForShare.mock.invocationCallOrder[0],
      );
      expect(prisma.zoneChangeRequest.create).not.toHaveBeenCalled();
    });

    it('verifica y registra con la fila del trabajador bloqueada', async () => {
      await service.requestZoneChange(WORKER_ID, dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw.mock.calls[0][1]).toBe(WORKER_ID);
      // El bloqueo ocurre antes de contar pendientes y de crear la solicitud.
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.zoneChangeRequest.count.mock.invocationCallOrder[0],
      );
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.zoneChangeRequest.create.mock.invocationCallOrder[0],
      );
    });
  });

  describe('decide', () => {
    beforeEach(() => {
      prisma.zoneChangeRequest.findUnique.mockResolvedValue(request());
    });

    it('al aprobar, la nueva zona reemplaza a la anterior y queda en la bitacora', async () => {
      await service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' });

      expect(prisma.zoneChangeRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: ZoneChangeRequestStatus.PENDIENTE },
        data: expect.objectContaining({
          status: ZoneChangeRequestStatus.APROBADA,
          decidedById: ADMIN_ID,
          decisionComment: null,
        }),
      });
      expect(prisma.workerProfile.updateMany).toHaveBeenCalledWith({
        where: { id: PROFILE_ID, zoneId: ZONE_A },
        data: { zoneId: ZONE_B },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: ADMIN_ID,
          action: AuditAction.APROBACION,
          entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
          entityId: REQUEST_ID,
        }),
        prisma,
      );
    });

    it('al rechazar, el perfil conserva su zona', async () => {
      await service.decide(ADMIN_ID, REQUEST_ID, {
        decision: 'RECHAZADA',
        comment: 'Sin cobertura',
      });

      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.RECHAZO,
        details: { comment: 'Sin cobertura' },
      });
    });

    it.each([undefined, '', '   '])(
      'rechazar sin motivo (%j) responde 400 y no resuelve la solicitud',
      async (comment) => {
        expect(ZONE_CHANGE_POLICY.rejectionCommentRequired).toBe(true);

        await expect(
          service.decide(ADMIN_ID, REQUEST_ID, {
            decision: 'RECHAZADA',
            comment,
          }),
        ).rejects.toThrow(
          new BadRequestException('Debe indicar el motivo del rechazo'),
        );
        expect(prisma.zoneChangeRequest.updateMany).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
        expect(notifications.create).not.toHaveBeenCalled();
      },
    );

    it('el comentario es opcional al aprobar', async () => {
      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).resolves.toBeDefined();
    });

    it('audita estado anterior y nuevo y notifica al trabajador al rechazar', async () => {
      await service.decide(ADMIN_ID, REQUEST_ID, {
        decision: 'RECHAZADA',
        comment: '  Sin cobertura  ',
      });

      expect(audit.record).toHaveBeenCalledWith(
        {
          actorId: ADMIN_ID,
          action: AuditAction.RECHAZO,
          entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
          entityId: REQUEST_ID,
          details: {
            profileId: PROFILE_ID,
            workerUserId: WORKER_ID,
            fromZoneId: ZONE_A,
            toZoneId: ZONE_B,
            fromStatus: ZoneChangeRequestStatus.PENDIENTE,
            toStatus: ZoneChangeRequestStatus.RECHAZADA,
            comment: 'Sin cobertura',
          },
        },
        prisma,
      );
      expect(notifications.create).toHaveBeenCalledTimes(1);
      const [recipient, notification, db] = notifications.create.mock
        .calls[0] as [string, { type: string; message: string }, unknown];
      expect(recipient).toBe(WORKER_ID);
      expect(db).toBe(prisma);
      expect(notification).toMatchObject({
        type: NotificationType.SOLICITUD_ZONA_RECHAZADA,
        resource: {
          type: NotificationResourceType.SOLICITUD_CAMBIO_ZONA,
          id: REQUEST_ID,
        },
      });
      expect(notification.message).toBe(
        'Su solicitud de cambio a la zona "Zona 2" fue rechazada. Conserva su zona "Zona 1". Motivo: Sin cobertura',
      );
    });

    it('al aprobar notifica la nueva zona al trabajador', async () => {
      await service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' });

      expect(notifications.create).toHaveBeenCalledWith(
        WORKER_ID,
        expect.objectContaining({
          type: NotificationType.SOLICITUD_ZONA_APROBADA,
          message:
            'Su solicitud de cambio de zona fue aprobada. Su nueva zona de atención es "Zona 2".',
        }),
        prisma,
      );
      expect(audit.record.mock.calls[0][0].details).toMatchObject({
        fromStatus: ZoneChangeRequestStatus.PENDIENTE,
        toStatus: ZoneChangeRequestStatus.APROBADA,
      });
    });

    it.each([WorkerProfileStatus.SUSPENDIDO, WorkerProfileStatus.RECHAZADO])(
      'no aprueba si el perfil esta %s (se relee con el bloqueo)',
      async (status) => {
        prisma.workerProfile.findUniqueOrThrow.mockResolvedValue(
          profile(status),
        );

        await expect(
          service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
        ).rejects.toThrow(
          new ConflictException(
            `No se puede aprobar: el perfil del trabajador está en estado ${status}`,
          ),
        );
        expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          prisma.workerProfile.findUniqueOrThrow.mock.invocationCallOrder[0],
        );
        expect(prisma.zoneChangeRequest.updateMany).not.toHaveBeenCalled();
        expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
        expect(notifications.create).not.toHaveBeenCalled();
      },
    );

    it('si otra decision gano (concurrencia), responde 409 sin auditar ni notificar', async () => {
      prisma.zoneChangeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).rejects.toThrow('La solicitud ya fue resuelta');
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('si la notificacion falla, la decision falla (misma transaccion)', async () => {
      notifications.create.mockRejectedValue(new Error('sin conexion'));

      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).rejects.toThrow('sin conexion');
    });

    it('solo un administrador activo decide', async () => {
      await expect(
        service.decide(WORKER_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.zoneChangeRequest.updateMany).not.toHaveBeenCalled();
    });

    it('un administrador no resuelve su propia solicitud', async () => {
      prisma.zoneChangeRequest.findUnique.mockResolvedValue(
        request({ profile: { ...profile(), userId: ADMIN_ID } }),
      );

      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).rejects.toThrow(
        'No puede resolver su propia solicitud de cambio de zona',
      );
    });

    it('no permite decidir dos veces', async () => {
      prisma.zoneChangeRequest.findUnique.mockResolvedValue(
        request({ status: ZoneChangeRequestStatus.RECHAZADA }),
      );

      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).rejects.toThrow('La solicitud ya fue resuelta');
    });

    it('no aprueba si la zona solicitada fue desactivada e indica que se rechace', async () => {
      catalogs.findByIdsForShare.mockResolvedValue([
        zone(ZONE_B, { name: 'Zona Norte', isActive: false }),
      ]);

      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).rejects.toThrow(
        new ConflictException(
          'No se puede aprobar: la zona solicitada "Zona Norte" fue desactivada. Rechace la solicitud para que el trabajador pueda pedir otra zona.',
        ),
      );
      expect(prisma.zoneChangeRequest.updateMany).not.toHaveBeenCalled();
    });

    it('con la zona solicitada desactivada, rechazar sigue siendo posible', async () => {
      catalogs.findByIdsForShare.mockResolvedValue([
        zone(ZONE_B, { isActive: false }),
      ]);

      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, {
          decision: 'RECHAZADA',
          comment: 'Zona sin cobertura',
        }),
      ).resolves.toBeDefined();
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
    });

    it('decide con la fila del trabajador bloqueada', async () => {
      await service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' });

      expect(prisma.$queryRaw.mock.calls[0][1]).toBe(WORKER_ID);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.zoneChangeRequest.updateMany.mock.invocationCallOrder[0],
      );
    });

    describe('segunda verificacion de pedidos y ofertas al aprobar', () => {
      const withRecheck = async (work: () => Promise<void>) => {
        const original = ZONE_CHANGE_POLICY.recheckActiveWorkOnApproval;
        ZONE_CHANGE_POLICY.recheckActiveWorkOnApproval = true;
        try {
          await work();
        } finally {
          ZONE_CHANGE_POLICY.recheckActiveWorkOnApproval = original;
        }
      };

      it('esta desactivada mientras el docente no lo confirme', async () => {
        expect(ZONE_CHANGE_POLICY.recheckActiveWorkOnApproval).toBe(false);

        await expect(
          service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
        ).resolves.toBeDefined();
      });

      it('activada y sin las consultas registradas, no aprueba ni simula datos', () =>
        withRecheck(async () => {
          await expect(
            service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
          ).rejects.toThrow(
            'No se puede aprobar: no es posible verificar si el trabajador tiene pedidos u ofertas activos.',
          );
          expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
        }));

      it('activada y con trabajo activo, no aprueba', () =>
        withRecheck(async () => {
          registerSources();
          activeCounts = { PEDIDOS: 1, OFERTAS: 0 };

          await expect(
            service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
          ).rejects.toThrow(
            'No se puede aprobar: el trabajador tiene trabajo activo (1 pedidos activos).',
          );
        }));

      it('activada y sin trabajo activo, aprueba; nunca se aplica al rechazar', () =>
        withRecheck(async () => {
          await expect(
            service.decide(ADMIN_ID, REQUEST_ID, {
              decision: 'RECHAZADA',
              comment: 'Sin cobertura',
            }),
          ).resolves.toBeDefined();

          registerSources();
          prisma.zoneChangeRequest.findUnique.mockResolvedValue(request());
          await expect(
            service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
          ).resolves.toBeDefined();
          expect(prisma.workerProfile.updateMany).toHaveBeenCalled();
        }));
    });

    it('responde 404 si la solicitud no existe', async () => {
      prisma.zoneChangeRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.decide(ADMIN_ID, REQUEST_ID, { decision: 'APROBADA' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listForAdmin', () => {
    it('combina filtros, pagina e incluye datos del trabajador y zonas', async () => {
      prisma.zoneChangeRequest.findMany.mockResolvedValue([
        request({
          status: ZoneChangeRequestStatus.RECHAZADA,
          decidedAt: new Date(),
          decidedById: ADMIN_ID,
        }),
      ]);
      prisma.zoneChangeRequest.count.mockResolvedValue(21);

      const result = await service.listForAdmin({
        resolved: true,
        workerUserId: WORKER_ID,
        page: 2,
        limit: 10,
      });

      expect(prisma.zoneChangeRequest.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          AND: [
            { status: { not: ZoneChangeRequestStatus.PENDIENTE } },
            { profile: { userId: WORKER_ID } },
          ],
        },
        skip: 10,
        take: 10,
      });
      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        total: 21,
        totalPages: 3,
      });
      expect(result.data[0]).toMatchObject({
        worker: {
          userId: WORKER_ID,
          profileId: PROFILE_ID,
          email: 'juan@example.com',
          profileStatus: WorkerProfileStatus.APROBADO,
          currentZone: { id: ZONE_A },
        },
        decidedBy: { id: ADMIN_ID, firstName: 'Ana' },
        fromZone: { id: ZONE_A },
        toZone: { id: ZONE_B },
      });
    });
  });

  describe('cancelPendingOnSuspension (T4.2)', () => {
    const owner = { id: PROFILE_ID, userId: WORKER_ID };

    it('sin solicitud pendiente no escribe nada', async () => {
      await expect(
        service.cancelPendingOnSuspension(prisma as never, ADMIN_ID, owner),
      ).resolves.toBe(false);
      expect(prisma.zoneChangeRequest.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('cancela la pendiente sin rechazarla, la audita y avisa al trabajador', async () => {
      prisma.zoneChangeRequest.findFirst.mockResolvedValue(request());

      await expect(
        service.cancelPendingOnSuspension(prisma as never, ADMIN_ID, owner),
      ).resolves.toBe(true);

      expect(prisma.zoneChangeRequest.findFirst).toHaveBeenCalledWith({
        where: {
          profileId: PROFILE_ID,
          status: ZoneChangeRequestStatus.PENDIENTE,
        },
      });
      expect(prisma.zoneChangeRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: ZoneChangeRequestStatus.PENDIENTE },
        data: {
          status: ZoneChangeRequestStatus.CANCELADA,
          cancellationCause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
          decidedAt: expect.any(Date),
          decidedById: ADMIN_ID,
        },
      });
      // La zona del perfil no cambia.
      expect(prisma.workerProfile.updateMany).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        {
          actorId: ADMIN_ID,
          action: AuditAction.CAMBIO_ESTADO,
          entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
          entityId: REQUEST_ID,
          details: {
            profileId: PROFILE_ID,
            workerUserId: WORKER_ID,
            fromZoneId: ZONE_A,
            toZoneId: ZONE_B,
            fromStatus: ZoneChangeRequestStatus.PENDIENTE,
            toStatus: ZoneChangeRequestStatus.CANCELADA,
            cause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
          },
        },
        prisma,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        WORKER_ID,
        {
          type: NotificationType.SOLICITUD_ZONA_CANCELADA,
          title: 'Solicitud de cambio de zona cancelada',
          message:
            'Su solicitud de cambio a la zona "Zona 2" se canceló porque su perfil de trabajador fue suspendido. Conserva su zona "Zona 1".',
          resource: {
            type: NotificationResourceType.SOLICITUD_CAMBIO_ZONA,
            id: REQUEST_ID,
          },
        },
        prisma,
      );
    });

    it('si ya se resolvio, no audita ni notifica', async () => {
      prisma.zoneChangeRequest.findFirst.mockResolvedValue(request());
      prisma.zoneChangeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.cancelPendingOnSuspension(prisma as never, ADMIN_ID, owner),
      ).resolves.toBe(false);
      expect(audit.record).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('propaga los errores para revertir la suspension', async () => {
      prisma.zoneChangeRequest.findFirst.mockResolvedValue(request());
      notifications.create.mockRejectedValue(new Error('sin conexion'));

      await expect(
        service.cancelPendingOnSuspension(prisma as never, ADMIN_ID, owner),
      ).rejects.toThrow('sin conexion');
    });
  });
});
