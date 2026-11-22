import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import {
  AuditAction,
  AuditEntityType,
  NotificationResourceType,
  NotificationType,
  RoleName,
  UserStatus,
  WeekDay,
  WorkerProfileStatus,
  ZoneChangeCancellationCause,
  ZoneChangeRequestStatus,
} from '../src/generated/prisma/client.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from '../src/modules/catalogs/catalogs.service.js';
import {
  NewNotification,
  NotificationsService,
} from '../src/modules/notifications/notifications.service.js';
import {
  PublicUser,
  UsersService,
} from '../src/modules/users/users.service.js';
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from '../src/modules/worker-profile/active-work.registry.js';
import { WorkerProfileService } from '../src/modules/worker-profile/worker-profile.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deleteWorkerData } from './utils/worker-profile-cleanup.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@zone-e2e.test';
const BASE = '/api/worker-profile';

interface Worker {
  user: PublicUser;
  profileId: string;
}

describe('Cambio de zona: validaciones y decisiones (T4.2, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let users: UsersService;
  let profiles: WorkerProfileService;
  let notifications: NotificationsService;

  let admin: PublicUser;
  let inactiveAdmin: PublicUser;
  let client: PublicUser;
  let category: CatalogItem;
  let zoneA: CatalogItem;
  let zoneB: CatalogItem;
  let zoneC: CatalogItem;
  let zoneOff: CatalogItem;
  const created: PublicUser[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const newUser = async (name: string) => {
    const user = await users.create({
      firstName: name,
      lastName: 'E2E',
      email: `${name}-${RUN_ID}${EMAIL_DOMAIN}`,
      passwordHash: 'hash',
      phone: '70000031',
    });
    created.push(user);
    return user;
  };
  const addRole = async (user: PublicUser, role: RoleName) => {
    await prisma.userRole.create({ data: { userId: user.id, role } });
    return users.findById(user.id);
  };
  /** Perfil en BORRADOR; con `until` lo lleva hasta ese estado. */
  const newWorker = async (
    name: string,
    until: WorkerProfileStatus = WorkerProfileStatus.APROBADO,
  ): Promise<Worker> => {
    const user = await newUser(name);
    const profile = await profiles.create(user.id, {
      yearsOfExperience: 4,
      zoneId: zoneA.id,
      categoryIds: [category.id],
      schedules: [
        { dayOfWeek: WeekDay.LUNES, startTime: '08:00', endTime: '12:00' },
      ],
    });
    const to = (status: WorkerProfileStatus, reason?: string) =>
      profiles.changeStatusByAdmin(admin.id, profile.id, { status, reason });
    if (until !== WorkerProfileStatus.BORRADOR) {
      await profiles.submit(user.id);
    }
    if (
      until === WorkerProfileStatus.OBSERVADO ||
      until === WorkerProfileStatus.RECHAZADO
    ) {
      await to(until, 'Motivo de prueba');
    }
    if (
      until === WorkerProfileStatus.APROBADO ||
      until === WorkerProfileStatus.SUSPENDIDO
    ) {
      await to(WorkerProfileStatus.APROBADO);
    }
    if (until === WorkerProfileStatus.SUSPENDIDO) {
      await to(WorkerProfileStatus.SUSPENDIDO, 'Motivo de prueba');
    }
    return { user: await users.findById(user.id), profileId: profile.id };
  };
  const requestChange = (
    worker: Worker,
    toZoneId = zoneB.id,
    reason = 'Me mudé de barrio',
  ) =>
    http()
      .post(`${BASE}/me/zone-change-requests`)
      .set('Authorization', auth(worker.user))
      .send({ toZoneId, reason });
  const decide = (requestId: string, body: object, user = admin) =>
    http()
      .patch(`${BASE}/admin/zone-change-requests/${requestId}`)
      .set('Authorization', auth(user))
      .send(body);
  const suspend = (worker: Worker, reason = 'Reclamos reiterados') =>
    http()
      .patch(`${BASE}/admin/profiles/${worker.profileId}/status`)
      .set('Authorization', auth(admin))
      .send({ status: WorkerProfileStatus.SUSPENDIDO, reason });
  const requestRow = (id: string) =>
    prisma.zoneChangeRequest.findUniqueOrThrow({ where: { id } });
  const zoneOf = async (worker: Worker) =>
    (
      await prisma.workerProfile.findUniqueOrThrow({
        where: { id: worker.profileId },
      })
    ).zoneId;
  const requestNotifications = (worker: Worker, requestId: string) =>
    prisma.notification.findMany({
      where: { userId: worker.user.id, resourceId: requestId },
    });
  const requestAudit = (requestId: string) =>
    prisma.adminAuditLog.findMany({
      where: {
        entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
        entityId: requestId,
      },
    });
  /** Solicitud pendiente de un trabajador APROBADO nuevo. */
  const pendingRequest = async (name: string) => {
    const worker = await newWorker(name);
    const res = await requestChange(worker).expect(201);
    return { worker, requestId: res.body.id as string };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    users = app.get(UsersService);
    profiles = app.get(WorkerProfileService);
    notifications = app.get(NotificationsService);
    // El modulo de ofertas todavia no existe (T4.2 no integra OFERTAS): solo
    // esta instancia de prueba registra una fuente sin ofertas activas.
    app.get(WorkerActiveWorkRegistry).register({
      kind: ActiveWorkKind.OFERTAS,
      countActive: () => Promise.resolve(0),
    });

    admin = await addRole(await newUser('admin'), RoleName.ADMINISTRADOR);
    inactiveAdmin = await addRole(
      await newUser('admin-inactivo'),
      RoleName.ADMINISTRADOR,
    );
    await prisma.user.update({
      where: { id: inactiveAdmin.id },
      data: { status: UserStatus.INACTIVO },
    });
    client = await newUser('cliente');

    const catalogs = app.get(CatalogsService);
    const newZone = (name: string) =>
      catalogs.create(CatalogKind.ZONE, admin.id, {
        name: `${name} ${RUN_ID}`,
      });
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Categoria zona ${RUN_ID}`,
    });
    zoneA = await newZone('Zona A');
    zoneB = await newZone('Zona B');
    zoneC = await newZone('Zona C');
    zoneOff = await newZone('Zona Off');
    await catalogs.deactivate(CatalogKind.ZONE, admin.id, zoneOff.id);
  });

  afterAll(async () => {
    const ids = created.map((user) => user.id);
    await deleteWorkerData(prisma, ids);
    await prisma.serviceCategory.deleteMany({
      where: { name: { contains: RUN_ID } },
    });
    await prisma.zone.deleteMany({ where: { name: { contains: RUN_ID } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('solicitud', () => {
    it('un perfil APROBADO solicita; su zona no cambia hasta la aprobación', async () => {
      const worker = await newWorker('aprobado');

      const res = await requestChange(worker).expect(201);

      expect(res.body).toMatchObject({
        status: ZoneChangeRequestStatus.PENDIENTE,
        fromZone: { id: zoneA.id },
        toZone: { id: zoneB.id },
        cancellationCause: null,
      });
      expect(await zoneOf(worker)).toBe(zoneA.id);
    });

    it.each([
      [
        WorkerProfileStatus.BORRADOR,
        'Su perfil aún no fue enviado a revisión: puede elegir la zona directamente al editar el perfil.',
      ],
      [
        WorkerProfileStatus.PENDIENTE,
        'No se puede solicitar un cambio de zona con el perfil en estado PENDIENTE',
      ],
      [
        WorkerProfileStatus.OBSERVADO,
        'No se puede solicitar un cambio de zona con el perfil en estado OBSERVADO',
      ],
      [
        WorkerProfileStatus.RECHAZADO,
        'No se puede solicitar un cambio de zona con el perfil en estado RECHAZADO',
      ],
      [
        WorkerProfileStatus.SUSPENDIDO,
        'No se puede solicitar un cambio de zona con el perfil en estado SUSPENDIDO',
      ],
    ])('un perfil %s no puede solicitar (409)', async (status, message) => {
      const worker = await newWorker(`estado-${status.toLowerCase()}`, status);

      const res = await requestChange(worker).expect(409);

      expect(res.body.message).toEqual([message]);
      expect(
        await prisma.zoneChangeRequest.count({
          where: { profileId: worker.profileId },
        }),
      ).toBe(0);
    });

    it('valida la zona destino: inactiva, inexistente o la actual', async () => {
      const worker = await newWorker('zona-destino');

      await requestChange(worker, zoneOff.id).expect(400);
      await requestChange(worker, randomUUID()).expect(404);
      const same = await requestChange(worker, zoneA.id).expect(400);
      expect(same.body.message).toBe('La zona solicitada es su zona actual');
      expect(
        await prisma.zoneChangeRequest.count({
          where: { profileId: worker.profileId },
        }),
      ).toBe(0);
    });

    it('no admite otra solicitud mientras haya una pendiente', async () => {
      const { worker } = await pendingRequest('duplicada');

      const res = await requestChange(worker, zoneC.id).expect(409);

      expect(res.body.message).toEqual([
        'Ya tiene una solicitud de cambio de zona pendiente',
      ]);
    });
  });

  describe('decisión administrativa', () => {
    it('solo un administrador activo decide (401 o 403)', async () => {
      const { worker, requestId } = await pendingRequest('no-autorizado');
      const body = { decision: 'APROBADA' };

      await http()
        .patch(`${BASE}/admin/zone-change-requests/${requestId}`)
        .send(body)
        .expect(401);
      await decide(requestId, body, inactiveAdmin).expect(401);
      await decide(requestId, body, client).expect(403);
      await decide(requestId, body, worker.user).expect(403);
      expect((await requestRow(requestId)).status).toBe(
        ZoneChangeRequestStatus.PENDIENTE,
      );
    });

    it('un administrador no decide sobre su propia solicitud', async () => {
      const own = await newWorker('admin-trabajador');
      const ownAdmin = await addRole(own.user, RoleName.ADMINISTRADOR);
      const res = await requestChange({ ...own, user: ownAdmin }).expect(201);

      const denied = await decide(
        res.body.id,
        { decision: 'APROBADA' },
        ownAdmin,
      ).expect(403);
      expect(denied.body.message).toBe(
        'No puede resolver su propia solicitud de cambio de zona',
      );
      expect((await requestRow(res.body.id)).status).toBe(
        ZoneChangeRequestStatus.PENDIENTE,
      );
      // Otro administrador si puede.
      await decide(res.body.id, { decision: 'APROBADA' }).expect(200);
    });

    it('rechazar sin motivo o con un motivo vacío responde 400', async () => {
      const { worker, requestId } = await pendingRequest('rechazo-sin-motivo');

      for (const body of [
        { decision: 'RECHAZADA' },
        { decision: 'RECHAZADA', comment: '   ' },
      ]) {
        const res = await decide(requestId, body).expect(400);
        expect(res.body.message).toBe('Debe indicar el motivo del rechazo');
      }
      expect((await requestRow(requestId)).status).toBe(
        ZoneChangeRequestStatus.PENDIENTE,
      );
      expect(await requestAudit(requestId)).toHaveLength(0);
      expect(await requestNotifications(worker, requestId)).toHaveLength(0);
    });

    it('rechazar con motivo conserva la zona, audita y notifica el motivo', async () => {
      const { worker, requestId } = await pendingRequest('rechazo-con-motivo');

      const res = await decide(requestId, {
        decision: 'RECHAZADA',
        comment: '  Zona sin cobertura  ',
      }).expect(200);

      expect(res.body).toMatchObject({
        status: ZoneChangeRequestStatus.RECHAZADA,
        decisionComment: 'Zona sin cobertura',
        decidedBy: { id: admin.id },
        cancellationCause: null,
      });
      expect(await zoneOf(worker)).toBe(zoneA.id);
      const [log, ...more] = await requestAudit(requestId);
      expect(more).toHaveLength(0);
      expect(log).toMatchObject({
        actorId: admin.id,
        action: AuditAction.RECHAZO,
        details: {
          profileId: worker.profileId,
          workerUserId: worker.user.id,
          fromZoneId: zoneA.id,
          toZoneId: zoneB.id,
          fromStatus: ZoneChangeRequestStatus.PENDIENTE,
          toStatus: ZoneChangeRequestStatus.RECHAZADA,
          comment: 'Zona sin cobertura',
        },
      });
      expect(log.createdAt).toBeInstanceOf(Date);
      const [notification, ...others] = await requestNotifications(
        worker,
        requestId,
      );
      expect(others).toHaveLength(0);
      expect(notification).toMatchObject({
        type: NotificationType.SOLICITUD_ZONA_RECHAZADA,
        resourceType: NotificationResourceType.SOLICITUD_CAMBIO_ZONA,
        message: `Su solicitud de cambio a la zona "${zoneB.name}" fue rechazada. Conserva su zona "${zoneA.name}". Motivo: Zona sin cobertura`,
      });
    });

    it('aprobar cambia la zona, audita y notifica al trabajador', async () => {
      const { worker, requestId } = await pendingRequest('aprobacion');

      await decide(requestId, { decision: 'APROBADA' }).expect(200);

      expect(await zoneOf(worker)).toBe(zoneB.id);
      const me = await http()
        .get(`${BASE}/me/zone`)
        .set('Authorization', auth(worker.user))
        .expect(200);
      expect(me.body).toMatchObject({
        currentZone: { id: zoneB.id },
        pendingRequest: null,
      });
      const [log] = await requestAudit(requestId);
      expect(log).toMatchObject({
        action: AuditAction.APROBACION,
        details: {
          fromStatus: ZoneChangeRequestStatus.PENDIENTE,
          toStatus: ZoneChangeRequestStatus.APROBADA,
          comment: null,
        },
      });
      const notifications = await requestNotifications(worker, requestId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        type: NotificationType.SOLICITUD_ZONA_APROBADA,
        message: `Su solicitud de cambio de zona fue aprobada. Su nueva zona de atención es "${zoneB.name}".`,
      });
      // Una segunda decision no duplica nada.
      await decide(requestId, {
        decision: 'RECHAZADA',
        comment: 'Tarde',
      }).expect(409);
      expect(await requestNotifications(worker, requestId)).toHaveLength(1);
      expect(await requestAudit(requestId)).toHaveLength(1);
    });

    it.each([WorkerProfileStatus.SUSPENDIDO, WorkerProfileStatus.RECHAZADO])(
      'no aprueba la solicitud de un perfil %s (datos de la política anterior)',
      async (status) => {
        // Antes de T4.2 se podia pedir el cambio desde otros estados: se simula
        // una solicitud pendiente heredada de un perfil que hoy esta en `status`.
        const worker = await newWorker(
          `heredada-${status.toLowerCase()}`,
          status,
        );
        const legacy = await prisma.zoneChangeRequest.create({
          data: {
            profileId: worker.profileId,
            fromZoneId: zoneA.id,
            toZoneId: zoneB.id,
            reason: 'Solicitud anterior a T4.2',
          },
        });

        const res = await decide(legacy.id, { decision: 'APROBADA' }).expect(
          409,
        );

        expect(res.body.message).toBe(
          `No se puede aprobar: el perfil del trabajador está en estado ${status}`,
        );
        expect((await requestRow(legacy.id)).status).toBe(
          ZoneChangeRequestStatus.PENDIENTE,
        );
        expect(await zoneOf(worker)).toBe(zoneA.id);
        // Rechazarla, con motivo, si es posible.
        await decide(legacy.id, {
          decision: 'RECHAZADA',
          comment: `El perfil está ${status}`,
        }).expect(200);
      },
    );
  });

  describe('suspensión con una solicitud pendiente', () => {
    it('cancela la solicitud sin rechazarla, conserva el historial y la zona', async () => {
      const { worker, requestId } = await pendingRequest(
        'suspendido-pendiente',
      );

      await suspend(worker).expect(200);

      const row = await requestRow(requestId);
      expect(row).toMatchObject({
        status: ZoneChangeRequestStatus.CANCELADA,
        cancellationCause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
        decidedById: admin.id,
        decisionComment: null,
        fromZoneId: zoneA.id,
        toZoneId: zoneB.id,
        reason: 'Me mudé de barrio',
      });
      expect(row.decidedAt).toBeInstanceOf(Date);
      expect(await zoneOf(worker)).toBe(zoneA.id);

      // Bitacora: un cambio de estado de la solicitud, no un rechazo.
      const logs = await requestAudit(requestId);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        actorId: admin.id,
        action: AuditAction.CAMBIO_ESTADO,
        details: {
          fromStatus: ZoneChangeRequestStatus.PENDIENTE,
          toStatus: ZoneChangeRequestStatus.CANCELADA,
          cause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
        },
      });

      // El trabajador recibe la suspension y la cancelacion, una vez cada una.
      const received = await prisma.notification.findMany({
        where: { userId: worker.user.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        received
          .map((n) => n.type)
          .filter(
            (type) =>
              type === NotificationType.PERFIL_SUSPENDIDO ||
              type === NotificationType.SOLICITUD_ZONA_CANCELADA,
          )
          .sort(),
      ).toEqual(
        [
          NotificationType.PERFIL_SUSPENDIDO,
          NotificationType.SOLICITUD_ZONA_CANCELADA,
        ].sort(),
      );
      const [cancelled] = await requestNotifications(worker, requestId);
      expect(cancelled.message).toBe(
        `Su solicitud de cambio a la zona "${zoneB.name}" se canceló porque su perfil de trabajador fue suspendido. Conserva su zona "${zoneA.name}".`,
      );

      // El historial sigue visible para el trabajador y el administrador.
      const own = await http()
        .get(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker.user))
        .expect(200);
      expect(own.body).toMatchObject([
        {
          id: requestId,
          status: ZoneChangeRequestStatus.CANCELADA,
          cancellationCause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
        },
      ]);
      const listed = await http()
        .get(`${BASE}/admin/zone-change-requests`)
        .query({ status: 'CANCELADA', workerUserId: worker.user.id })
        .set('Authorization', auth(admin))
        .expect(200);
      expect(listed.body.data).toMatchObject([
        { id: requestId, decidedBy: { id: admin.id } },
      ]);

      // Ya no se puede decidir sobre ella.
      const late = await decide(requestId, { decision: 'APROBADA' }).expect(
        409,
      );
      expect(late.body.message).toBe('La solicitud ya fue resuelta');
    });

    it('sin solicitud pendiente, suspender no cancela ni notifica nada de zona', async () => {
      const worker = await newWorker('suspendido-sin-solicitud');

      await suspend(worker).expect(200);

      expect(
        await prisma.notification.count({
          where: {
            userId: worker.user.id,
            type: NotificationType.SOLICITUD_ZONA_CANCELADA,
          },
        }),
      ).toBe(0);
    });
  });

  describe('fallos transaccionales', () => {
    it('si falla la notificación, la aprobación no se confirma', async () => {
      const { worker, requestId } = await pendingRequest('falla-aprobacion');
      vi.spyOn(notifications, 'create').mockRejectedValueOnce(
        new Error('falla simulada de notificaciones'),
      );

      await decide(requestId, { decision: 'APROBADA' }).expect(500);

      expect((await requestRow(requestId)).status).toBe(
        ZoneChangeRequestStatus.PENDIENTE,
      );
      expect(await zoneOf(worker)).toBe(zoneA.id);
      expect(await requestAudit(requestId)).toHaveLength(0);
      expect(await requestNotifications(worker, requestId)).toHaveLength(0);
    });

    it('si falla la cancelación, la suspensión tampoco se confirma', async () => {
      const { worker, requestId } = await pendingRequest('falla-suspension');
      const historyBefore = await prisma.workerProfileStatusHistory.count({
        where: { profileId: worker.profileId },
      });
      const original = notifications.create.bind(notifications);
      vi.spyOn(notifications, 'create').mockImplementation(
        (userId: string, notification: NewNotification, db) =>
          notification.type === NotificationType.SOLICITUD_ZONA_CANCELADA
            ? Promise.reject(new Error('falla simulada de notificaciones'))
            : original(userId, notification, db),
      );

      await suspend(worker).expect(500);

      const profile = await prisma.workerProfile.findUniqueOrThrow({
        where: { id: worker.profileId },
      });
      expect(profile.status).toBe(WorkerProfileStatus.APROBADO);
      expect((await requestRow(requestId)).status).toBe(
        ZoneChangeRequestStatus.PENDIENTE,
      );
      expect(
        await prisma.workerProfileStatusHistory.count({
          where: { profileId: worker.profileId },
        }),
      ).toBe(historyBefore);
      expect(
        await prisma.notification.count({
          where: {
            userId: worker.user.id,
            type: NotificationType.PERFIL_SUSPENDIDO,
          },
        }),
      ).toBe(0);
    });
  });

  describe('decisiones simultáneas', () => {
    it('aprobar y rechazar a la vez: solo una gana, sin duplicados', async () => {
      const { worker, requestId } = await pendingRequest('simultanea');

      const responses = await Promise.all([
        decide(requestId, { decision: 'APROBADA' }),
        decide(requestId, { decision: 'RECHAZADA', comment: 'Simultánea' }),
      ]);

      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      const winner = responses.find((r) => r.status === 200)!.body
        .status as ZoneChangeRequestStatus;
      expect((await requestRow(requestId)).status).toBe(winner);
      expect(await zoneOf(worker)).toBe(
        winner === ZoneChangeRequestStatus.APROBADA ? zoneB.id : zoneA.id,
      );
      expect(await requestAudit(requestId)).toHaveLength(1);
      expect(await requestNotifications(worker, requestId)).toHaveLength(1);
    });

    it('suspender y aprobar a la vez deja un resultado consistente', async () => {
      const { worker, requestId } = await pendingRequest(
        'suspension-simultanea',
      );

      const [suspension, approval] = await Promise.all([
        suspend(worker),
        decide(requestId, { decision: 'APROBADA' }),
      ]);

      expect(suspension.status).toBe(200);
      const row = await requestRow(requestId);
      if (approval.status === 200) {
        // La aprobacion entro primero: la suspension ya no encontro pendiente.
        expect(row.status).toBe(ZoneChangeRequestStatus.APROBADA);
        expect(await zoneOf(worker)).toBe(zoneB.id);
      } else {
        // La suspension entro primero: la solicitud quedo cancelada.
        expect(approval.status).toBe(409);
        expect(row).toMatchObject({
          status: ZoneChangeRequestStatus.CANCELADA,
          cancellationCause: ZoneChangeCancellationCause.SUSPENSION_PERFIL,
        });
        expect(await zoneOf(worker)).toBe(zoneA.id);
      }
      expect(await requestAudit(requestId)).toHaveLength(1);
      expect(await requestNotifications(worker, requestId)).toHaveLength(1);
    });
  });
});
