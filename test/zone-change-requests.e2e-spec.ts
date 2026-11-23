import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  INestApplication,
} from '@nestjs/common';
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
    zoneId: string = zoneA.id,
  ): Promise<Worker> => {
    const user = await newUser(name);
    const profile = await profiles.create(user.id, {
      yearsOfExperience: 4,
      zoneId,
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
  describe('retiro voluntario (T4.3)', () => {
    const withdraw = (requestId: string, user: PublicUser) =>
      http()
        .post(`${BASE}/me/zone-change-requests/${requestId}/withdraw`)
        .set('Authorization', auth(user));

    it('el trabajador retira su solicitud: queda CANCELADA por retiro y conserva su zona', async () => {
      const { worker, requestId } = await pendingRequest('retiro');

      const res = await withdraw(requestId, worker.user).expect(200);

      expect(res.body).toMatchObject({
        id: requestId,
        status: ZoneChangeRequestStatus.CANCELADA,
        cancellationCause: ZoneChangeCancellationCause.RETIRO_TRABAJADOR,
        decisionComment: null,
        fromZone: { id: zoneA.id },
        toZone: { id: zoneB.id },
      });
      expect(res.body.decidedAt).toEqual(expect.any(String));
      // Responsable y fecha del retiro; el registro se conserva.
      const row = await requestRow(requestId);
      expect(row).toMatchObject({
        decidedById: worker.user.id,
        reason: 'Me mudé de barrio',
      });
      expect(await zoneOf(worker)).toBe(zoneA.id);
      const own = await http()
        .get(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker.user))
        .expect(200);
      expect(own.body.map((r: { id: string }) => r.id)).toEqual([requestId]);
      const detail = await http()
        .get(`${BASE}/admin/zone-change-requests/${requestId}`)
        .set('Authorization', auth(admin))
        .expect(200);
      expect(detail.body.decidedBy).toMatchObject({ id: worker.user.id });

      // Una sola notificacion de confirmacion; nada en la bitacora administrativa.
      const received = await requestNotifications(worker, requestId);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        type: NotificationType.SOLICITUD_ZONA_RETIRADA,
        resourceType: NotificationResourceType.SOLICITUD_CAMBIO_ZONA,
        message: `Retiró su solicitud de cambio a la zona "${zoneB.name}". Conserva su zona "${zoneA.name}" y ya puede volver a ofertar y tomar trabajos en ella.`,
      });
      expect(await requestAudit(requestId)).toHaveLength(0);

      // Puede volver a solicitar.
      await requestChange(worker, zoneC.id).expect(201);
    });

    it('nadie más puede retirar la solicitud', async () => {
      const { requestId } = await pendingRequest('retiro-ajeno');
      const other = await newWorker('retiro-intruso');

      await http()
        .post(`${BASE}/me/zone-change-requests/${requestId}/withdraw`)
        .expect(401);
      await withdraw(requestId, client).expect(403);
      await withdraw(requestId, admin).expect(403);
      const res = await withdraw(requestId, other.user).expect(404);
      expect(res.body.message).toBe('La solicitud de cambio de zona no existe');
      await withdraw(randomUUID(), other.user).expect(404);
      await withdraw('no-es-uuid', other.user).expect(400);
      expect((await requestRow(requestId)).status).toBe(
        ZoneChangeRequestStatus.PENDIENTE,
      );
    });

    it('una solicitud ya decidida o cancelada no se puede retirar', async () => {
      const approved = await pendingRequest('retiro-aprobada');
      await decide(approved.requestId, { decision: 'APROBADA' }).expect(200);
      const rejected = await pendingRequest('retiro-rechazada');
      await decide(rejected.requestId, {
        decision: 'RECHAZADA',
        comment: 'Sin cobertura',
      }).expect(200);
      const suspended = await pendingRequest('retiro-suspendida');
      await suspend(suspended.worker).expect(200);
      const twice = await pendingRequest('retiro-doble');
      await withdraw(twice.requestId, twice.worker.user).expect(200);

      for (const { worker, requestId } of [
        approved,
        rejected,
        suspended,
        twice,
      ]) {
        const res = await withdraw(requestId, worker.user).expect(409);
        expect(res.body.message).toBe('La solicitud ya fue resuelta');
      }
      expect((await requestRow(approved.requestId)).status).toBe(
        ZoneChangeRequestStatus.APROBADA,
      );
      expect((await requestRow(suspended.requestId)).cancellationCause).toBe(
        ZoneChangeCancellationCause.SUSPENSION_PERFIL,
      );
      // El segundo intento no duplica la notificacion.
      expect(
        await requestNotifications(twice.worker, twice.requestId),
      ).toHaveLength(1);
    });

    it('si falla la notificación, el retiro no se confirma', async () => {
      const { worker, requestId } = await pendingRequest('retiro-falla');
      vi.spyOn(notifications, 'create').mockRejectedValueOnce(
        new Error('falla simulada de notificaciones'),
      );

      await withdraw(requestId, worker.user).expect(500);

      expect(await requestRow(requestId)).toMatchObject({
        status: ZoneChangeRequestStatus.PENDIENTE,
        cancellationCause: null,
        decidedById: null,
      });
      expect(await requestNotifications(worker, requestId)).toHaveLength(0);
    });

    it('retiro y decisión administrativa simultáneos: solo uno gana', async () => {
      const { worker, requestId } = await pendingRequest('retiro-simultaneo');

      const [withdrawal, approval] = await Promise.all([
        withdraw(requestId, worker.user),
        decide(requestId, { decision: 'APROBADA' }),
      ]);

      expect(
        [withdrawal.status, approval.status].sort((a, b) => a - b),
      ).toEqual([200, 409]);
      const row = await requestRow(requestId);
      if (withdrawal.status === 200) {
        expect(row).toMatchObject({
          status: ZoneChangeRequestStatus.CANCELADA,
          cancellationCause: ZoneChangeCancellationCause.RETIRO_TRABAJADOR,
        });
        expect(await zoneOf(worker)).toBe(zoneA.id);
        expect(await requestAudit(requestId)).toHaveLength(0);
      } else {
        expect(row.status).toBe(ZoneChangeRequestStatus.APROBADA);
        expect(await zoneOf(worker)).toBe(zoneB.id);
        expect(await requestAudit(requestId)).toHaveLength(1);
      }
      expect(await requestNotifications(worker, requestId)).toHaveLength(1);
    });
  });

  describe('trabajos nuevos con una solicitud pendiente (T4.3)', () => {
    const gate = (worker: Worker) =>
      prisma.$transaction((tx) =>
        profiles.lockApprovedWorker(tx, worker.user.id),
      );
    const candidates = () =>
      profiles.findApprovedWorkers({
        categoryId: category.id,
        zoneId: zoneA.id,
      });

    it('no pasa la verificación de trabajo nuevo ni es candidato hasta resolverse', async () => {
      const { worker, requestId } = await pendingRequest('bloqueo-trabajo');

      await expect(gate(worker)).rejects.toThrow(
        new ConflictException(
          'Tiene una solicitud de cambio de zona pendiente: no puede ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire.',
        ),
      );
      expect((await candidates()).map((c) => c.userId)).not.toContain(
        worker.user.id,
      );
      // Sigue APROBADO: puede consultar pedidos, pero no participar.
      await http()
        .get('/api/orders/available')
        .set('Authorization', auth(worker.user))
        .expect(200);

      await http()
        .post(`${BASE}/me/zone-change-requests/${requestId}/withdraw`)
        .set('Authorization', auth(worker.user))
        .expect(200);

      await expect(gate(worker)).resolves.toMatchObject({
        userId: worker.user.id,
        zoneId: zoneA.id,
      });
      expect((await candidates()).map((c) => c.userId)).toContain(
        worker.user.id,
      );
    });

    it('tras una decisión también se levanta la restricción, en la zona vigente', async () => {
      const rejected = await pendingRequest('bloqueo-rechazo');
      await decide(rejected.requestId, {
        decision: 'RECHAZADA',
        comment: 'Sin cobertura',
      }).expect(200);
      await expect(gate(rejected.worker)).resolves.toMatchObject({
        zoneId: zoneA.id,
      });

      const approved = await pendingRequest('bloqueo-aprobacion');
      await decide(approved.requestId, { decision: 'APROBADA' }).expect(200);
      await expect(gate(approved.worker)).resolves.toMatchObject({
        zoneId: zoneB.id,
      });
    });
  });
  describe('reasignación administrativa de zona de un perfil RECHAZADO (T4.4)', () => {
    const reassign = (profileId: string, body: object, user = admin) =>
      http()
        .patch(`${BASE}/admin/profiles/${profileId}/zone`)
        .set('Authorization', auth(user))
        .send(body);
    const body = (zoneId = zoneB.id) => ({
      zoneId,
      justification: 'La zona del trabajador fue desactivada',
    });
    const newZone = (name: string) =>
      app
        .get(CatalogsService)
        .create(CatalogKind.ZONE, admin.id, { name: `${name} ${RUN_ID}` });
    /** Trabajador en `status` cuya zona propia se desactivo despues. */
    const inDeactivatedZone = async (
      name: string,
      status: WorkerProfileStatus = WorkerProfileStatus.RECHAZADO,
    ) => {
      const zone = await newZone(`Zona ${name}`);
      const worker = await newWorker(name, status, zone.id);
      await app
        .get(CatalogsService)
        .deactivate(CatalogKind.ZONE, admin.id, zone.id);
      return { worker, zone };
    };
    const profileRow = (worker: Worker) =>
      prisma.workerProfile.findUniqueOrThrow({
        where: { id: worker.profileId },
      });
    const reassignmentLogs = (worker: Worker) =>
      prisma.adminAuditLog.findMany({
        where: {
          entityType: AuditEntityType.PERFIL_TRABAJADOR,
          entityId: worker.profileId,
          action: AuditAction.EDICION,
        },
      });
    const reassignedNotices = (worker: Worker) =>
      prisma.notification.findMany({
        where: {
          userId: worker.user.id,
          type: NotificationType.ZONA_REASIGNADA,
        },
      });

    it('reasigna la zona, audita y avisa; el perfil sigue RECHAZADO y puede reenviarse', async () => {
      const { worker, zone } = await inDeactivatedZone('reasignado');
      const before = await profileRow(worker);
      const historyBefore = await prisma.workerProfileStatusHistory.count({
        where: { profileId: worker.profileId },
      });

      const res = await reassign(worker.profileId, {
        zoneId: zoneB.id,
        justification: '  Zona cerrada por el equipo  ',
      }).expect(200);

      expect(res.body.profile).toMatchObject({
        id: worker.profileId,
        status: WorkerProfileStatus.RECHAZADO,
        zone: { id: zoneB.id, isActive: true },
        zoneRequiresChange: false,
      });
      // Solo cambio la zona: el resto del perfil queda igual.
      const after = await profileRow(worker);
      expect(after).toEqual({
        ...before,
        zoneId: zoneB.id,
        updatedAt: after.updatedAt,
      });
      expect(
        await prisma.workerProfileStatusHistory.count({
          where: { profileId: worker.profileId },
        }),
      ).toBe(historyBefore);
      // No es una solicitud de cambio de zona.
      expect(
        await prisma.zoneChangeRequest.count({
          where: { profileId: worker.profileId },
        }),
      ).toBe(0);

      const logs = await reassignmentLogs(worker);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        actorId: admin.id,
        details: {
          operation: 'REASIGNACION_ZONA',
          workerUserId: worker.user.id,
          profileStatus: WorkerProfileStatus.RECHAZADO,
          fromZoneId: zone.id,
          toZoneId: zoneB.id,
          justification: 'Zona cerrada por el equipo',
        },
      });
      expect(logs[0].createdAt).toBeInstanceOf(Date);
      const notices = await reassignedNotices(worker);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        resourceType: NotificationResourceType.PERFIL_TRABAJADOR,
        resourceId: worker.profileId,
        message: `Su zona "${zone.name}" fue desactivada y un administrador le asignó la zona "${zoneB.name}". Puede corregir su perfil y volver a enviarlo a revisión.`,
      });

      // Con una zona activa vuelve a poder reenviar su perfil (T3.1).
      const resubmitted = await http()
        .post(`${BASE}/me/submit`)
        .set('Authorization', auth(worker.user))
        .expect(200);
      expect(resubmitted.body.status).toBe(WorkerProfileStatus.PENDIENTE);
    });

    it.each([WorkerProfileStatus.APROBADO, WorkerProfileStatus.BORRADOR])(
      'un perfil %s no puede usar esta operación (409)',
      async (status) => {
        const { worker, zone } = await inDeactivatedZone(
          `reasignar-${status.toLowerCase()}`,
          status,
        );

        const res = await reassign(worker.profileId, body()).expect(409);

        expect(res.body.message).toBe(
          `Solo se puede reasignar la zona de un perfil RECHAZADO, OBSERVADO, PENDIENTE o SUSPENDIDO (estado actual: ${status})`,
        );
        expect((await profileRow(worker)).zoneId).toBe(zone.id);
        expect(await reassignmentLogs(worker)).toHaveLength(0);
      },
    );

    it.each([WorkerProfileStatus.OBSERVADO, WorkerProfileStatus.PENDIENTE])(
      'un perfil %s también se reasigna y conserva su estado (T4-F2)',
      async (status) => {
        const { worker } = await inDeactivatedZone(
          `reasignar-f2-${status.toLowerCase()}`,
          status,
        );

        const res = await reassign(worker.profileId, body()).expect(200);

        expect(res.body.profile).toMatchObject({
          status,
          zone: { id: zoneB.id, isActive: true },
        });
        expect(await profileRow(worker)).toMatchObject({
          status,
          zoneId: zoneB.id,
        });
        const [log] = await reassignmentLogs(worker);
        expect(log.details).toMatchObject({ profileStatus: status });
        expect(await reassignedNotices(worker)).toHaveLength(1);

        // Con una zona activa el flujo sigue: aprobar o reenviar.
        if (status === WorkerProfileStatus.PENDIENTE) {
          await http()
            .patch(`${BASE}/admin/profiles/${worker.profileId}/status`)
            .set('Authorization', auth(admin))
            .send({ status: WorkerProfileStatus.APROBADO })
            .expect(200);
        } else {
          await http()
            .post(`${BASE}/me/submit`)
            .set('Authorization', auth(worker.user))
            .expect(200);
        }
      },
    );

    it('no sirve para cambiar una zona que sigue activa (409)', async () => {
      const worker = await newWorker(
        'reasignar-zona-activa',
        WorkerProfileStatus.RECHAZADO,
      );

      const res = await reassign(worker.profileId, body()).expect(409);

      expect(res.body.message).toBe(
        `La zona actual "${zoneA.name}" sigue activa: la reasignación administrativa solo se usa cuando la zona del perfil fue desactivada`,
      );
      expect((await profileRow(worker)).zoneId).toBe(zoneA.id);
    });

    it('valida la zona destino y la justificación', async () => {
      const { worker, zone } = await inDeactivatedZone('reasignar-validacion');

      await reassign(worker.profileId, body(randomUUID())).expect(404);
      const inactive = await reassign(
        worker.profileId,
        body(zoneOff.id),
      ).expect(400);
      expect(inactive.body.message).toBe('La zona seleccionada no está activa');
      const same = await reassign(worker.profileId, body(zone.id)).expect(400);
      expect(same.body.message).toBe(
        'La zona nueva debe ser distinta de la zona actual',
      );
      await reassign(worker.profileId, {
        zoneId: 'no-es-uuid',
        justification: 'x',
      }).expect(400);
      for (const justification of [undefined, '', '    ']) {
        await reassign(worker.profileId, {
          zoneId: zoneB.id,
          justification,
        }).expect(400);
      }
      // No acepta cambiar otros datos (ni el estado) en la misma operación.
      await reassign(worker.profileId, {
        ...body(),
        status: WorkerProfileStatus.APROBADO,
      }).expect(400);
      await reassign(randomUUID(), body()).expect(404);

      const row = await profileRow(worker);
      expect(row).toMatchObject({
        zoneId: zone.id,
        status: WorkerProfileStatus.RECHAZADO,
      });
      expect(await reassignmentLogs(worker)).toHaveLength(0);
      expect(await reassignedNotices(worker)).toHaveLength(0);
    });

    it('solo administradores activos, y nunca sobre su propio perfil', async () => {
      const { worker, zone } = await inDeactivatedZone('reasignar-permisos');

      await http()
        .patch(`${BASE}/admin/profiles/${worker.profileId}/zone`)
        .send(body())
        .expect(401);
      await reassign(worker.profileId, body(), inactiveAdmin).expect(401);
      await reassign(worker.profileId, body(), client).expect(403);
      await reassign(worker.profileId, body(), worker.user).expect(403);

      const own = await inDeactivatedZone('reasignar-propio');
      const ownAdmin = await addRole(own.worker.user, RoleName.ADMINISTRADOR);
      const res = await reassign(own.worker.profileId, body(), ownAdmin).expect(
        403,
      );
      expect(res.body.message).toBe(
        'No puede modificar su propio perfil de trabajador',
      );
      expect((await profileRow(own.worker)).zoneId).toBe(own.zone.id);
      expect((await profileRow(worker)).zoneId).toBe(zone.id);
    });

    it('si falla la notificación, no queda ningún cambio', async () => {
      const { worker, zone } = await inDeactivatedZone('reasignar-falla');
      vi.spyOn(notifications, 'create').mockRejectedValueOnce(
        new Error('falla simulada de notificaciones'),
      );

      await reassign(worker.profileId, body()).expect(500);

      expect((await profileRow(worker)).zoneId).toBe(zone.id);
      expect(await reassignmentLogs(worker)).toHaveLength(0);
      expect(await reassignedNotices(worker)).toHaveLength(0);
    });

    it('dos reasignaciones simultáneas: solo una se aplica', async () => {
      const { worker } = await inDeactivatedZone('reasignar-simultanea');

      const responses = await Promise.all([
        reassign(worker.profileId, body(zoneB.id)),
        reassign(worker.profileId, body(zoneC.id)),
      ]);

      // La segunda encuentra la zona nueva, que esta activa.
      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      const winner = responses.find((r) => r.status === 200)!;
      expect((await profileRow(worker)).zoneId).toBe(
        winner.body.profile.zone.id,
      );
      expect(await reassignmentLogs(worker)).toHaveLength(1);
      expect(await reassignedNotices(worker)).toHaveLength(1);
    });

    it('con la zona destino desactivándose a la vez, el resultado es consistente', async () => {
      const { worker, zone } = await inDeactivatedZone('reasignar-carrera');
      const target = await newZone('Zona destino carrera');

      const [reassignment] = await Promise.all([
        reassign(worker.profileId, body(target.id)),
        app
          .get(CatalogsService)
          .deactivate(CatalogKind.ZONE, admin.id, target.id),
      ]);

      if (reassignment.status === 200) {
        // La reasignacion termino antes: la desactivacion espero su turno.
        expect((await profileRow(worker)).zoneId).toBe(target.id);
        expect(await reassignmentLogs(worker)).toHaveLength(1);
      } else {
        // La desactivacion termino antes: la zona destino ya no era valida.
        expect(reassignment.status).toBe(400);
        expect((await profileRow(worker)).zoneId).toBe(zone.id);
        expect(await reassignmentLogs(worker)).toHaveLength(0);
      }
    });
  });
  describe('correcciones de cierre de T4', () => {
    const newZone = (name: string) =>
      app
        .get(CatalogsService)
        .create(CatalogKind.ZONE, admin.id, { name: `${name} ${RUN_ID}` });
    const deactivateZone = (zoneId: string) =>
      app.get(CatalogsService).deactivate(CatalogKind.ZONE, admin.id, zoneId);
    const statusOf = async (worker: Worker) =>
      (
        await prisma.workerProfile.findUniqueOrThrow({
          where: { id: worker.profileId },
        })
      ).status;
    const reactivate = (worker: Worker) =>
      http()
        .patch(`${BASE}/admin/profiles/${worker.profileId}/status`)
        .set('Authorization', auth(admin))
        .send({ status: WorkerProfileStatus.APROBADO });
    const setAccountStatus = (
      user: PublicUser,
      status: UserStatus,
      as = admin,
    ) =>
      http()
        .patch(`/api/users/${user.id}/status`)
        .set('Authorization', auth(as))
        .send({ status });
    const reactivationNotices = (worker: Worker) =>
      prisma.notification.count({
        where: {
          userId: worker.user.id,
          type: NotificationType.PERFIL_REACTIVADO,
        },
      });

    describe('T4-F1: reactivación SUSPENDIDO -> APROBADO', () => {
      it('no reactiva si la zona fue desactivada (409) y no deja cambios', async () => {
        const zone = await newZone('Zona reactivacion');
        const worker = await newWorker(
          'reactivar-zona',
          WorkerProfileStatus.SUSPENDIDO,
          zone.id,
        );
        await deactivateZone(zone.id);
        const historyBefore = await prisma.workerProfileStatusHistory.count({
          where: { profileId: worker.profileId },
        });

        const res = await reactivate(worker).expect(409);

        expect(res.body.message).toEqual([
          'El perfil no cumple los requisitos para ser reactivado. Deben corregirse antes de reactivarlo.',
          `La zona "${zone.name}" fue desactivada: solicite un cambio de zona`,
        ]);
        expect(await statusOf(worker)).toBe(WorkerProfileStatus.SUSPENDIDO);
        expect(
          await prisma.workerProfileStatusHistory.count({
            where: { profileId: worker.profileId },
          }),
        ).toBe(historyBefore);
        expect(await reactivationNotices(worker)).toBe(0);
      });

      it('no reactiva sin teléfono; con los requisitos al día reactiva y lo registra', async () => {
        const worker = await newWorker(
          'reactivar-telefono',
          WorkerProfileStatus.SUSPENDIDO,
        );
        await http()
          .patch(`/api/users/${worker.user.id}`)
          .set('Authorization', auth(worker.user))
          .send({ phone: '' })
          .expect(200);

        const res = await reactivate(worker).expect(409);
        expect(res.body.message).toContain(
          'Registre un teléfono de contacto en su cuenta',
        );
        expect(await statusOf(worker)).toBe(WorkerProfileStatus.SUSPENDIDO);

        await http()
          .patch(`/api/users/${worker.user.id}`)
          .set('Authorization', auth(worker.user))
          .send({ phone: '70000031' })
          .expect(200);
        await reactivate(worker).expect(200);

        expect(await statusOf(worker)).toBe(WorkerProfileStatus.APROBADO);
        expect(
          await prisma.workerProfileStatusHistory.findFirst({
            where: {
              profileId: worker.profileId,
              fromStatus: WorkerProfileStatus.SUSPENDIDO,
              toStatus: WorkerProfileStatus.APROBADO,
            },
          }),
        ).not.toBeNull();
        expect(
          await prisma.adminAuditLog.count({
            where: {
              entityId: worker.profileId,
              action: AuditAction.CAMBIO_ESTADO,
            },
          }),
        ).toBeGreaterThan(0);
        expect(await reactivationNotices(worker)).toBe(1);
      });

      it('reactivar mientras se desactiva la zona deja un resultado consistente', async () => {
        const zone = await newZone('Zona reactivacion carrera');
        const worker = await newWorker(
          'reactivar-carrera',
          WorkerProfileStatus.SUSPENDIDO,
          zone.id,
        );

        const [res] = await Promise.all([
          reactivate(worker),
          deactivateZone(zone.id),
        ]);

        // 200: la reactivacion termino antes (la desactivacion espero su
        // bloqueo compartido). 409: la zona ya estaba desactivada al validar.
        expect([200, 409]).toContain(res.status);
        expect(await statusOf(worker)).toBe(
          res.status === 200
            ? WorkerProfileStatus.APROBADO
            : WorkerProfileStatus.SUSPENDIDO,
        );
      });
    });

    describe('T4-F3: suspensión de la cuenta de usuario', () => {
      it('cancela la solicitud pendiente con su propia causa, sin tocar el perfil', async () => {
        const { worker, requestId } = await pendingRequest('cuenta-suspendida');

        await setAccountStatus(worker.user, UserStatus.SUSPENDIDO).expect(200);

        const row = await requestRow(requestId);
        expect(row).toMatchObject({
          status: ZoneChangeRequestStatus.CANCELADA,
          cancellationCause: ZoneChangeCancellationCause.SUSPENSION_CUENTA,
          decidedById: admin.id,
          decisionComment: null,
        });
        expect(row.decidedAt).toBeInstanceOf(Date);
        // Es la cuenta, no el perfil: el perfil sigue APROBADO y en su zona.
        expect(await statusOf(worker)).toBe(WorkerProfileStatus.APROBADO);
        expect(await zoneOf(worker)).toBe(zoneA.id);

        const logs = await requestAudit(requestId);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({
          actorId: admin.id,
          action: AuditAction.CAMBIO_ESTADO,
          details: {
            toStatus: ZoneChangeRequestStatus.CANCELADA,
            cause: ZoneChangeCancellationCause.SUSPENSION_CUENTA,
          },
        });
        const notices = await requestNotifications(worker, requestId);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
          type: NotificationType.SOLICITUD_ZONA_CANCELADA,
          message: `Su solicitud de cambio a la zona "${zoneB.name}" se canceló porque su cuenta fue suspendida. Conserva su zona "${zoneA.name}".`,
        });
        const late = await decide(requestId, { decision: 'APROBADA' }).expect(
          409,
        );
        expect(late.body.message).toBe('La solicitud ya fue resuelta');
      });

      it('desactivar la propia cuenta (INACTIVO) no es una suspensión: no cancela', async () => {
        const { worker, requestId } = await pendingRequest('cuenta-inactiva');

        await setAccountStatus(
          worker.user,
          UserStatus.INACTIVO,
          worker.user,
        ).expect(200);

        expect((await requestRow(requestId)).status).toBe(
          ZoneChangeRequestStatus.PENDIENTE,
        );
      });

      it('no se aprueba una solicitud de una cuenta suspendida (dato anterior a T4-F3)', async () => {
        const worker = await newWorker('cuenta-suspendida-heredada');
        const legacy = await prisma.zoneChangeRequest.create({
          data: {
            profileId: worker.profileId,
            fromZoneId: zoneA.id,
            toZoneId: zoneB.id,
            reason: 'Solicitud anterior a T4-F3',
          },
        });
        // Suspension directa, sin el efecto de T4-F3 (como antes de existir).
        await prisma.user.update({
          where: { id: worker.user.id },
          data: { status: UserStatus.SUSPENDIDO },
        });

        const res = await decide(legacy.id, { decision: 'APROBADA' }).expect(
          409,
        );

        expect(res.body.message).toBe(
          'No se puede aprobar: la cuenta del trabajador está suspendida',
        );
        expect(await zoneOf(worker)).toBe(zoneA.id);
        await decide(legacy.id, {
          decision: 'RECHAZADA',
          comment: 'La cuenta está suspendida',
        }).expect(200);
      });

      it('si falla la cancelación, la cuenta no queda suspendida', async () => {
        const { worker, requestId } = await pendingRequest('cuenta-falla');
        vi.spyOn(notifications, 'create').mockRejectedValueOnce(
          new Error('falla simulada de notificaciones'),
        );

        await setAccountStatus(worker.user, UserStatus.SUSPENDIDO).expect(500);

        const account = await prisma.user.findUniqueOrThrow({
          where: { id: worker.user.id },
        });
        expect(account.status).toBe(UserStatus.ACTIVO);
        expect((await requestRow(requestId)).status).toBe(
          ZoneChangeRequestStatus.PENDIENTE,
        );
      });

      it('suspender la cuenta y aprobar a la vez: un solo resultado consistente', async () => {
        const { worker, requestId } = await pendingRequest('cuenta-simultanea');

        const [suspension, approval] = await Promise.all([
          setAccountStatus(worker.user, UserStatus.SUSPENDIDO),
          decide(requestId, { decision: 'APROBADA' }),
        ]);

        expect(suspension.status).toBe(200);
        const row = await requestRow(requestId);
        if (approval.status === 200) {
          expect(row.status).toBe(ZoneChangeRequestStatus.APROBADA);
          expect(await zoneOf(worker)).toBe(zoneB.id);
        } else {
          expect(approval.status).toBe(409);
          expect(row).toMatchObject({
            status: ZoneChangeRequestStatus.CANCELADA,
            cancellationCause: ZoneChangeCancellationCause.SUSPENSION_CUENTA,
          });
          expect(await zoneOf(worker)).toBe(zoneA.id);
        }
        expect(await requestAudit(requestId)).toHaveLength(1);
        expect(await requestNotifications(worker, requestId)).toHaveLength(1);
      });
    });

    describe('T4-F7: regularización de un perfil SUSPENDIDO', () => {
      it('regulariza datos, especialidades y zona; sigue SUSPENDIDO hasta que un administrador lo reactiva', async () => {
        const catalogsService = app.get(CatalogsService);
        const zone = await newZone('Zona regularizacion');
        const oldCategory = await catalogsService.create(
          CatalogKind.CATEGORY,
          admin.id,
          { name: `Categoria regularizacion ${RUN_ID}` },
        );
        const worker = await newWorker(
          'regularizar',
          WorkerProfileStatus.SUSPENDIDO,
          zone.id,
        );
        const asWorker = (
          method: 'get' | 'patch' | 'put' | 'post',
          url: string,
        ) => http()[method](url).set('Authorization', auth(worker.user));

        // Suspendido, puede editar sus especialidades.
        await asWorker('put', `${BASE}/me/specialties`)
          .send({ categoryIds: [oldCategory.id] })
          .expect(200);
        // Despues se desactivan su zona y esa especialidad.
        await deactivateZone(zone.id);
        await catalogsService.deactivate(
          CatalogKind.CATEGORY,
          admin.id,
          oldCategory.id,
        );

        // Reactivar con requisitos incompletos: 409 con todo lo que falta.
        const incomplete = await reactivate(worker).expect(409);
        expect(incomplete.body.message).toEqual(
          expect.arrayContaining([
            'El perfil no cumple los requisitos para ser reactivado. Deben corregirse antes de reactivarlo.',
            `Quite las especialidades inactivas: ${oldCategory.name}`,
            `La zona "${zone.name}" fue desactivada: solicite un cambio de zona`,
          ]),
        );

        // Regulariza lo que le corresponde: especialidades y datos editables.
        await asWorker('put', `${BASE}/me/specialties`)
          .send({ categoryIds: [category.id] })
          .expect(200);
        const edited = await asWorker('patch', `${BASE}/me`)
          .send({ yearsOfExperience: 9, description: 'Perfil regularizado' })
          .expect(200);
        expect(edited.body).toMatchObject({
          status: WorkerProfileStatus.SUSPENDIDO,
          yearsOfExperience: 9,
          canEdit: true,
          canSubmit: false,
        });
        // No puede cambiar la zona ni salir de la suspension por su cuenta.
        await asWorker('patch', `${BASE}/me`)
          .send({ zoneId: zoneB.id })
          .expect(403);
        const submit = await asWorker('post', `${BASE}/me/submit`).expect(409);
        expect(submit.body.message).toBe(
          'No se puede enviar a revisión un perfil en estado SUSPENDIDO',
        );

        // La zona la reasigna un administrador; el perfil sigue SUSPENDIDO.
        const reassigned = await http()
          .patch(`${BASE}/admin/profiles/${worker.profileId}/zone`)
          .set('Authorization', auth(admin))
          .send({
            zoneId: zoneA.id,
            justification: 'La zona del trabajador fue desactivada',
          })
          .expect(200);
        expect(reassigned.body.profile).toMatchObject({
          status: WorkerProfileStatus.SUSPENDIDO,
          zone: { id: zoneA.id },
        });
        const [notice] = await prisma.notification.findMany({
          where: {
            userId: worker.user.id,
            type: NotificationType.ZONA_REASIGNADA,
          },
        });
        expect(notice.message).toBe(
          `Su zona "${zone.name}" fue desactivada y un administrador le asignó la zona "${zoneA.name}". Su perfil sigue suspendido: un administrador podrá reactivarlo cuando cumpla todos los requisitos.`,
        );
        expect(
          await prisma.adminAuditLog.count({
            where: {
              entityId: worker.profileId,
              action: AuditAction.EDICION,
            },
          }),
        ).toBe(1);

        // Regularizado pero suspendido: sin trabajos, ofertas ni asignaciones.
        expect(await statusOf(worker)).toBe(WorkerProfileStatus.SUSPENDIDO);
        await asWorker('get', '/api/orders/available').expect(403);
        await expect(
          prisma.$transaction((tx) =>
            profiles.lockApprovedWorker(tx, worker.user.id),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        const blocked = await asWorker('get', `${BASE}/me/eligibility`).expect(
          200,
        );
        expect(blocked.body).toMatchObject({
          eligible: false,
          status: WorkerProfileStatus.SUSPENDIDO,
          canTakeNewWork: false,
        });
        expect(await reactivationNotices(worker)).toBe(0);

        // Solo el administrador lo reactiva, ahora que cumple los requisitos.
        await reactivate(worker).expect(200);
        expect(await statusOf(worker)).toBe(WorkerProfileStatus.APROBADO);
        await asWorker('get', '/api/orders/available').expect(200);
        const free = await asWorker('get', `${BASE}/me/eligibility`).expect(
          200,
        );
        expect(free.body).toMatchObject({
          eligible: true,
          canTakeNewWork: true,
        });
        expect(await reactivationNotices(worker)).toBe(1);
      });
    });

    describe('T4-F4: elegibilidad', () => {
      it('informa la solicitud pendiente y el bloqueo para trabajos nuevos', async () => {
        const { worker, requestId } = await pendingRequest('elegibilidad');
        const eligibility = () =>
          http()
            .get(`${BASE}/me/eligibility`)
            .set('Authorization', auth(worker.user))
            .expect(200);

        const blocked = await eligibility();
        expect(blocked.body).toMatchObject({
          eligible: true,
          status: WorkerProfileStatus.APROBADO,
          reason: null,
          canTakeNewWork: false,
          pendingZoneChangeRequest: {
            id: requestId,
            toZone: { id: zoneB.id, name: zoneB.name, isActive: true },
          },
        });
        expect(blocked.body.pendingZoneChangeRequest.createdAt).toEqual(
          expect.any(String),
        );

        await http()
          .post(`${BASE}/me/zone-change-requests/${requestId}/withdraw`)
          .set('Authorization', auth(worker.user))
          .expect(200);

        const free = await eligibility();
        expect(free.body).toMatchObject({
          eligible: true,
          canTakeNewWork: true,
          pendingZoneChangeRequest: null,
        });
      });
    });
  });
});
