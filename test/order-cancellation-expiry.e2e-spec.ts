//=========================================================
// NUEVO: order-cancellation-expiry.e2e-spec.ts
// Fase B5 (cancelacion): vencimiento durante la espera del bloqueo, con la API
// y PostgreSQL reales. La prueba principal NO falsea fechas pasadas: la
// solicitud empieza con el pedido vigente, queda detenida en PostgreSQL por el
// bloqueo, el pedido vence de verdad mientras espera y recien entonces se
// libera.
// Reglas: se decide con la hora posterior al bloqueo; un pedido vencido
// responde 409 sin ningun cambio; los pedidos con acuerdo no vencen.
// Corre SIEMPRE en un esquema temporal: nunca toca el esquema public.
//=========================================================
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import {
  OfferStatus,
  OrderStatus,
  Prisma,
  PrismaClient,
  RoleName,
  WorkerProfileStatus,
} from '../src/generated/prisma/client.js';
import {
  CatalogItem,
  CatalogKind,
  CatalogsService,
} from '../src/modules/catalogs/catalogs.service.js';
import { OrderExpirationService } from '../src/modules/orders/order-expiration.service.js';
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

const RUN_ID = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;
/**
 * Plazo que se le deja al pedido antes de bloquearlo. Menor que el tiempo
 * maximo de la transaccion que espera (5 s por defecto en Prisma).
 */
const SECONDS_LEFT = 1.5;

/** Proximo lunes (>= 1 dia) a la hora local de La Paz (UTC-4). */
const nextMondayAt = (hour: number, weeksAhead = 0): Date => {
  const date = new Date(Date.now() + DAY);
  date.setUTCHours(12, 0, 0, 0);
  while (date.getUTCDay() !== 1) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  date.setUTCDate(date.getUTCDate() + weeksAhead * 7);
  date.setUTCHours(hour + 4, 0, 0, 0);
  return date;
};

describe('Vencimiento durante la espera del bloqueo (B5, e2e)', () => {
  let app: INestApplication<App>;
  let isolated: IsolatedSchema;
  let scoped: PrismaClient;
  /** Conexion independiente: observa las esperas y la hora de la base. */
  let observer: pg.Client;
  let jwt: JwtService;
  let expiration: OrderExpirationService;
  let storageDir: string;
  let jpeg: Buffer;

  let client: PublicUser;
  let worker: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);

  const cancelOrder = (orderId: string) =>
    post(client, `/orders/me/${orderId}/cancel`, { reason: 'Cambio' });
  const cancelWork = (orderId: string) =>
    post(client, `/orders/${orderId}/cancel-work`, { reason: 'Cambio' });

  let slot = 0;
  const nextSlot = () => {
    const n = slot++;
    return nextMondayAt(8 + (n % 9), Math.floor(n / 9));
  };

  const publishedOrder = async () => {
    const created = await http()
      .post('/api/orders')
      .set('Authorization', auth(client))
      .field('categoryId', category.id)
      .field('zoneId', zone.id)
      .field('description', 'Fuga de agua debajo del lavaplatos de la cocina')
      .field('budgetAmount', '400.00')
      .field('addressLine', 'Av. Siempre Viva 742')
      .attach('images', jpeg, { filename: 'foto.jpg' })
      .expect(201);
    return created.body.order.id as string;
  };

  const negotiatingOrder = async () => {
    const orderId = await publishedOrder();
    const offer = await post(worker, `/offers/orders/${orderId}`, {
      amount: '400.00',
      requiresVisit: false,
      materialsIncluded: false,
      proposedStartAt: nextSlot().toISOString(),
      estimatedDurationMinutes: 30,
    }).expect(201);
    return { orderId, offerId: offer.body.id as string };
  };

  /** Fija el vencimiento a `seconds` del reloj actual de la base. */
  const expireIn = (orderId: string, seconds: number) =>
    scoped.$executeRaw`UPDATE "orders" SET "expires_at" = clock_timestamp() + make_interval(secs => ${seconds}::double precision) WHERE "id" = ${orderId}::uuid`;

  const isExpired = async (orderId: string) => {
    const { rows } = await observer.query<{ expired: boolean }>(
      `SELECT "expires_at" <= clock_timestamp() AS "expired"
       FROM "${isolated.schema}"."orders" WHERE "id" = $1`,
      [orderId],
    );
    return rows[0].expired;
  };

  const waitUntilExpired = (orderId: string) =>
    vi.waitFor(async () => expect(await isExpired(orderId)).toBe(true), {
      timeout: 4_000,
      interval: 50,
    });

  /** Transacciones detenidas por un bloqueo y si empezaron antes del plazo. */
  const waiters = async (orderId: string) => {
    const { rows } = await observer.query<{ beforeExpiry: boolean }>(
      `SELECT a.xact_start < o."expires_at" AS "beforeExpiry"
       FROM pg_stat_activity a, "${isolated.schema}"."orders" o
       WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
         AND o."id" = $1`,
      [orderId],
    );
    return rows;
  };

  /**
   * Retiene el bloqueo del pedido, envia las solicitudes de a una (quedan
   * detenidas en PostgreSQL en ese orden), ejecuta `whileHeld` y libera.
   */
  const queueOnOrder = async (
    orderId: string,
    requests: (() => request.Test)[],
    whileHeld: (tx: Prisma.TransactionClient) => Promise<void>,
  ) => {
    const { pending } = await scoped.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
        const sent: Promise<request.Response>[] = [];
        for (const send of requests) {
          sent.push(send().then((res) => res));
          await vi.waitFor(
            async () =>
              expect(await waiters(orderId)).toHaveLength(sent.length),
            { timeout: 1_000, interval: 20 },
          );
        }
        await whileHeld(tx);
        return { pending: sent };
      },
      { timeout: 10_000 },
    );
    return Promise.all(pending);
  };

  /** Todo lo que una cancelacion podria modificar. */
  const snapshot = async (orderId: string) => ({
    order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
    history: await scoped.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
    }),
    offers: await scoped.offer.findMany({ where: { orderId } }),
    offerEvents: await scoped.offerEvent.count({ where: { orderId } }),
    budgets: await scoped.additionalBudget.count({ where: { orderId } }),
    summaries: await scoped.orderCancellationSummary.count({
      where: { orderId },
    }),
    notices: await scoped.notification.findMany({
      where: { resourceId: orderId },
      orderBy: { id: 'asc' },
    }),
    images: await scoped.orderImage.findMany({ where: { orderId } }),
    addresses: await scoped.orderAddress.count({ where: { orderId } }),
    pendingFiles: await scoped.pendingFileDeletion.count(),
    files: (
      await readdir(storageDir, { recursive: true, withFileTypes: true })
    ).filter((entry) => entry.isFile()).length,
  });

  /** El pedido y sus datos, sin el plazo que la prueba mueve. */
  const withoutDeadline = (state: Awaited<ReturnType<typeof snapshot>>) => ({
    ...state,
    order: { ...state.order, expiresAt: null, updatedAt: null },
  });

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'expiry-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    isolated = await createIsolatedSchema('cancel_expiry');
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
    observer = new pg.Client({
      connectionString: process.env.DATABASE_URL!,
      options: '-c TimeZone=UTC',
    });
    await observer.connect();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(scoped)
      .compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    jwt = app.get(JwtService);
    expiration = app.get(OrderExpirationService);
    const catalogs = app.get(CatalogsService);
    const users = app.get(UsersService);
    const profiles = app.get(WorkerProfileService);
    const newUser = (name: string, phone?: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}@expiry-e2e.test`,
        passwordHash: 'hash',
        phone,
      });
    const admin = await newUser('admin');
    client = await newUser('client');
    worker = await newUser('worker', '71000041');
    await scoped.userRole.create({
      data: { userId: admin.id, role: RoleName.ADMINISTRADOR },
    });
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Plomeria ${RUN_ID}`,
    });
    zone = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Norte ${RUN_ID}`,
    });
    const profile = await profiles.create(worker.id, {
      yearsOfExperience: 5,
      zoneId: zone.id,
      categoryIds: [category.id],
      schedules: [{ dayOfWeek: 'LUNES', startTime: '08:00', endTime: '18:00' }],
    });
    await profiles.submit(worker.id);
    await profiles.changeStatusByAdmin(admin.id, profile.id, {
      status: WorkerProfileStatus.APROBADO,
    });
    jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#3366aa' },
    })
      .jpeg()
      .toBuffer();
  });

  afterAll(async () => {
    await app?.close();
    await scoped?.$disconnect();
    await observer?.end();
    await isolated?.drop();
    await rm(storageDir, { recursive: true, force: true });
  });

  /** Los pedidos que pueden vencer y la ruta que se intenta sobre ellos. */
  const CASES = [
    {
      name: 'cancelar pedido, PUBLICADO',
      create: publishedOrder,
      cancel: cancelOrder,
      message: 'El pedido venció y ya no se puede cancelar.',
    },
    {
      name: 'cancelar pedido, EN_NEGOCIACION',
      create: async () => (await negotiatingOrder()).orderId,
      cancel: cancelOrder,
      message: 'El pedido venció y ya no se puede cancelar.',
    },
    {
      name: 'cancelar trabajo, EN_NEGOCIACION',
      create: async () => (await negotiatingOrder()).orderId,
      cancel: cancelWork,
      message: 'No se puede cancelar el trabajo de un pedido en estado VENCIDO',
    },
  ];

  describe.each(CASES)('$name', ({ create, cancel, message }) => {
    it('vence mientras la solicitud espera el bloqueo: 409 sin cambios', async () => {
      const orderId = await create();
      await expireIn(orderId, SECONDS_LEFT);
      const before = await snapshot(orderId);

      const [res] = await queueOnOrder(
        orderId,
        [() => cancel(orderId)],
        async () => {
          // La solicitud ya espera y su transaccion empezo con el plazo
          // vigente: con now() se habria considerado no vencido.
          expect(await waiters(orderId)).toEqual([{ beforeExpiry: true }]);
          expect(await isExpired(orderId)).toBe(false);
          await waitUntilExpired(orderId);
          expect(await waiters(orderId)).toHaveLength(1);
        },
      );

      expect(res.status).toBe(409);
      expect(res.body.message).toBe(message);
      expect(await snapshot(orderId)).toEqual(before);
    });

    it('ya vencido antes de la solicitud: 409 sin cambios', async () => {
      const orderId = await create();
      await expireIn(orderId, -1);
      const before = await snapshot(orderId);
      const res = await cancel(orderId).expect(409);
      expect(res.body.message).toBe(message);
      expect(await snapshot(orderId)).toEqual(before);
    });
  });

  describe('pedido vigente', () => {
    it.each([
      ['PUBLICADO', publishedOrder],
      ['EN_NEGOCIACION', async () => (await negotiatingOrder()).orderId],
    ])('se cancela desde %s', async (_label, create) => {
      const orderId = await create();
      await cancelOrder(orderId).expect(200);
      expect((await snapshot(orderId)).summaries).toBe(1);
    });

    it('obtiene el bloqueo antes del vencimiento: se cancela, y sigue cancelado al pasar el plazo', async () => {
      const { orderId, offerId } = await negotiatingOrder();
      await expireIn(orderId, SECONDS_LEFT);
      await cancelOrder(orderId).expect(200);
      expect(await isExpired(orderId)).toBe(false);

      await waitUntilExpired(orderId);
      await expiration.expireDue();
      const state = await snapshot(orderId);
      expect(state.order.status).toBe(OrderStatus.CANCELADO);
      expect(state.summaries).toBe(1);
      expect(
        (await scoped.offer.findUniqueOrThrow({ where: { id: offerId } }))
          .status,
      ).toBe(OfferStatus.SIN_EFECTO);
    });

    it('espera el bloqueo y lo obtiene antes del vencimiento: se cancela', async () => {
      const orderId = await publishedOrder();
      await expireIn(orderId, 60);
      const [res] = await queueOnOrder(
        orderId,
        [() => cancelOrder(orderId)],
        async () => undefined,
      );
      expect(res.status).toBe(200);
    });
  });

  describe('junto a otras operaciones sobre el pedido', () => {
    it('otra transaccion modifica el pedido mientras vence: 409 y solo queda su cambio', async () => {
      const orderId = await publishedOrder();
      await expireIn(orderId, SECONDS_LEFT);
      const before = await snapshot(orderId);

      const [res] = await queueOnOrder(
        orderId,
        [() => cancelOrder(orderId)],
        async (tx) => {
          await tx.$executeRaw`UPDATE "orders" SET "budget_amount" = 500 WHERE "id" = ${orderId}::uuid`;
          await waitUntilExpired(orderId);
        },
      );

      expect(res.status).toBe(409);
      const after = await snapshot(orderId);
      expect(after.order.budgetAmount.toFixed(2)).toBe('500.00');
      expect(
        withoutDeadline({
          ...after,
          order: { ...after.order, budgetAmount: before.order.budgetAmount },
        }),
      ).toEqual(withoutDeadline(before));
    });

    it('otra transaccion adelanta el vencimiento mientras la solicitud espera: 409', async () => {
      const orderId = await publishedOrder();
      const [res] = await queueOnOrder(
        orderId,
        [() => cancelOrder(orderId)],
        async (tx) => {
          await tx.$executeRaw`UPDATE "orders" SET "expires_at" = clock_timestamp() WHERE "id" = ${orderId}::uuid`;
        },
      );
      expect(res.status).toBe(409);
      expect((await snapshot(orderId)).summaries).toBe(0);
    });

    it('la tarea de vencimiento omite el pedido bloqueado y lo vence despues del rechazo', async () => {
      const { orderId, offerId } = await negotiatingOrder();
      await expireIn(orderId, SECONDS_LEFT);
      const [res] = await queueOnOrder(
        orderId,
        [() => cancelOrder(orderId)],
        async () => {
          await waitUntilExpired(orderId);
          await expiration.expireDue();
        },
      );
      expect(res.status).toBe(409);
      // Segun quien tomo la fila al liberarse, ya puede estar vencido.
      await expiration.expireDue();
      const state = await snapshot(orderId);
      expect(state.order.status).toBe(OrderStatus.VENCIDO);
      expect(state.summaries).toBe(0);
      expect(
        (await scoped.offer.findUniqueOrThrow({ where: { id: offerId } }))
          .status,
      ).toBe(OfferStatus.VENCIDA);
    });

    it('dos cancelaciones esperando mientras vence: ambas 409 sin cambios', async () => {
      const { orderId } = await negotiatingOrder();
      await expireIn(orderId, SECONDS_LEFT);
      const before = await snapshot(orderId);
      const results = await queueOnOrder(
        orderId,
        [() => cancelOrder(orderId), () => cancelOrder(orderId)],
        async () => {
          await waitUntilExpired(orderId);
        },
      );
      expect(results.map((r) => r.status)).toEqual([409, 409]);
      expect(await snapshot(orderId)).toEqual(before);
    });

    it('con acuerdo no hay vencimiento: se cancela aunque el plazo pase durante la espera', async () => {
      const { orderId, offerId } = await negotiatingOrder();
      await post(client, `/offers/${offerId}/accept`).expect(200);
      await expireIn(orderId, SECONDS_LEFT);
      const [res] = await queueOnOrder(
        orderId,
        [() => cancelWork(orderId)],
        async () => {
          await waitUntilExpired(orderId);
        },
      );
      expect(res.status).toBe(200);
      expect((await snapshot(orderId)).summaries).toBe(1);
    });
  });
});
