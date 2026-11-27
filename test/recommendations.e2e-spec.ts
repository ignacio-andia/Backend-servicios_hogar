import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import {
  AuditEntityType,
  OrderStatus,
  PrismaClient,
  RoleName,
  WorkerProfileStatus,
} from '../src/generated/prisma/client.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from '../src/modules/catalogs/catalogs.service.js';
import { statusEligibilityPolicy } from '../src/modules/reviews/review-eligibility.policy.js';
import { ReviewsConfig } from '../src/modules/reviews/reviews.config.js';
import {
  PublicUser,
  UsersService,
} from '../src/modules/users/users.service.js';
import { WorkerProfileService } from '../src/modules/worker-profile/worker-profile.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createIsolatedSchema,
  IsolatedSchema,
} from './utils/isolated-schema.js';

// Esquema temporal con TODAS las migraciones (incluida la de recomendaciones,
// que crea la version 1 de los criterios): no toca los datos de public.
const RUN_ID = randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;
const ADDRESS = 'Av. Siempre Viva 742';

/** Inicio a "horas" desde ahora, redondeado a la hora: dentro de los proximos 7 dias. */
const hoursFromNow = (hours: number): Date => {
  const date = new Date(Date.now() + hours * HOUR);
  date.setUTCMinutes(0, 0, 0);
  return date;
};

interface WorkerView {
  rank: number;
  workerId: string;
  totalScore: string;
  reputation: {
    reviewsCount: number;
    averageRating: string | null;
    adjustedRating: string;
    score: string;
    weight: number;
    points: string;
    explanation: string;
  };
  completedServices: { count: number; score: string; weight: number };
  availability: {
    weeklyScheduleHours: string;
    bookedHours: string;
    freeHours: string;
    score: string;
    explanation: string;
  };
  openOfferId: string | null;
}

describe('Recomendacion de trabajadores (e2e)', () => {
  let app: INestApplication<App>;
  let isolated: IsolatedSchema;
  let scoped: PrismaClient;
  let prisma: PrismaService;
  let jwt: JwtService;
  let storageDir: string;
  let jpeg: Buffer;

  let admin: PublicUser;
  let client: PublicUser;
  let client2: PublicUser;
  /** Con calificaciones y servicios completados. */
  let expert: PublicUser;
  /** Sin calificaciones, con mucho horario libre. */
  let available: PublicUser;
  /** Aprobado pero de otra categoria: nunca es candidato. */
  let otherCategory: PublicUser;
  /** Enviado a revision, no aprobado: nunca es candidato. */
  let pending: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;
  let category2: CatalogItem;

  // Calificaciones habilitadas para trabajos terminados (en el .env es
  // REVIEWS_ELIGIBLE_STATUSES).
  const reviewsConfig = {
    policy: statusEligibilityPolicy([
      OrderStatus.TERMINADO,
      OrderStatus.CERRADO,
    ]),
  };

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);
  const get = (user: PublicUser, url: string) =>
    http().get(`/api${url}`).set('Authorization', auth(user));
  const put = (user: PublicUser, url: string, body?: object) =>
    http().put(`/api${url}`).set('Authorization', auth(user)).send(body);

  let slot = 0;
  /** Horarios distintos, dentro de los proximos 7 dias, para no cruzar trabajos. */
  const nextStart = () => hoursFromNow(26 + 2 * slot++);

  const offerBody = (startAt: Date) => ({
    amount: '120.50',
    requiresVisit: false,
    materialsIncluded: false,
    proposedStartAt: startAt.toISOString(),
    estimatedDurationMinutes: 30,
  });

  const createOrder = async (owner = client): Promise<string> => {
    const created = await http()
      .post('/api/orders')
      .set('Authorization', auth(owner))
      .field('categoryId', category.id)
      .field('zoneId', zone.id)
      .field('description', 'Fuga de agua debajo del lavaplatos de la cocina')
      .field('budgetAmount', '150.00')
      .field('addressLine', ADDRESS)
      .attach('images', jpeg, { filename: 'foto.jpg' })
      .expect(201);
    return created.body.order.id as string;
  };

  /** Pedido ACORDADO con el trabajador indicado (trabajo de 30 minutos). */
  const agreedOrder = async (by: PublicUser, startAt = nextStart()) => {
    const orderId = await createOrder();
    const offer = await post(
      by,
      `/offers/orders/${orderId}`,
      offerBody(startAt),
    ).expect(201);
    await post(client, `/offers/${offer.body.id as string}/accept`).expect(200);
    return orderId;
  };

  /** Trabajo terminado y calificado por el cliente. */
  const finishedAndRated = async (by: PublicUser, rating: number) => {
    const orderId = await agreedOrder(by);
    await post(by, `/orders/${orderId}/payments/ANTICIPO/declarations`, {
      amount: '30.13',
      method: 'EFECTIVO',
    }).expect(201);
    await post(by, `/orders/${orderId}/start`).expect(200);
    await post(by, `/orders/${orderId}/finish`).expect(200);
    await post(client, `/orders/${orderId}/reviews`, { rating }).expect(201);
    return orderId;
  };

  const workersOf = (body: { workers: WorkerView[] }) =>
    new Map(body.workers.map((worker) => [worker.workerId, worker]));

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'recommendations-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    isolated = await createIsolatedSchema('recommendations');
    scoped = new PrismaClient({
      adapter: new PrismaPg(
        {
          connectionString: process.env.DATABASE_URL!,
          options: `-c TimeZone=UTC -c search_path=${isolated.schema},public`,
        },
        { schema: isolated.schema },
      ),
    });
    await scoped.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(scoped)
      .overrideProvider(ReviewsConfig)
      .useValue(reviewsConfig)
      .compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    const catalogs = app.get(CatalogsService);
    const users = app.get(UsersService);
    const profiles = app.get(WorkerProfileService);

    const newUser = (name: string, phone?: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}@recommendations-e2e.test`,
        passwordHash: 'hash',
        phone,
      });
    admin = await newUser('admin');
    client = await newUser('client');
    client2 = await newUser('client2');
    expert = await newUser('expert', '71000011');
    available = await newUser('available', '71000012');
    otherCategory = await newUser('othercat', '71000013');
    pending = await newUser('pending', '71000014');
    await prisma.userRole.create({
      data: { userId: admin.id, role: RoleName.ADMINISTRADOR },
    });
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Plomeria ${RUN_ID}`,
    });
    category2 = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Pintura ${RUN_ID}`,
    });
    zone = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Norte ${RUN_ID}`,
    });

    const allWeek = (start: string, end: string) =>
      (
        [
          'LUNES',
          'MARTES',
          'MIERCOLES',
          'JUEVES',
          'VIERNES',
          'SABADO',
          'DOMINGO',
        ] as const
      ).map((dayOfWeek) => ({ dayOfWeek, startTime: start, endTime: end }));
    const approvedWorker = async (
      user: PublicUser,
      categoryId: string,
      schedules: { dayOfWeek: string; startTime: string; endTime: string }[],
      approve = true,
    ) => {
      const profile = await profiles.create(user.id, {
        yearsOfExperience: 5,
        zoneId: zone.id,
        categoryIds: [categoryId],
        schedules: schedules as never,
      });
      await profiles.submit(user.id);
      if (approve) {
        await profiles.changeStatusByAdmin(admin.id, profile.id, {
          status: WorkerProfileStatus.APROBADO,
        });
      }
    };
    // expert: 1 h por dia (7 h por semana); available: 10 h por dia (70 h).
    await approvedWorker(expert, category.id, allWeek('08:00', '09:00'));
    await approvedWorker(available, category.id, allWeek('08:00', '18:00'));
    await approvedWorker(
      otherCategory,
      category2.id,
      allWeek('08:00', '18:00'),
    );
    await approvedWorker(
      pending,
      category.id,
      allWeek('08:00', '18:00'),
      false,
    );

    jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#3366aa' },
    })
      .jpeg()
      .toBuffer();

    // Historial real del experto: dos trabajos terminados y calificados con 5.
    await finishedAndRated(expert, 5);
    await finishedAndRated(expert, 5);
  });

  afterAll(async () => {
    await app?.close();
    await scoped?.$disconnect();
    await isolated?.drop();
    await rm(storageDir, { recursive: true, force: true });
  });

  describe('Generar la recomendacion de un pedido', () => {
    it('recomienda solo aprobados de la categoria y zona, ordenados y con los criterios usados', async () => {
      const orderId = await createOrder();
      // Trabajo acordado de "available" en los proximos 7 dias: 30 min ocupados.
      await agreedOrder(available, hoursFromNow(25));
      // "available" tambien oferta en el pedido a recomendar.
      const offer = await post(
        available,
        `/offers/orders/${orderId}`,
        offerBody(nextStart()),
      ).expect(201);

      const res = await post(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(201);
      expect(res.body.orderId).toBe(orderId);
      expect(res.body.candidatesCount).toBe(2);
      expect(res.body.message).toBeNull();
      expect(res.body.criteria).toMatchObject({
        version: 1,
        reputationWeight: 50,
        completedServicesWeight: 30,
        availabilityWeight: 20,
        reviewsForConfidence: 3,
        completedServicesTarget: 10,
        availabilityHoursTarget: 20,
        neutralRating: 3,
        availabilityWindowDays: 7,
        createdBy: null,
      });

      const ids = res.body.workers.map((w: WorkerView) => w.workerId);
      expect(ids).not.toContain(otherCategory.id);
      expect(ids).not.toContain(pending.id);
      const byId = workersOf(res.body);
      const exp = byId.get(expert.id)!;
      const avl = byId.get(available.id)!;

      // Experto: 2 calificaciones de 5 -> (3*3 + 10) / 5 = 3.8 -> 70 puntos.
      expect(exp.reputation).toMatchObject({
        reviewsCount: 2,
        averageRating: '5.00',
        adjustedRating: '3.80',
        score: '70.00',
        weight: 50,
        points: '35.00',
      });
      expect(exp.completedServices).toMatchObject({ count: 2, score: '20.00' });
      // 7 h semanales. Como en la agenda (RF-30), un trabajo TERMINADO sigue
      // ocupando su franja hasta cerrarse: sus 2 trabajos de 30 min (dentro de
      // los proximos 7 dias) suman 1 h. 6 de 20 h libres -> 30 puntos.
      expect(exp.availability).toMatchObject({
        weeklyScheduleHours: '7',
        bookedHours: '1',
        freeHours: '6',
        score: '30.00',
      });
      // 70*0.5 + 20*0.3 + 30*0.2 = 35 + 6 + 6 = 47
      expect(exp.totalScore).toBe('47.00');

      // Available: sin calificaciones (neutra 3 -> 50), 0 servicios, 70 h - 0.5 h.
      expect(avl.reputation).toMatchObject({
        reviewsCount: 0,
        averageRating: null,
        adjustedRating: '3.00',
        score: '50.00',
      });
      expect(avl.reputation.explanation).toMatch(/Sin calificaciones/);
      expect(avl.completedServices).toMatchObject({ count: 0, score: '0.00' });
      expect(avl.availability).toMatchObject({
        weeklyScheduleHours: '70',
        bookedHours: '0.5',
        freeHours: '69.5',
        score: '100.00',
      });
      // 25 + 0 + 20 = 45
      expect(avl.totalScore).toBe('45.00');
      expect(avl.openOfferId).toBe(offer.body.id);
      expect(exp.openOfferId).toBeNull();

      expect(
        res.body.workers.map((w: WorkerView) => [w.workerId, w.rank]),
      ).toEqual([
        [expert.id, 1],
        [available.id, 2],
      ]);

      // Persistida: la recomendacion y sus filas quedan en la BD.
      const saved = await prisma.workerRecommendation.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { items: true },
      });
      expect(saved).toMatchObject({
        orderId,
        requestedById: client.id,
        candidatesCount: 2,
      });
      expect(saved.items).toHaveLength(2);
    });

    it('guarda el historial del pedido, de la mas reciente a la mas antigua', async () => {
      const orderId = await createOrder();
      const first = await post(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(201);
      const second = await post(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(201);
      const list = await get(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(200);
      expect(list.body.map((r: { id: string }) => r.id)).toEqual([
        second.body.id,
        first.body.id,
      ]);
    });

    it('sin candidatos guarda la recomendacion vacia con un mensaje', async () => {
      const created = await http()
        .post('/api/orders')
        .set('Authorization', auth(client))
        .field('categoryId', category2.id)
        .field('zoneId', zone.id)
        .field('description', 'Pintar las paredes del dormitorio principal')
        .field('budgetAmount', '300.00')
        .field('addressLine', ADDRESS)
        .attach('images', jpeg, { filename: 'foto.jpg' })
        .expect(201);
      const orderId = created.body.order.id as string;
      // Solo "otherCategory" es de esa categoria; se suspende su cuenta para que no quede ninguno.
      await prisma.user.update({
        where: { id: otherCategory.id },
        data: { status: 'INACTIVO' },
      });
      const res = await post(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(201);
      expect(res.body.candidatesCount).toBe(0);
      expect(res.body.workers).toEqual([]);
      expect(res.body.message).toMatch(/no hay trabajadores aprobados/);
      await prisma.user.update({
        where: { id: otherCategory.id },
        data: { status: 'ACTIVO' },
      });
    });
  });

  describe('Reglas y permisos', () => {
    it('solo el cliente dueno: otro cliente o un pedido inexistente reciben 404', async () => {
      const orderId = await createOrder();
      await post(client2, `/orders/${orderId}/recommendations`).expect(404);
      await get(client2, `/orders/${orderId}/recommendations`).expect(404);
      await post(client, `/orders/${randomUUID()}/recommendations`).expect(404);
      await post(client, '/orders/no-es-uuid/recommendations').expect(400);
    });

    it('un trabajador (que tambien es cliente) no ve pedidos ajenos (404) y sin token 401', async () => {
      const orderId = await createOrder();
      await post(expert, `/orders/${orderId}/recommendations`).expect(404);
      await http().post(`/api/orders/${orderId}/recommendations`).expect(401);
      await http().get(`/api/orders/${orderId}/recommendations`).expect(401);
    });

    it('con trabajador acordado el pedido ya no recibe recomendaciones (409)', async () => {
      const orderId = await agreedOrder(available);
      const res = await post(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(409);
      expect(res.body.message).toMatch(/publicado o en negociación/);
      // El historial se puede seguir consultando.
      await get(client, `/orders/${orderId}/recommendations`).expect(200);
    });

    it('la BD no permite modificar ni borrar recomendaciones ni criterios guardados', async () => {
      const orderId = await createOrder();
      const res = await post(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(201);
      await expect(
        prisma.workerRecommendationItem.updateMany({
          where: { recommendationId: res.body.id },
          data: { rank: 99 },
        }),
      ).rejects.toThrow(/solo insercion/);
      await expect(
        prisma.workerRecommendation.delete({ where: { id: res.body.id } }),
      ).rejects.toThrow(/solo insercion/);
      await expect(
        prisma.recommendationSettings.updateMany({
          data: { reputationWeight: 10 },
        }),
      ).rejects.toThrow(/solo insercion/);
    });

    it('la BD rechaza pesos que no suman 100', async () => {
      await expect(
        prisma.recommendationSettings.create({
          data: {
            version: 900,
            reputationWeight: 50,
            completedServicesWeight: 50,
            availabilityWeight: 50,
            reviewsForConfidence: 3,
            completedServicesTarget: 10,
            availabilityHoursTarget: 20,
            createdById: admin.id,
          },
        }),
      ).rejects.toThrow(/recommendation_settings_weights_check/);
    });
  });

  describe('Criterios del administrador', () => {
    const newCriteria = {
      reputationWeight: 20,
      completedServicesWeight: 20,
      availabilityWeight: 60,
      reviewsForConfidence: 2,
      completedServicesTarget: 5,
      availabilityHoursTarget: 40,
    };

    it('muestra la version vigente; solo administradores', async () => {
      const res = await get(admin, '/admin/recommendation-settings').expect(
        200,
      );
      expect(res.body.current).toMatchObject({
        version: 1,
        reputationWeight: 50,
      });
      expect(res.body.history).toHaveLength(1);
      await get(client, '/admin/recommendation-settings').expect(403);
      await put(client, '/admin/recommendation-settings', newCriteria).expect(
        403,
      );
    });

    it('valida los valores: pesos que no suman 100, fuera de rango o campos extra (400)', async () => {
      const sum = await put(admin, '/admin/recommendation-settings', {
        ...newCriteria,
        availabilityWeight: 50,
      }).expect(400);
      expect(sum.body.message).toMatch(/deben sumar 100/);
      await put(admin, '/admin/recommendation-settings', {
        ...newCriteria,
        availabilityHoursTarget: 200,
      }).expect(400);
      await put(admin, '/admin/recommendation-settings', {
        ...newCriteria,
        reputationWeight: 20.5,
      }).expect(400);
      await put(admin, '/admin/recommendation-settings', {
        ...newCriteria,
        extra: true,
      }).expect(400);
      const unchanged = await get(
        admin,
        '/admin/recommendation-settings',
      ).expect(200);
      expect(unchanged.body.current.version).toBe(1);
    });

    it('crea una version nueva, la registra en la bitacora y rechaza repetir los mismos valores (409)', async () => {
      const res = await put(
        admin,
        '/admin/recommendation-settings',
        newCriteria,
      ).expect(200);
      expect(res.body.current).toMatchObject({
        version: 2,
        ...newCriteria,
        createdBy: { id: admin.id },
      });
      expect(
        res.body.history.map((v: { version: number }) => v.version),
      ).toEqual([2, 1]);

      const log = await prisma.adminAuditLog.findFirstOrThrow({
        where: {
          entityType: AuditEntityType.CONFIGURACION_RECOMENDACION,
          entityId: res.body.current.id,
        },
      });
      expect(log).toMatchObject({ actorId: admin.id, action: 'EDICION' });
      expect(log.details).toMatchObject({
        version: 2,
        previousVersion: 1,
        before: { reputationWeight: 50, availabilityWeight: 20 },
        after: { reputationWeight: 20, availabilityWeight: 60 },
      });

      await put(admin, '/admin/recommendation-settings', newCriteria).expect(
        409,
      );
    });

    it('las recomendaciones nuevas usan la version nueva y las anteriores conservan la suya', async () => {
      const orderId = await createOrder();
      const before = await prisma.workerRecommendation.findFirstOrThrow({
        where: { settings: { version: 1 } },
        select: { orderId: true },
      });
      const res = await post(
        client,
        `/orders/${orderId}/recommendations`,
      ).expect(201);
      expect(res.body.criteria).toMatchObject({
        version: 2,
        availabilityWeight: 60,
      });
      // Con 60 % de disponibilidad, el trabajador con mas horas libres pasa primero.
      expect(res.body.workers[0].workerId).toBe(available.id);

      const old = await get(
        client,
        `/orders/${before.orderId}/recommendations`,
      ).expect(200);
      expect(old.body.at(-1).criteria.version).toBe(1);
    });
  });
});
