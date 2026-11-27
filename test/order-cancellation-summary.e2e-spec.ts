//=========================================================
// NUEVO: order-cancellation-summary.e2e-spec.ts
// Fase B3 (cancelacion): captura de la fotografia economica por las dos rutas
// de cancelacion, con la API y PostgreSQL reales.
// Reglas: saldo = total actualizado - anticipo confirmado por el trabajador;
// declaraciones originales conservadas; solo adicionales aceptados; visita
// aparte; sin acuerdo importes null; despues de cancelar no se declaran
// anticipo ni saldo.
// Comprueba atomicidad (fallos reales con triggers), concurrencia (solicitudes
// detenidas por el bloqueo del pedido) y que la fotografia no cambia.
// Corre SIEMPRE en un esquema temporal: nunca toca el esquema public.
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
import { OrderExpirationService } from '../src/modules/orders/order-expiration.service.js';
import type { CancellationSummaryDetails } from '../src/modules/payments/cancellation-summary.js';
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
const REASON = { reason: 'Cambio de planes' };

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

describe('Fotografia economica al cancelar (B3, e2e)', () => {
  let app: INestApplication<App>;
  let isolated: IsolatedSchema;
  let scoped: PrismaClient;
  /** Conexion independiente: observa lo confirmado y provoca fallos. */
  let observer: pg.Client;
  let jwt: JwtService;
  let expiration: OrderExpirationService;
  let storageDir: string;
  let jpeg: Buffer;

  let client: PublicUser;
  let worker: PublicUser;
  let otherWorker: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);

  const cancelOrder = (orderId: string) =>
    post(client, `/orders/me/${orderId}/cancel`, REASON);
  const cancelWork = (orderId: string) =>
    post(client, `/orders/${orderId}/cancel-work`, REASON);
  const declare = (
    user: PublicUser,
    orderId: string,
    concept: 'ANTICIPO' | 'VISITA' | 'SALDO',
    amount: string,
    method: 'EFECTIVO' | 'QR' = 'EFECTIVO',
  ) =>
    post(user, `/orders/${orderId}/payments/${concept}/declarations`, {
      amount,
      method,
    });
  /** El anticipo de un acuerdo de 400 es exactamente 100. */
  const confirmAdvance = (orderId: string) =>
    declare(worker, orderId, 'ANTICIPO', '100.00');

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

  const negotiatingOrder = async (requiresVisit = false) => {
    const orderId = await publishedOrder();
    const offer = await post(worker, `/offers/orders/${orderId}`, {
      amount: '400.00',
      requiresVisit,
      ...(requiresVisit ? { visitCost: '30.00' } : {}),
      materialsIncluded: false,
      proposedStartAt: nextSlot().toISOString(),
      estimatedDurationMinutes: 30,
    }).expect(201);
    return { orderId, offerId: offer.body.id as string };
  };

  /** Pedido ACORDADO por 400. */
  const agreedOrder = async (requiresVisit = false) => {
    const ids = await negotiatingOrder(requiresVisit);
    await post(client, `/offers/${ids.offerId}/accept`).expect(200);
    return ids;
  };

  const executingOrder = async () => {
    const ids = await agreedOrder();
    await confirmAdvance(ids.orderId).expect(201);
    await post(worker, `/orders/${ids.orderId}/start`).expect(200);
    return ids;
  };

  const proposeBudget = async (orderId: string, amount: string) => {
    await post(worker, `/orders/${orderId}/additional-budgets`, {
      amount,
      reason: 'Repuesto',
      materials: 'Llave de paso',
    }).expect(201);
    const pending = await scoped.additionalBudget.findFirstOrThrow({
      where: { orderId, status: 'PENDIENTE' },
    });
    return pending.id;
  };
  const acceptBudget = (orderId: string, budgetId: string) =>
    post(client, `/orders/${orderId}/additional-budgets/${budgetId}/accept`);

  const summaryOf = (orderId: string) =>
    scoped.orderCancellationSummary.findUnique({ where: { orderId } });

  /** Importes de la fotografia como texto, para compararlos juntos. */
  const amountsOf = async (orderId: string) => {
    const s = await scoped.orderCancellationSummary.findUniqueOrThrow({
      where: { orderId },
    });
    const text = (value: { toFixed(d: number): string } | null) =>
      value?.toFixed(2) ?? null;
    return {
      agreed: text(s.agreedAmount),
      additional: text(s.acceptedAdditionalTotal),
      updated: text(s.updatedTotal),
      confirmed: text(s.confirmedAdvanceTotal),
      unconfirmed: text(s.unconfirmedAdvanceAmount),
      balance: text(s.pendingBalance),
      visit: text(s.visitCost),
    };
  };
  const detailsOf = async (orderId: string) =>
    (await summaryOf(orderId))!
      .details as unknown as CancellationSummaryDetails;

  /** Todo lo que una cancelacion puede modificar. */
  const snapshot = async (orderId: string) => ({
    order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
    history: await scoped.orderStatusHistory.count({ where: { orderId } }),
    offers: await scoped.offer.findMany({ where: { orderId } }),
    offerEvents: await scoped.offerEvent.count({ where: { orderId } }),
    budgets: await scoped.additionalBudget.findMany({ where: { orderId } }),
    declarations: await scoped.paymentDeclaration.count({
      where: { payment: { orderId } },
    }),
    notices: await scoped.notification.count({
      where: { resourceId: orderId },
    }),
    images: await scoped.orderImage.count({ where: { orderId } }),
    summary: await summaryOf(orderId),
  });

  const whileInsertFails = async (
    table: string,
    work: () => PromiseLike<unknown>,
  ) => {
    const target = `"${isolated.schema}"."${table}"`;
    await observer.query(
      `CREATE OR REPLACE FUNCTION "${isolated.schema}"."e2e_fail"() RETURNS trigger
       LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fallo e2e'; END; $$`,
    );
    await observer.query(
      `CREATE TRIGGER "e2e_fail" BEFORE INSERT ON ${target}
       FOR EACH ROW EXECUTE FUNCTION "${isolated.schema}"."e2e_fail"()`,
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
   * Retiene el bloqueo del pedido y envia las solicitudes de a una, esperando
   * que cada una quede detenida en PostgreSQL: se atienden en ese orden.
   */
  const queueOnOrder = async (
    orderId: string,
    requests: (() => request.Test)[],
  ) => {
    const { pending } = await scoped.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
        const sent: Promise<request.Response>[] = [];
        for (const send of requests) {
          sent.push(send().then((res) => res));
          await vi.waitFor(
            async () => expect(await lockWaiters()).toBe(sent.length),
            { timeout: 3_000, interval: 25 },
          );
        }
        return { pending: sent };
      },
      { timeout: 10_000 },
    );
    return Promise.all(pending);
  };

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'summary-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    isolated = await createIsolatedSchema('cancel_summary');
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
        email: `${name}-${RUN_ID}@summary-e2e.test`,
        passwordHash: 'hash',
        phone,
      });
    const admin = await newUser('admin');
    client = await newUser('client');
    worker = await newUser('worker', '71000021');
    otherWorker = await newUser('other', '71000022');
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

  describe('sin acuerdo', () => {
    it.each([
      ['PUBLICADO', publishedOrder],
      ['EN_NEGOCIACION', async () => (await negotiatingOrder()).orderId],
    ])('desde %s guarda todos los importes en NULL', async (_label, create) => {
      const orderId = await create();
      await cancelOrder(orderId).expect(200);
      expect(await summaryOf(orderId)).toMatchObject({
        acceptedOfferId: null,
        agreedAt: null,
        details: {
          advance: null,
          additionalBudgets: [],
          visit: null,
          otherPayments: [],
        },
        schemaVersion: 1,
      });
      expect(Object.values(await amountsOf(orderId))).toEqual(
        Array(7).fill(null),
      );
    });

    it('un pedido vencido no genera fotografia', async () => {
      const orderId = await publishedOrder();
      await scoped.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 second' WHERE "id" = ${orderId}::uuid`;
      await expiration.expireDue();
      expect(
        (await scoped.order.findUniqueOrThrow({ where: { id: orderId } }))
          .status,
      ).toBe(OrderStatus.VENCIDO);
      expect(await summaryOf(orderId)).toBeNull();
    });
  });

  describe('con acuerdo', () => {
    const base = {
      agreed: '400.00',
      additional: '0.00',
      updated: '400.00',
      confirmed: '0.00',
      unconfirmed: null,
      balance: '400.00',
      visit: null,
    };

    it('sin anticipos: guarda la oferta, la fecha del acuerdo y el saldo total', async () => {
      const { orderId, offerId } = await agreedOrder();
      const startedAt = Date.now();
      await cancelWork(orderId).expect(200);

      expect(await amountsOf(orderId)).toEqual(base);
      const summary = (await summaryOf(orderId))!;
      expect(summary.acceptedOfferId).toBe(offerId);
      const accepted = await scoped.offerEvent.findFirstOrThrow({
        where: { offerId, type: 'ACEPTADA' },
      });
      expect(summary.agreedAt).toEqual(accepted.createdAt);
      expect(summary.capturedAt.getTime()).toBeGreaterThan(startedAt - 5_000);
      expect((await detailsOf(orderId)).advance).toEqual({
        paymentId: null,
        expectedAmount: null,
        status: 'SIN_DECLARACIONES',
        declarations: [],
      });
    });

    it('anticipo declarado por el cliente: sin confirmar y sin reducir el saldo', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO', '100.00', 'QR').expect(201);
      await cancelWork(orderId).expect(200);

      expect(await amountsOf(orderId)).toEqual({
        ...base,
        unconfirmed: '100.00',
      });
      expect((await detailsOf(orderId)).advance?.status).toBe(
        'DECLARADO_SIN_CONFIRMAR',
      );
    });

    it('anticipo confirmado solo por el trabajador', async () => {
      const { orderId } = await agreedOrder();
      await confirmAdvance(orderId).expect(201);
      await cancelWork(orderId).expect(200);

      expect(await amountsOf(orderId)).toEqual({
        ...base,
        confirmed: '100.00',
        balance: '300.00',
      });
    });

    it.each([
      ['el cliente declara primero', true],
      ['el trabajador confirma primero', false],
    ])(
      'declaraciones distintas (%s): se conservan ambas y no hay pendiente',
      async (_label, clientFirst) => {
        const { orderId } = await agreedOrder();
        const claim = () =>
          declare(client, orderId, 'ANTICIPO', '150.00', 'QR').expect(201);
        if (clientFirst) await claim();
        await confirmAdvance(orderId).expect(201);
        if (!clientFirst) await claim();
        await cancelWork(orderId).expect(200);

        expect(await amountsOf(orderId)).toEqual({
          ...base,
          confirmed: '100.00',
          balance: '300.00',
        });
        const stored = await scoped.paymentDeclaration.findMany({
          where: { payment: { orderId } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const advance = (await detailsOf(orderId)).advance!;
        expect(advance).toMatchObject({
          paymentId: stored[0].paymentId,
          expectedAmount: '100.00',
          status: 'CONFIRMADO',
        });
        expect(advance.declarations).toEqual(
          stored.map((d) => ({
            id: d.id,
            declaredBy: d.declaredBy,
            userId: d.userId,
            amount: d.amount.toFixed(2),
            method: d.method,
            createdAt: d.createdAt.toISOString(),
          })),
        );
        expect(advance.declarations.map((d) => d.amount).sort()).toEqual([
          '100.00',
          '150.00',
        ]);
      },
    );

    it('suma y detalla los adicionales aceptados; excluye pendientes y rechazados', async () => {
      const { orderId } = await executingOrder();
      const first = await proposeBudget(orderId, '50.00');
      await acceptBudget(orderId, first).expect(200);
      const second = await proposeBudget(orderId, '25.50');
      await acceptBudget(orderId, second).expect(200);
      // Un rechazo cierra el pedido (RF-27): un RECHAZADO en un pedido
      // cancelable solo puede crearse directamente.
      await scoped.additionalBudget.create({
        data: {
          orderId,
          amount: '70.00',
          reason: 'r',
          materials: 'm',
          status: 'RECHAZADO',
          respondedAt: new Date(),
        },
      });
      const pending = await proposeBudget(orderId, '20.00');
      await cancelWork(orderId).expect(200);

      expect(await amountsOf(orderId)).toEqual({
        ...base,
        additional: '75.50',
        updated: '475.50',
        confirmed: '100.00',
        balance: '375.50',
      });
      const { additionalBudgets } = await detailsOf(orderId);
      expect(additionalBudgets.map((b) => [b.id, b.amount])).toEqual([
        [first, '50.00'],
        [second, '25.50'],
      ]);
      expect(
        (
          await scoped.additionalBudget.findUniqueOrThrow({
            where: { id: pending },
          })
        ).status,
      ).toBe('SIN_EFECTO_POR_CANCELACION');
    });

    it('visita realizada y pagos de varios conceptos: la visita va aparte', async () => {
      const { orderId } = await agreedOrder(true);
      await declare(client, orderId, 'ANTICIPO', '100.00').expect(201);
      await confirmAdvance(orderId).expect(201);
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      await post(
        worker,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(200);
      await declare(client, orderId, 'VISITA', '30.00').expect(201);
      await cancelWork(orderId).expect(200);

      expect(await amountsOf(orderId)).toEqual({
        ...base,
        confirmed: '100.00',
        balance: '300.00',
        visit: '30.00',
      });
      const details = await detailsOf(orderId);
      expect(details.advance?.declarations).toHaveLength(2);
      expect(details.visit).toMatchObject({
        agreedCost: '30.00',
        registeredCost: '30.00',
        status: 'CONFIRMADO',
      });
      expect(details.visit?.performedAt).not.toBeNull();
      expect(details.visit?.declarations).toHaveLength(2);
      expect(details.otherPayments).toEqual([]);
    });

    it('despues de cancelar no se declaran anticipo ni saldo; la visita si, sin cambiar la fotografia', async () => {
      const { orderId } = await agreedOrder(true);
      await declare(client, orderId, 'ANTICIPO', '100.00').expect(201);
      await confirmAdvance(orderId).expect(201);
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      await cancelWork(orderId).expect(200);
      const before = await summaryOf(orderId);

      await confirmAdvance(orderId).expect(409);
      await declare(client, orderId, 'ANTICIPO', '100.00').expect(409);
      await declare(client, orderId, 'SALDO', '300.00').expect(409);
      await declare(worker, orderId, 'SALDO', '300.00').expect(409);
      await post(
        worker,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(200);
      await declare(client, orderId, 'VISITA', '30.00').expect(201);

      expect(await summaryOf(orderId)).toEqual(before);
      expect((await detailsOf(orderId)).visit?.status).toBe(
        'SIN_DECLARACIONES',
      );
    });

    it('un anticipo sin confirmar al cancelar no puede confirmarse despues', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO', '100.00').expect(201);
      await cancelWork(orderId).expect(200);
      await confirmAdvance(orderId).expect(409);
      expect(
        await scoped.paymentDeclaration.count({
          where: { payment: { orderId }, declaredBy: 'TRABAJADOR' },
        }),
      ).toBe(0);
      expect((await amountsOf(orderId)).unconfirmed).toBe('100.00');
    });

    it('la fotografia no cambia aunque cambie el pedido, y no se modifica', async () => {
      const { orderId } = await agreedOrder();
      await cancelWork(orderId).expect(200);
      const before = await summaryOf(orderId);
      await scoped.order.update({
        where: { id: orderId },
        data: { budgetAmount: '999.00' },
      });
      await expect(
        scoped.orderCancellationSummary.update({
          where: { orderId },
          data: { pendingBalance: '0.00' },
        }),
      ).rejects.toThrow(/solo inserci/);
      expect(await summaryOf(orderId)).toEqual(before);
    });
  });

  describe('coherencia de la oferta', () => {
    const expectRejected = async (
      orderId: string,
      cancel: (id: string) => request.Test,
    ) => {
      const before = await snapshot(orderId);
      const res = await cancel(orderId).expect(409);
      expect(res.body.message).toContain('No se registró ningún cambio');
      expect(await snapshot(orderId)).toEqual(before);
    };

    it('un pedido con acuerdo sin oferta aceptada no se cancela', async () => {
      const { orderId } = await negotiatingOrder();
      await scoped.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.ANTICIPO_REGISTRADO,
          assignedWorkerId: worker.id,
        },
      });
      await expectRejected(orderId, cancelWork);
    });

    it('una oferta de un trabajador distinto del asignado no se cancela', async () => {
      const { orderId } = await agreedOrder();
      await scoped.order.update({
        where: { id: orderId },
        data: { assignedWorkerId: otherWorker.id },
      });
      await expectRejected(orderId, cancelWork);
    });

    it('un pedido sin acuerdo con una oferta aceptada no se cancela', async () => {
      const { orderId } = await agreedOrder();
      await scoped.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.EN_NEGOCIACION, assignedWorkerId: null },
      });
      await expectRejected(orderId, cancelOrder);
    });
  });

  describe.each([
    [
      'cancelar pedido',
      cancelOrder,
      async () => (await negotiatingOrder()).orderId,
    ],
    [
      'cancelar trabajo',
      cancelWork,
      async () => {
        const { orderId } = await executingOrder();
        await proposeBudget(orderId, '10.00');
        return orderId;
      },
    ],
  ])('atomicidad y concurrencia: %s', (_label, cancel, create) => {
    it.each([
      ['la fotografia', 'order_cancellation_summaries'],
      ['un aviso posterior', 'notifications'],
    ])(
      'si falla %s no queda nada: ni cancelacion ni fotografia',
      async (_what, table) => {
        const orderId = await create();
        const before = await snapshot(orderId);

        await whileInsertFails(table, () => cancel(orderId).expect(500));
        expect(await snapshot(orderId)).toEqual(before);
        expect(before.summary).toBeNull();

        await cancel(orderId).expect(200);
        expect(await summaryOf(orderId)).not.toBeNull();
      },
    );

    it('5 solicitudes simultaneas guardan una sola fotografia', async () => {
      const orderId = await create();
      const results = await queueOnOrder(
        orderId,
        Array.from({ length: 5 }, () => () => cancel(orderId)),
      );
      expect(results.map((r) => r.status)).toEqual([200, 409, 409, 409, 409]);
      const saved = await summaryOf(orderId);
      expect(saved).not.toBeNull();
      await cancel(orderId).expect(409);
      expect(await summaryOf(orderId)).toEqual(saved);
    });
  });

  describe('carreras con operaciones economicas', () => {
    it.each([
      ['la confirmacion llega antes', true],
      ['la cancelacion llega antes', false],
    ])(
      'confirmar el anticipo y cancelar a la vez: %s',
      async (_label, confirmFirst) => {
        const { orderId } = await agreedOrder();
        const confirm = () => confirmAdvance(orderId);
        const cancel = () => cancelWork(orderId);
        const results = await queueOnOrder(
          orderId,
          confirmFirst ? [confirm, cancel] : [cancel, confirm],
        );
        expect(results.map((r) => r.status)).toEqual(
          confirmFirst ? [201, 200] : [200, 409],
        );
        expect(await amountsOf(orderId)).toMatchObject({
          confirmed: confirmFirst ? '100.00' : '0.00',
          balance: confirmFirst ? '300.00' : '400.00',
        });
      },
    );

    it.each([
      ['la aceptacion llega antes', true],
      ['la cancelacion llega antes', false],
    ])(
      'aceptar un adicional y cancelar a la vez: %s',
      async (_label, acceptFirst) => {
        const { orderId } = await executingOrder();
        const budgetId = await proposeBudget(orderId, '50.00');
        const accept = () => acceptBudget(orderId, budgetId);
        const cancel = () => cancelWork(orderId);
        const results = await queueOnOrder(
          orderId,
          acceptFirst ? [accept, cancel] : [cancel, accept],
        );
        expect(results.map((r) => r.status)).toEqual(
          acceptFirst ? [200, 200] : [200, 409],
        );
        expect(await amountsOf(orderId)).toMatchObject({
          additional: acceptFirst ? '50.00' : '0.00',
          balance: acceptFirst ? '350.00' : '300.00',
        });
      },
    );
  });
});
