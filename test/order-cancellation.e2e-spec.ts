//=========================================================
// NUEVO: order-cancellation.e2e-spec.ts
// Fase B2 (cancelacion): registro y persistencia en PostgreSQL real, para las
// dos rutas (RF-18 cancelar pedido y RF-34 «Cancelar trabajo»).
// Comprueba:
// - el registro completo en order_status_history (quien, rol, motivo, estado
//   anterior y nuevo, fecha), reutilizando la estructura existente;
// - atomicidad: si falla el historial, el pedido o un efecto secundario, no
//   queda nada a medias (fallos provocados con triggers de PostgreSQL);
// - concurrencia: solicitudes simultaneas que esperan el bloqueo del pedido
//   producen una sola cancelacion (200) y conflictos (409);
// - el historial sigue siendo de solo insercion.
// Corre SIEMPRE en un esquema temporal con todas las migraciones: los
// triggers de fallo y los datos de prueba nunca tocan el esquema public.
//=========================================================
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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
  AdditionalBudgetStatus,
  OfferEventType,
  OfferStatus,
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
import { OrderLifecycleRegistry } from '../src/modules/orders/order-lifecycle.registry.js';
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
/** Margen entre el reloj de la aplicacion y el de la base. */
const CLOCK_TOLERANCE_MS = 5_000;
const SIMULTANEOUS = 5;

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

/** Las dos rutas de cancelacion y un pedido valido para cada una. */
const ROUTES = [
  {
    name: 'cancelar pedido (RF-18)',
    url: (orderId: string) => `/orders/me/${orderId}/cancel`,
    from: OrderStatus.EN_NEGOCIACION,
  },
  {
    name: 'cancelar trabajo (RF-34)',
    url: (orderId: string) => `/orders/${orderId}/cancel-work`,
    from: OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
  },
] as const;
type Route = (typeof ROUTES)[number];

describe('Registro y persistencia de cancelaciones (B2, e2e)', () => {
  let app: INestApplication<App>;
  let isolated: IsolatedSchema;
  let scoped: PrismaClient;
  /** Conexion independiente de la aplicacion: observa lo confirmado. */
  let observer: pg.Client;
  let jwt: JwtService;
  let storageDir: string;
  let jpeg: Buffer;

  let client: PublicUser;
  let worker: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;

  /** Pedidos cuyo efecto posterior al commit (afterCommit) se ejecuto. */
  const committed: string[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);
  const cancel = (route: Route, orderId: string, reason: string) =>
    post(client, route.url(orderId), { reason });

  let slot = 0;
  const nextSlot = () => {
    const n = slot++;
    return nextMondayAt(8 + (n % 9), Math.floor(n / 9));
  };

  /** Pedido EN_NEGOCIACION con una oferta vigente del trabajador. */
  const negotiatingOrder = async () => {
    const created = await http()
      .post('/api/orders')
      .set('Authorization', auth(client))
      .field('categoryId', category.id)
      .field('zoneId', zone.id)
      .field('description', 'Fuga de agua debajo del lavaplatos de la cocina')
      .field('budgetAmount', '150.00')
      .field('addressLine', 'Av. Siempre Viva 742')
      .attach('images', jpeg, { filename: 'foto.jpg' })
      .expect(201);
    const orderId = created.body.order.id as string;
    const offer = await post(worker, `/offers/orders/${orderId}`, {
      amount: '120.50',
      requiresVisit: false,
      materialsIncluded: false,
      proposedStartAt: nextSlot().toISOString(),
      estimatedDurationMinutes: 30,
    }).expect(201);
    return { orderId, offerId: offer.body.id as string };
  };

  /** Pedido con acuerdo, en ejecucion y con un presupuesto adicional pendiente. */
  const agreedOrderWithPendingBudget = async () => {
    const { orderId, offerId } = await negotiatingOrder();
    await post(client, `/offers/${offerId}/accept`).expect(200);
    await post(worker, `/orders/${orderId}/payments/ANTICIPO/declarations`, {
      amount: '30.13',
      method: 'EFECTIVO',
    }).expect(201);
    await post(worker, `/orders/${orderId}/start`).expect(200);
    await post(worker, `/orders/${orderId}/additional-budgets`, {
      amount: '10',
      reason: 'Repuesto',
      materials: 'Llave de paso',
    }).expect(201);
    return { orderId, offerId };
  };

  const orderFor = (route: Route) =>
    route.from === OrderStatus.EN_NEGOCIACION
      ? negotiatingOrder()
      : agreedOrderWithPendingBudget();

  const historyOf = (orderId: string) =>
    scoped.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const cancellationsOf = (orderId: string) =>
    scoped.orderStatusHistory.findMany({
      where: { orderId, toStatus: OrderStatus.CANCELADO },
    });
  const noticesOf = (orderId: string) =>
    scoped.notification.findMany({
      where: { type: 'PEDIDO_CANCELADO', resourceId: orderId },
    });

  /** Todo lo que una cancelacion puede modificar. */
  const snapshot = async (orderId: string) => ({
    order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
    history: await historyOf(orderId),
    offers: await scoped.offer.findMany({ where: { orderId } }),
    offerEvents: await scoped.offerEvent.count({ where: { orderId } }),
    budgets: await scoped.additionalBudget.findMany({ where: { orderId } }),
    notices: await noticesOf(orderId),
    images: await scoped.orderImage.count({ where: { orderId } }),
    addresses: await scoped.orderAddress.count({ where: { orderId } }),
    pendingFiles: await scoped.pendingFileDeletion.count(),
  });

  /**
   * Hace fallar una escritura real en PostgreSQL mientras se ejecuta `work`.
   * El trigger vive solo en el esquema temporal.
   */
  const whileWriteFails = async (
    table: string,
    event: 'INSERT' | 'UPDATE',
    condition: string,
    work: () => PromiseLike<unknown>,
  ) => {
    const target = `"${isolated.schema}"."${table}"`;
    await observer.query(
      `CREATE OR REPLACE FUNCTION "${isolated.schema}"."e2e_fail"() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo e2e'; END; $$`,
    );
    await observer.query(
      `CREATE TRIGGER "e2e_fail" BEFORE ${event} ON ${target}
       FOR EACH ROW WHEN (${condition})
       EXECUTE FUNCTION "${isolated.schema}"."e2e_fail"()`,
    );
    try {
      await work();
    } finally {
      await observer.query(`DROP TRIGGER "e2e_fail" ON ${target}`);
    }
  };

  const lockWaiters = async () => {
    const { rows } = await observer.query<{ total: number }>(
      `SELECT count(*)::int AS "total" FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    return rows[0].total;
  };

  /**
   * Contencion real: retiene el bloqueo del pedido, lanza las solicitudes,
   * espera a que TODAS esten detenidas en PostgreSQL y recien entonces libera.
   */
  const raceOnOrder = async (
    orderId: string,
    requests: (() => request.Test)[],
  ) => {
    const { pending } = await scoped.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
        // supertest envia la solicitud recien al llamar a then().
        const sent = requests.map((send) => send().then((res) => res));
        await vi.waitFor(
          async () => expect(await lockWaiters()).toBe(requests.length),
          { timeout: 3_000, interval: 25 },
        );
        return { pending: sent };
      },
      { timeout: 10_000 },
    );
    return Promise.all(pending);
  };

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'cancel-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    isolated = await createIsolatedSchema('cancel');
    // Cliente propio con search_path: la aplicacion usa SQL crudo sin esquema.
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
    app.get(OrderLifecycleRegistry).register({
      name: 'cancel-e2e',
      afterCommit: (event) => {
        committed.push(event.orderId);
        return Promise.resolve();
      },
    });
    const catalogs = app.get(CatalogsService);
    const users = app.get(UsersService);
    const profiles = app.get(WorkerProfileService);
    const newUser = (name: string, phone?: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}@cancel-e2e.test`,
        passwordHash: 'hash',
        phone,
      });
    const admin = await newUser('admin');
    client = await newUser('client');
    worker = await newUser('worker', '71000009');
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

  describe.each(ROUTES)('$name', (route) => {
    it('guarda quien, con que rol, por que, desde y hacia que estado y cuando', async () => {
      const { orderId } = await orderFor(route);
      const before = await historyOf(orderId);
      const startedAt = Date.now();

      const res = await cancel(route, orderId, '  Cambio de planes  ').expect(
        200,
      );
      expect(res.body.status).toBe(OrderStatus.CANCELADO);

      const after = await historyOf(orderId);
      // Los registros anteriores siguen intactos y hay exactamente uno mas.
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
      const row = after[before.length];
      expect(row).toMatchObject({
        orderId,
        fromStatus: route.from,
        toStatus: OrderStatus.CANCELADO,
        actorType: 'USUARIO',
        changedById: client.id,
        actorRole: RoleName.CLIENTE,
        systemProcess: null,
        reason: 'Cambio de planes',
      });
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(
        startedAt - CLOCK_TOLERANCE_MS,
      );
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(
        Date.now() + CLOCK_TOLERANCE_MS,
      );

      // Persistido: otra conexion ve el pedido y su registro confirmados.
      const { rows } = await observer.query(
        `SELECT o."status"::text AS "status", o."cancelled_at" IS NOT NULL AS "dated",
                h."reason", h."changed_by_id"::text AS "actor"
         FROM "${isolated.schema}"."orders" o
         JOIN "${isolated.schema}"."order_status_history" h
           ON h."order_id" = o."id" AND h."to_status" = 'CANCELADO'
         WHERE o."id" = $1`,
        [orderId],
      );
      expect(rows).toEqual([
        {
          status: 'CANCELADO',
          dated: true,
          reason: 'Cambio de planes',
          actor: client.id,
        },
      ]);
    });

    it.each([
      [
        'el registro del historial',
        'order_status_history',
        'INSERT',
        `NEW."to_status" = 'CANCELADO'`,
      ],
      [
        'la actualizacion del pedido',
        'orders',
        'UPDATE',
        `NEW."status" = 'CANCELADO'`,
      ],
      [
        'un efecto secundario (el aviso, ultimo en escribirse)',
        'notifications',
        'INSERT',
        `NEW."type" = 'PEDIDO_CANCELADO'`,
      ],
    ] as const)(
      'si falla %s no queda nada a medias',
      async (_label, table, event, condition) => {
        const { orderId } = await orderFor(route);
        const before = await snapshot(orderId);
        committed.length = 0;

        await whileWriteFails(table, event, condition, () =>
          cancel(route, orderId, 'Debe revertirse').expect(500),
        );

        expect(await snapshot(orderId)).toEqual(before);
        expect(committed).toEqual([]);
        // Sin el fallo, la misma solicitud se completa una sola vez.
        await cancel(route, orderId, 'Segundo intento').expect(200);
        expect(await cancellationsOf(orderId)).toHaveLength(1);
        expect(committed).toEqual([orderId]);
      },
    );

    it(`${SIMULTANEOUS} solicitudes simultaneas: una cancela y las demas reciben 409`, async () => {
      const { orderId, offerId } = await orderFor(route);
      committed.length = 0;
      const reasons = Array.from(
        { length: SIMULTANEOUS },
        (_, i) => `motivo ${i}`,
      );

      const results = await raceOnOrder(
        orderId,
        reasons.map((reason) => () => cancel(route, orderId, reason)),
      );

      const statuses = results.map((r) => r.status);
      expect([...statuses].sort((a, b) => a - b)).toEqual([
        200, 409, 409, 409, 409,
      ]);
      // Queda el motivo de la solicitud que gano.
      const rows = await cancellationsOf(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe(reasons[statuses.indexOf(200)]);
      // Los efectos secundarios se ejecutaron una sola vez.
      expect(committed).toEqual([orderId]);
      expect((await noticesOf(orderId)).map((n) => n.userId)).toEqual([
        worker.id,
      ]);
      if (route.from === OrderStatus.EN_NEGOCIACION) {
        const offer = await scoped.offer.findUniqueOrThrow({
          where: { id: offerId },
        });
        expect(offer.status).toBe(OfferStatus.SIN_EFECTO);
        expect(
          await scoped.offerEvent.count({
            where: { offerId, type: OfferEventType.SIN_EFECTO },
          }),
        ).toBe(1);
        expect(await scoped.orderImage.count({ where: { orderId } })).toBe(0);
      } else {
        const budgets = await scoped.additionalBudget.findMany({
          where: { orderId },
        });
        expect(budgets.map((b) => b.status)).toEqual([
          AdditionalBudgetStatus.SIN_EFECTO_POR_CANCELACION,
        ]);
        // Con acuerdo, los datos del pedido se conservan.
        expect(await scoped.orderImage.count({ where: { orderId } })).toBe(1);
      }
    });

    it('repetir despues no cambia el registro, que es de solo insercion', async () => {
      const { orderId } = await orderFor(route);
      await cancel(route, orderId, 'Motivo original').expect(200);
      const before = await snapshot(orderId);

      await cancel(route, orderId, 'Otro motivo').expect(409);
      const [row] = await cancellationsOf(orderId);
      await expect(
        scoped.orderStatusHistory.update({
          where: { id: row.id },
          data: { reason: 'Sobrescrito' },
        }),
      ).rejects.toThrow();
      await expect(
        scoped.orderStatusHistory.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      await expect(
        observer.query(`TRUNCATE "${isolated.schema}"."order_status_history"`),
      ).rejects.toThrow(/solo inserci/);

      expect(await snapshot(orderId)).toEqual(before);
    });
  });

  it('las dos rutas a la vez sobre un pedido con acuerdo: una sola cancelacion', async () => {
    const { orderId } = await agreedOrderWithPendingBudget();
    const results = await raceOnOrder(
      orderId,
      ROUTES.map((route) => () => cancel(route, orderId, route.name)),
    );
    // La ruta de pedido sin acuerdo no admite este estado, gane quien gane.
    expect(results.map((r) => r.status)).toEqual([409, 200]);
    expect((await cancellationsOf(orderId)).map((r) => r.reason)).toEqual([
      ROUTES[1].name,
    ]);
  });

  it('cancelar y aceptar la oferta a la vez: gana una sola y el estado es coherente', async () => {
    const { orderId, offerId } = await negotiatingOrder();
    const [cancelled, accepted] = await raceOnOrder(orderId, [
      () => cancel(ROUTES[0], orderId, 'carrera'),
      () => post(client, `/offers/${offerId}/accept`),
    ]);
    expect([cancelled.status, accepted.status].sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);

    const order = await scoped.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    const offer = await scoped.offer.findUniqueOrThrow({
      where: { id: offerId },
    });
    const won = cancelled.status === 200;
    expect(order.status).toBe(
      won ? OrderStatus.CANCELADO : OrderStatus.ACORDADO,
    );
    expect(offer.status).toBe(
      won ? OfferStatus.SIN_EFECTO : OfferStatus.ACEPTADA,
    );
    expect(order.assignedWorkerId).toBe(won ? null : worker.id);
    expect(await cancellationsOf(orderId)).toHaveLength(won ? 1 : 0);
  });
});
