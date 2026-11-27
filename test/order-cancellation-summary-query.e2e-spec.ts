//=========================================================
// NUEVO: order-cancellation-summary-query.e2e-spec.ts
// Fase B4 (cancelacion): consulta del resumen economico y saldo de la
// consulta de pagos en pedidos cancelados, con la API y PostgreSQL reales.
// Reglas: solo el cliente dueno, el trabajador asignado o un administrador;
// la fotografia se devuelve sin recalcular; la visita y lo declarado despues
// van aparte; no se resta un anticipo que nadie confirmo; consultar no
// modifica nada.
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

describe('Consulta del resumen economico de cancelacion (B4, e2e)', () => {
  let app: INestApplication<App>;
  let isolated: IsolatedSchema;
  let scoped: PrismaClient;
  let jwt: JwtService;
  let storageDir: string;
  let jpeg: Buffer;

  let admin: PublicUser;
  let client: PublicUser;
  let otherClient: PublicUser;
  let worker: PublicUser;
  /** Trabajador que oferto pero cuya oferta no se acepto. */
  let bidder: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);
  const get = (user: PublicUser, url: string) =>
    http().get(`/api${url}`).set('Authorization', auth(user));

  const summary = (user: PublicUser, orderId: string) =>
    get(user, `/orders/${orderId}/cancellation-summary`);
  const payments = (user: PublicUser, orderId: string) =>
    get(user, `/orders/${orderId}/payments`);
  const cancelOrder = (orderId: string) =>
    post(client, `/orders/me/${orderId}/cancel`, { reason: 'Cambio' });
  const cancelWork = (orderId: string) =>
    post(client, `/orders/${orderId}/cancel-work`, { reason: 'Cambio' });
  const declare = (
    user: PublicUser,
    orderId: string,
    concept: 'ANTICIPO' | 'VISITA',
    amount: string,
  ) =>
    post(user, `/orders/${orderId}/payments/${concept}/declarations`, {
      amount,
      method: 'EFECTIVO',
    });

  let slot = 0;
  const nextSlot = () => {
    const n = slot++;
    return nextMondayAt(8 + (n % 9), Math.floor(n / 9));
  };

  /** Pedido EN_NEGOCIACION con las ofertas de los dos trabajadores. */
  const negotiatingOrder = async (requiresVisit = false) => {
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
    const orderId = created.body.order.id as string;
    const offer = async (user: PublicUser) =>
      (
        await post(user, `/offers/orders/${orderId}`, {
          amount: '400.00',
          requiresVisit,
          ...(requiresVisit ? { visitCost: '30.00' } : {}),
          materialsIncluded: false,
          proposedStartAt: nextSlot().toISOString(),
          estimatedDurationMinutes: 30,
        }).expect(201)
      ).body.id as string;
    await offer(bidder);
    return { orderId, offerId: await offer(worker) };
  };

  const agreedOrder = async (requiresVisit = false) => {
    const ids = await negotiatingOrder(requiresVisit);
    await post(client, `/offers/${ids.offerId}/accept`).expect(200);
    return ids;
  };

  /** Todo lo que una consulta no debe cambiar. */
  const stateOf = async (orderId: string) => ({
    order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
    summary: await scoped.orderCancellationSummary.findUnique({
      where: { orderId },
    }),
    payments: await scoped.payment.findMany({
      where: { orderId },
      include: { declarations: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    }),
    history: await scoped.orderStatusHistory.count({ where: { orderId } }),
    notices: await scoped.notification.count({
      where: { resourceId: orderId },
    }),
  });

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'summary-query-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    isolated = await createIsolatedSchema('summary_query');
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
    const catalogs = app.get(CatalogsService);
    const users = app.get(UsersService);
    const profiles = app.get(WorkerProfileService);
    const newUser = (name: string, phone?: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}@query-e2e.test`,
        passwordHash: 'hash',
        phone,
      });
    admin = await newUser('admin');
    client = await newUser('client');
    otherClient = await newUser('other-client');
    worker = await newUser('worker', '71000031');
    bidder = await newUser('bidder', '71000032');
    await scoped.userRole.create({
      data: { userId: admin.id, role: RoleName.ADMINISTRADOR },
    });
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Plomeria ${RUN_ID}`,
    });
    zone = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Norte ${RUN_ID}`,
    });
    for (const user of [worker, bidder]) {
      const profile = await profiles.create(user.id, {
        yearsOfExperience: 5,
        zoneId: zone.id,
        categoryIds: [category.id],
        schedules: [
          { dayOfWeek: 'LUNES', startTime: '08:00', endTime: '18:00' },
        ],
      });
      await profiles.submit(user.id);
      await profiles.changeStatusByAdmin(admin.id, profile.id, {
        status: WorkerProfileStatus.APROBADO,
      });
    }
    jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#3366aa' },
    })
      .jpeg()
      .toBuffer();
  });

  afterAll(async () => {
    await app?.close();
    await scoped?.$disconnect();
    await isolated?.drop();
    await rm(storageDir, { recursive: true, force: true });
  });

  describe('permisos', () => {
    let agreed: string;
    let unagreed: string;
    beforeAll(async () => {
      agreed = (await agreedOrder()).orderId;
      await cancelWork(agreed).expect(200);
      unagreed = (await negotiatingOrder()).orderId;
      await cancelOrder(unagreed).expect(200);
    });

    it('con acuerdo: cliente dueno, trabajador asignado y administrador', async () => {
      const responses = await Promise.all(
        [client, worker, admin].map((user) =>
          summary(user, agreed).expect(200),
        ),
      );
      expect(responses[1].body).toEqual(responses[0].body);
      expect(responses[2].body).toEqual(responses[0].body);
    });

    it('con acuerdo: nadie mas, ni quien oferto sin ser elegido', async () => {
      for (const user of [otherClient, bidder]) {
        const res = await summary(user, agreed).expect(404);
        expect(res.body.message).toBe('El pedido no existe');
        expect(JSON.stringify(res.body)).not.toContain('400');
      }
    });

    it('sin acuerdo: solo el cliente dueno y el administrador', async () => {
      await summary(client, unagreed).expect(200);
      await summary(admin, unagreed).expect(200);
      for (const user of [worker, bidder, otherClient]) {
        await summary(user, unagreed).expect(404);
      }
    });

    it('sin sesion 401; identificador no valido 400; inexistente 404', async () => {
      await http()
        .get(`/api/orders/${agreed}/cancellation-summary`)
        .expect(401);
      await summary(client, 'no-es-uuid').expect(400);
      await summary(admin, randomUUID()).expect(404);
    });

    it('no admite escritura por esta ruta', async () => {
      await post(client, `/orders/${agreed}/cancellation-summary`).expect(404);
    });
  });

  it('sin acuerdo: responde sin importes y la consulta de pagos no calcula saldo', async () => {
    const { orderId } = await negotiatingOrder();
    await cancelOrder(orderId).expect(200);

    const res = await summary(client, orderId).expect(200);
    expect(res.body).toMatchObject({
      orderId,
      hasAgreement: false,
      agreement: null,
      totals: {
        agreedAmount: null,
        acceptedAdditionalTotal: null,
        updatedTotal: null,
        confirmedAdvanceTotal: null,
        unconfirmedAdvanceAmount: null,
        pendingBalance: null,
      },
      advance: null,
      additionalBudgets: [],
      visit: null,
      otherPayments: [],
      declarationsAfterCancellation: [],
      schemaVersion: 1,
    });
    expect(res.body.notice).toContain('no recibe, retiene ni garantiza');
    const overview = await payments(client, orderId).expect(200);
    expect(overview.body.balance).toMatchObject({
      status: 'NO_APLICA',
      amount: null,
      advanceAmount: null,
    });
    expect(overview.body.balance.note).toContain('sin acuerdo');
  });

  it.each([
    ['sin declaraciones', null, null, '0.00', null, '400.00'],
    ['declarado sin confirmar', '100.00', null, '0.00', '100.00', '400.00'],
    ['confirmado', null, '100.00', '100.00', null, '300.00'],
    ['montos diferentes', '150.00', '100.00', '100.00', null, '300.00'],
  ])(
    'anticipo %s: resumen y saldo de pagos coinciden',
    async (_label, byClient, byWorker, confirmed, unconfirmed, balance) => {
      const { orderId, offerId } = await agreedOrder();
      if (byClient) {
        await declare(client, orderId, 'ANTICIPO', byClient).expect(201);
      }
      if (byWorker) {
        await declare(worker, orderId, 'ANTICIPO', byWorker).expect(201);
      }
      await cancelWork(orderId).expect(200);

      const res = await summary(client, orderId).expect(200);
      expect(res.body.agreement.offerId).toBe(offerId);
      expect(res.body.totals).toEqual({
        agreedAmount: '400.00',
        acceptedAdditionalTotal: '0.00',
        updatedTotal: '400.00',
        confirmedAdvanceTotal: confirmed,
        unconfirmedAdvanceAmount: unconfirmed,
        pendingBalance: balance,
      });
      let status = 'SIN_DECLARACIONES';
      if (byWorker) status = 'CONFIRMADO';
      else if (byClient) status = 'DECLARADO_SIN_CONFIRMAR';
      expect(res.body.advance.status).toBe(status);
      expect(
        res.body.advance.declarations.map(
          (d: { declaredBy: string; amount: string }) => [
            d.declaredBy,
            d.amount,
          ],
        ),
      ).toEqual([
        ...(byClient ? [['CLIENTE', byClient]] : []),
        ...(byWorker ? [['TRABAJADOR', byWorker]] : []),
      ]);

      const overview = await payments(client, orderId).expect(200);
      expect(overview.body.balance).toMatchObject({
        status: 'CALCULADO',
        amount: balance,
        // Solo lo confirmado: nunca el 25 % esperado.
        advanceAmount: confirmed,
        additionalBudgetsTotal: '0.00',
      });
    },
  );

  it('adicionales aceptados y fotografia sin recalcular', async () => {
    const { orderId } = await agreedOrder();
    await declare(worker, orderId, 'ANTICIPO', '100.00').expect(201);
    await post(worker, `/orders/${orderId}/start`).expect(200);
    await post(worker, `/orders/${orderId}/additional-budgets`, {
      amount: '50.00',
      reason: 'Repuesto',
      materials: 'Llave',
    }).expect(201);
    const { id } = await scoped.additionalBudget.findFirstOrThrow({
      where: { orderId },
    });
    await post(
      client,
      `/orders/${orderId}/additional-budgets/${id}/accept`,
    ).expect(200);
    await cancelWork(orderId).expect(200);
    const first = await summary(client, orderId).expect(200);
    expect(first.body.totals).toMatchObject({
      acceptedAdditionalTotal: '50.00',
      updatedTotal: '450.00',
      pendingBalance: '350.00',
    });
    expect(first.body.additionalBudgets).toEqual([
      expect.objectContaining({ id, amount: '50.00' }) as unknown,
    ]);

    // Un registro posterior no cambia lo que se devuelve.
    await scoped.additionalBudget.create({
      data: {
        orderId,
        amount: '999.00',
        reason: 'Posterior',
        materials: 'm',
        status: 'ACEPTADO',
        respondedAt: new Date(),
      },
    });
    const before = await stateOf(orderId);
    const again = await summary(client, orderId).expect(200);
    expect(again.body).toEqual(first.body);
    const overview = await payments(client, orderId).expect(200);
    expect(overview.body.balance).toMatchObject({
      amount: '350.00',
      additionalBudgetsTotal: '50.00',
    });
    expect(await stateOf(orderId)).toEqual(before);
  });

  it('visita: costo y declaraciones aparte; lo posterior se lista separado', async () => {
    const { orderId } = await agreedOrder(true);
    await declare(worker, orderId, 'ANTICIPO', '100.00').expect(201);
    await post(worker, `/orders/${orderId}/visit`).expect(201);
    await declare(client, orderId, 'VISITA', '30.00').expect(201);
    await cancelWork(orderId).expect(200);

    const before = await summary(client, orderId).expect(200);
    expect(before.body.totals).toMatchObject({
      updatedTotal: '400.00',
      pendingBalance: '300.00',
    });
    expect(before.body.visit).toMatchObject({
      agreedCost: '30.00',
      registeredCost: '30.00',
      status: 'DECLARADO_SIN_CONFIRMAR',
      declarations: [
        expect.objectContaining({
          declaredBy: 'CLIENTE',
          amount: '30.00',
        }) as unknown,
      ],
    });
    expect(before.body.declarationsAfterCancellation).toEqual([]);

    await post(worker, `/orders/${orderId}/visit/payment-confirmation`).expect(
      200,
    );
    const after = await summary(worker, orderId).expect(200);
    expect(after.body.declarationsAfterCancellation).toEqual([
      expect.objectContaining({
        concept: 'VISITA',
        declaredBy: 'TRABAJADOR',
        userId: worker.id,
        amount: '30.00',
      }) as unknown,
    ]);
    // La fotografia (visita incluida) y el saldo no cambian.
    expect({ ...after.body, declarationsAfterCancellation: [] }).toEqual(
      before.body,
    );
    expect(
      (await payments(client, orderId).expect(200)).body.balance.amount,
    ).toBe('300.00');
  });

  describe('sin resumen', () => {
    it.each([
      ['en negociacion', async () => (await negotiatingOrder()).orderId],
      ['con acuerdo', async () => (await agreedOrder()).orderId],
    ])('un pedido %s (no cancelado) responde 409', async (_label, create) => {
      const orderId = await create();
      const res = await summary(client, orderId).expect(409);
      expect(res.body.message).toContain('no está cancelado');
    });

    it('cancelado sin fotografia: 404 y la consulta de pagos no calcula saldo', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO', '100.00').expect(201);
      // Como una cancelacion anterior a B3: sin fotografia.
      await scoped.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELADO, cancelledAt: new Date() },
      });
      const before = await stateOf(orderId);

      const res = await summary(client, orderId).expect(404);
      expect(res.body.message).toBe(
        'El pedido se canceló sin resumen económico registrado.',
      );
      await summary(otherClient, orderId).expect(404);
      const overview = await payments(client, orderId).expect(200);
      expect(overview.body.balance).toMatchObject({
        status: 'NO_APLICA',
        amount: null,
        advanceAmount: null,
      });
      // No se crea una fotografia al consultar.
      expect(await stateOf(orderId)).toEqual(before);
    });
  });

  it('regresion: un pedido no cancelado conserva el saldo esperado', async () => {
    const { orderId } = await agreedOrder();
    const overview = await payments(client, orderId).expect(200);
    expect(overview.body.balance).toMatchObject({
      status: 'CALCULADO',
      amount: '300.00',
      advanceAmount: '100.00',
    });
  });
});
