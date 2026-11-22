import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import {
  NotificationResourceType,
  NotificationType,
  RoleName,
  UserStatus,
  WorkerProfileStatus,
} from '../src/generated/prisma/client.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from '../src/modules/catalogs/catalogs.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import {
  PublicUser,
  UsersService,
} from '../src/modules/users/users.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deleteWorkerData } from './utils/worker-profile-cleanup.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@notifications-e2e.test';
const BASE = '/api/notifications';
const PROFILES = '/api/worker-profile';

interface NotificationBody {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  resourceType: NotificationResourceType | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

describe('NotificationsModule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let users: UsersService;
  let notifications: NotificationsService;

  let worker: PublicUser;
  let client: PublicUser;
  let admin: PublicUser;
  let admin2: PublicUser;
  let suspendedAdmin: PublicUser;
  let inactiveUser: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;
  let profileId: string;
  const created: PublicUser[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const newUser = async (name: string, phone = '70000021') => {
    const user = await users.create({
      firstName: name,
      lastName: 'E2E',
      email: `${name}-${RUN_ID}${EMAIL_DOMAIN}`,
      passwordHash: 'hash',
      phone,
    });
    created.push(user);
    return user;
  };
  const makeAdmin = async (user: PublicUser) => {
    await prisma.userRole.create({
      data: { userId: user.id, role: RoleName.ADMINISTRADOR },
    });
    return users.findById(user.id);
  };
  const createProfile = async (user: PublicUser) => {
    const res = await http()
      .post(PROFILES)
      .set('Authorization', auth(user))
      .send({
        yearsOfExperience: 3,
        zoneId: zone.id,
        categoryIds: [category.id],
        schedules: [
          { dayOfWeek: 'LUNES', startTime: '08:00', endTime: '12:00' },
        ],
      })
      .expect(201);
    return res.body.id as string;
  };
  const submit = (user: PublicUser) =>
    http().post(`${PROFILES}/me/submit`).set('Authorization', auth(user));
  const decide = (status: WorkerProfileStatus, reason?: string) =>
    http()
      .patch(`${PROFILES}/admin/profiles/${profileId}/status`)
      .set('Authorization', auth(admin))
      .send(reason ? { status, reason } : { status });
  const stored = (userId: string, resourceId = profileId) =>
    prisma.notification.findMany({
      where: { userId, resourceId },
      orderBy: { createdAt: 'asc' },
    });
  const statusOf = async (id = profileId) =>
    (await prisma.workerProfile.findUniqueOrThrow({ where: { id } })).status;
  const list = (user: PublicUser, query = '') =>
    http().get(`${BASE}${query}`).set('Authorization', auth(user));

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
    notifications = app.get(NotificationsService);
    const catalogs = app.get(CatalogsService);

    worker = await newUser('worker');
    client = await newUser('client');
    admin = await makeAdmin(await newUser('admin'));
    admin2 = await makeAdmin(await newUser('admin2'));
    suspendedAdmin = await makeAdmin(await newUser('admin-suspendido'));
    inactiveUser = await newUser('inactivo');
    await prisma.user.update({
      where: { id: suspendedAdmin.id },
      data: { status: UserStatus.SUSPENDIDO },
    });
    await prisma.user.update({
      where: { id: inactiveUser.id },
      data: { status: UserStatus.INACTIVO },
    });

    zone = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Zona notificaciones ${RUN_ID}`,
    });
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Categoria notificaciones ${RUN_ID}`,
    });
    profileId = await createProfile(worker);
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

  describe('acceso', () => {
    it.each([
      ['get', BASE],
      ['get', `${BASE}/unread-count`],
      ['patch', `${BASE}/read-all`],
      ['patch', `${BASE}/${randomUUID()}/read`],
    ] as const)('%s %s exige sesión (401)', async (method, url) => {
      await http()[method](url).expect(401);
    });

    it.each([
      ['suspendida', () => suspendedAdmin],
      ['inactiva', () => inactiveUser],
    ])('una cuenta %s no accede (401)', async (_label, who) => {
      await list(who()).expect(401);
      await http()
        .get(`${BASE}/unread-count`)
        .set('Authorization', auth(who()))
        .expect(401);
    });

    it('no acepta un destinatario desde el cliente (400)', async () => {
      await list(worker, `?userId=${admin.id}`).expect(400);
    });

    it('valida la paginación y el filtro (400)', async () => {
      await list(worker, '?limit=101').expect(400);
      await list(worker, '?page=0').expect(400);
      await list(worker, '?unread=quizas').expect(400);
    });
  });

  describe('eventos de verificación de perfiles', () => {
    it('el envío avisa a cada administrador activo, no al trabajador ni a cuentas suspendidas', async () => {
      await submit(worker).expect(200);

      for (const recipient of [admin, admin2]) {
        const [notification, ...rest] = await stored(recipient.id);
        expect(rest).toHaveLength(0);
        expect(notification).toMatchObject({
          type: NotificationType.VERIFICACION_SOLICITADA,
          title: 'Nueva solicitud de verificación',
          resourceType: NotificationResourceType.PERFIL_TRABAJADOR,
          resourceId: profileId,
          readAt: null,
        });
        // Sin datos personales del trabajador en el texto.
        expect(notification.message).not.toContain(worker.email);
        expect(notification.message).not.toContain(worker.firstName);
      }
      expect(await stored(suspendedAdmin.id)).toHaveLength(0);
      expect(await stored(worker.id)).toHaveLength(0);
      expect(await stored(client.id)).toHaveLength(0);
    });

    it('observar avisa al trabajador con el motivo; el reenvío avisa a los administradores', async () => {
      await decide(WorkerProfileStatus.OBSERVADO, 'Falta la foto').expect(200);
      const [observed] = await stored(worker.id);
      expect(observed).toMatchObject({
        type: NotificationType.PERFIL_OBSERVADO,
        resourceId: profileId,
      });
      expect(observed.message).toContain('Motivo: Falta la foto');
      // La decision no se notifica a los administradores.
      expect(await stored(admin.id)).toHaveLength(1);

      await submit(worker).expect(200);
      expect((await stored(admin.id)).map((n) => n.type)).toEqual([
        NotificationType.VERIFICACION_SOLICITADA,
        NotificationType.VERIFICACION_REENVIADA_OBSERVACION,
      ]);
    });

    it('rechazar avisa con el motivo; el reenvío tras el rechazo tiene su propio tipo', async () => {
      await decide(
        WorkerProfileStatus.RECHAZADO,
        'Antecedentes ilegibles',
      ).expect(200);
      const rejected = (await stored(worker.id)).at(-1);
      expect(rejected).toMatchObject({
        type: NotificationType.PERFIL_RECHAZADO,
      });
      expect(rejected?.message).toContain('Motivo: Antecedentes ilegibles');

      await submit(worker).expect(200);
      expect((await stored(admin2.id)).at(-1)?.type).toBe(
        NotificationType.VERIFICACION_REENVIADA_RECHAZO,
      );
    });

    it('aprobar, suspender y reactivar avisan al trabajador', async () => {
      await decide(WorkerProfileStatus.APROBADO).expect(200);
      await decide(
        WorkerProfileStatus.SUSPENDIDO,
        'Reclamos reiterados',
      ).expect(200);
      await decide(WorkerProfileStatus.APROBADO).expect(200);

      const own = await stored(worker.id);
      expect(own.map((n) => n.type)).toEqual([
        NotificationType.PERFIL_OBSERVADO,
        NotificationType.PERFIL_RECHAZADO,
        NotificationType.PERFIL_APROBADO,
        NotificationType.PERFIL_SUSPENDIDO,
        NotificationType.PERFIL_REACTIVADO,
      ]);
      expect(own[3].message).toContain('Motivo: Reclamos reiterados');
      // El motivo privado no llega a los administradores por notificacion.
      for (const notification of await stored(admin.id)) {
        expect(notification.message).not.toContain('Reclamos reiterados');
      }
    });

    it('un administrador que envía su propio perfil no se notifica a sí mismo', async () => {
      const adminWorker = await newUser('admin-trabajador');
      const ownProfileId = await createProfile(adminWorker);
      await makeAdmin(adminWorker);

      await submit(adminWorker).expect(200);

      expect(await stored(adminWorker.id, ownProfileId)).toHaveLength(0);
      expect(await stored(admin.id, ownProfileId)).toHaveLength(1);
    });
  });

  describe('consistencia transaccional', () => {
    it('si falla la notificación de una decisión, el cambio de estado no se confirma', async () => {
      expect(await statusOf()).toBe(WorkerProfileStatus.APROBADO);
      const before = {
        history: await prisma.workerProfileStatusHistory.count({
          where: { profileId },
        }),
        audit: await prisma.adminAuditLog.count({
          where: { entityId: profileId },
        }),
        notifications: (await stored(worker.id)).length,
      };
      vi.spyOn(notifications, 'create').mockRejectedValueOnce(
        new Error('falla simulada de notificaciones'),
      );

      await decide(WorkerProfileStatus.SUSPENDIDO, 'Motivo').expect(500);

      expect(await statusOf()).toBe(WorkerProfileStatus.APROBADO);
      expect(
        await prisma.workerProfileStatusHistory.count({ where: { profileId } }),
      ).toBe(before.history);
      expect(
        await prisma.adminAuditLog.count({ where: { entityId: profileId } }),
      ).toBe(before.audit);
      expect(await stored(worker.id)).toHaveLength(before.notifications);
    });

    it('si falla la notificación del envío, el perfil no pasa a PENDIENTE', async () => {
      const candidate = await newUser('candidato-falla');
      const candidateProfileId = await createProfile(candidate);
      vi.spyOn(notifications, 'createForRole').mockRejectedValueOnce(
        new Error('falla simulada de notificaciones'),
      );

      await submit(candidate).expect(500);

      expect(await statusOf(candidateProfileId)).toBe(
        WorkerProfileStatus.BORRADOR,
      );
      expect(
        await prisma.workerProfileStatusHistory.count({
          where: { profileId: candidateProfileId, fromStatus: { not: null } },
        }),
      ).toBe(0);
      expect(await stored(admin.id, candidateProfileId)).toHaveLength(0);

      // Sin la falla, el mismo envio funciona y notifica.
      await submit(candidate).expect(200);
      expect(await stored(admin.id, candidateProfileId)).toHaveLength(1);
    });
  });

  describe('bandeja del usuario', () => {
    it('lista solo las propias, de la más reciente a la más antigua, con paginación', async () => {
      const page1 = await list(worker, '?limit=2').expect(200);
      expect(page1.body.meta).toEqual({
        page: 1,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
      const all = await list(worker).expect(200);
      const types = all.body.data.map((n: NotificationBody) => n.type);
      expect(types).toEqual([
        NotificationType.PERFIL_REACTIVADO,
        NotificationType.PERFIL_SUSPENDIDO,
        NotificationType.PERFIL_APROBADO,
        NotificationType.PERFIL_RECHAZADO,
        NotificationType.PERFIL_OBSERVADO,
      ]);
      expect(page1.body.data).toEqual(all.body.data.slice(0, 2));
      const page3 = await list(worker, '?limit=2&page=3').expect(200);
      expect(page3.body.data).toEqual(all.body.data.slice(4));
      // Forma de la respuesta: sin userId ni otros datos internos.
      expect(Object.keys(all.body.data[0]).sort()).toEqual(
        [
          'createdAt',
          'id',
          'message',
          'readAt',
          'resourceId',
          'resourceType',
          'title',
          'type',
        ].sort(),
      );
      // El cliente no tiene ninguna.
      const empty = await list(client).expect(200);
      expect(empty.body).toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it('cuenta las no leídas y marca una como leída (idempotente)', async () => {
      const count = () =>
        http().get(`${BASE}/unread-count`).set('Authorization', auth(worker));
      expect((await count().expect(200)).body).toEqual({ unread: 5 });

      const [latest] = (await list(worker).expect(200)).body
        .data as NotificationBody[];
      const read = await http()
        .patch(`${BASE}/${latest.id}/read`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(read.body).toMatchObject({ id: latest.id, type: latest.type });
      expect(read.body.readAt).toEqual(expect.any(String));

      const again = await http()
        .patch(`${BASE}/${latest.id}/read`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(again.body.readAt).toBe(read.body.readAt);
      expect((await count().expect(200)).body).toEqual({ unread: 4 });

      const unreadOnly = await list(worker, '?unread=true').expect(200);
      expect(unreadOnly.body.meta.total).toBe(4);
      const readOnly = await list(worker, '?unread=false').expect(200);
      expect(readOnly.body.data.map((n: NotificationBody) => n.id)).toEqual([
        latest.id,
      ]);
    });

    it('no consulta ni modifica notificaciones ajenas (404)', async () => {
      const [foreign] = await stored(admin.id);
      await http()
        .patch(`${BASE}/${foreign.id}/read`)
        .set('Authorization', auth(worker))
        .expect(404);
      await http()
        .patch(`${BASE}/${randomUUID()}/read`)
        .set('Authorization', auth(worker))
        .expect(404);
      await http()
        .patch(`${BASE}/no-es-uuid/read`)
        .set('Authorization', auth(worker))
        .expect(400);
      const untouched = await prisma.notification.findUniqueOrThrow({
        where: { id: foreign.id },
      });
      expect(untouched.readAt).toBeNull();
      const ownIds = (await list(worker).expect(200)).body.data.map(
        (n: NotificationBody) => n.id,
      );
      expect(ownIds).not.toContain(foreign.id);
    });

    it('marca todas como leídas sin tocar las de otros usuarios', async () => {
      const adminUnreadBefore = (
        await http()
          .get(`${BASE}/unread-count`)
          .set('Authorization', auth(admin))
          .expect(200)
      ).body.unread;

      const res = await http()
        .patch(`${BASE}/read-all`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(res.body).toEqual({ updated: 4 });
      const second = await http()
        .patch(`${BASE}/read-all`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(second.body).toEqual({ updated: 0 });

      expect(
        (
          await http()
            .get(`${BASE}/unread-count`)
            .set('Authorization', auth(worker))
            .expect(200)
        ).body,
      ).toEqual({ unread: 0 });
      expect(
        (
          await http()
            .get(`${BASE}/unread-count`)
            .set('Authorization', auth(admin))
            .expect(200)
        ).body.unread,
      ).toBe(adminUnreadBefore);
    });

    it('conserva todas las notificaciones anteriores, leídas o no', async () => {
      const kept = await prisma.notification.count({
        where: { userId: worker.id },
      });
      expect(kept).toBe(5);
      // Un evento nuevo se agrega sin reemplazar las anteriores.
      await decide(WorkerProfileStatus.SUSPENDIDO, 'Nuevo motivo').expect(200);
      const after = await list(worker).expect(200);
      expect(after.body.meta.total).toBe(6);
      expect(after.body.data[0]).toMatchObject({
        type: NotificationType.PERFIL_SUSPENDIDO,
        readAt: null,
      });
      expect(
        after.body.data
          .slice(1)
          .every((n: NotificationBody) => n.readAt !== null),
      ).toBe(true);
    });
  });
});
