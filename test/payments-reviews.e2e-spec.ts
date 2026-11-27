//=========================================================
// MODIFICADO: payments-reviews.e2e-spec.ts
// Fase B1 (cancelacion): las llamadas que cancelan un pedido sin acuerdo
// envian el motivo, ahora obligatorio (decision D1).
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
  NotificationType,
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
import type { OrderActor } from '../src/modules/orders/order-history.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
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

// Corre sobre un esquema temporal con TODAS las migraciones: no toca los datos
// del esquema public. La aplicacion se arranca con AppModule, que registra
// todos los modulos.
const RUN_ID = randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ADDRESS = 'Av. Siempre Viva 742';

/** Proximo lunes (>= 1 dia) a la hora local de La Paz (UTC-4); los trabajadores atienden lunes 08-18. */
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

describe('Pagos, calificaciones, seguimiento, avisos y agenda (RF-29 a RF-33, RF-39 a RF-46, e2e)', () => {
  let app: INestApplication<App>;
  let isolated: IsolatedSchema;
  let scoped: PrismaClient;
  let prisma: PrismaService;
  let jwt: JwtService;
  let orders: OrdersService;
  let storageDir: string;
  let jpeg: Buffer;

  let admin: PublicUser;
  let client: PublicUser;
  let client2: PublicUser;
  let worker: PublicUser;
  let worker2: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;

  // Configuracion mutable para probar cada modo sin reiniciar la app.
  const reviewsConfig = { policy: statusEligibilityPolicy([]) };

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);
  const get = (user: PublicUser, url: string) =>
    http().get(`/api${url}`).set('Authorization', auth(user));
  const patch = (user: PublicUser, url: string, body?: object) =>
    http().patch(`/api${url}`).set('Authorization', auth(user)).send(body);

  let slot = 0;
  const nextSlot = () => {
    const n = slot++;
    return nextMondayAt(8 + (n % 9), Math.floor(n / 9));
  };

  const offerBody = (
    startAt: Date,
    options: { requiresVisit?: boolean; visitCost?: string } = {},
  ) => ({
    amount: '120.50',
    requiresVisit: options.requiresVisit ?? false,
    ...(options.requiresVisit
      ? { visitCost: options.visitCost ?? '30.00' }
      : {}),
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

  /** Pedido ACORDADO con la oferta indicada (monto 120.50). */
  const agreedOrder = async (
    options: {
      requiresVisit?: boolean;
      visitCost?: string;
      owner?: PublicUser;
      by?: PublicUser;
      startAt?: Date;
    } = {},
  ) => {
    const owner = options.owner ?? client;
    const by = options.by ?? worker;
    const orderId = await createOrder(owner);
    const offer = await post(
      by,
      `/offers/orders/${orderId}`,
      offerBody(options.startAt ?? nextSlot(), options),
    ).expect(201);
    await post(owner, `/offers/${offer.body.id as string}/accept`).expect(200);
    return { orderId, offerId: offer.body.id as string };
  };

  /** Registra el anticipo como en la aplicacion: lo confirma el trabajador asignado. */
  const registerAdvance = async (orderId: string) => {
    const { assignedWorkerId } = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    const assigned = [worker, worker2].find((u) => u.id === assignedWorkerId)!;
    await post(assigned, `/orders/${orderId}/payments/ANTICIPO/declarations`, {
      amount: '30.13',
      method: 'EFECTIVO',
    }).expect(201);
  };

  const statusOf = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  const executingOrder = async () => {
    const { orderId } = await agreedOrder();
    await registerAdvance(orderId);
    await post(worker, `/orders/${orderId}/start`).expect(200);
    return orderId;
  };
  const finishedOrder = async () => {
    const orderId = await executingOrder();
    await post(worker, `/orders/${orderId}/finish`).expect(200);
    return orderId;
  };

  const declare = (
    user: PublicUser,
    orderId: string,
    concept: string,
    body: object = { amount: '30.13', method: 'EFECTIVO' },
  ) => post(user, `/orders/${orderId}/payments/${concept}/declarations`, body);

  const notificationsOf = (userId: string, type: NotificationType) =>
    prisma.notification.findMany({ where: { userId, type } });

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'payments-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    isolated = await createIsolatedSchema('payments');
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
      .overrideProvider(ReviewsConfig)
      .useValue(reviewsConfig)
      .compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    orders = app.get(OrdersService);
    const catalogs = app.get(CatalogsService);
    const users = app.get(UsersService);
    const profiles = app.get(WorkerProfileService);

    const newUser = (name: string, phone?: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}@payments-e2e.test`,
        passwordHash: 'hash',
        phone,
      });
    admin = await newUser('admin');
    client = await newUser('client');
    client2 = await newUser('client2');
    worker = await newUser('worker', '71000001');
    worker2 = await newUser('worker2', '71000002');
    await prisma.userRole.create({
      data: { userId: admin.id, role: RoleName.ADMINISTRADOR },
    });
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Plomeria ${RUN_ID}`,
    });
    zone = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Norte ${RUN_ID}`,
    });
    for (const user of [worker, worker2]) {
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

  beforeEach(() => {
    reviewsConfig.policy = statusEligibilityPolicy([]);
  });

  // ---------------------------------------------------------------------
  describe('Pagos: consulta y constancias (RF-41, RF-43)', () => {
    it('muestra el aviso de pago directo, el anticipo esperado (25 %, mitad hacia arriba) y el saldo', async () => {
      const { orderId } = await agreedOrder();
      const res = await get(client, `/orders/${orderId}/payments`).expect(200);
      expect(res.body.notice).toMatch(/no recibe, retiene ni garantiza/);
      expect(res.body.agreement).toEqual({
        baseAmount: '120.50',
        acceptedAdditional: '0.00',
        totalAmount: '120.50',
      });
      // 25 % de 120.50 = 30.125 -> 30.13.
      const advance = res.body.payments.find(
        (p: { concept: string }) => p.concept === 'ANTICIPO',
      );
      expect(advance.expectedAmount).toBe('30.13');
      expect(advance.requiredConfirmation).toBe('TRABAJADOR');
      expect(res.body.balance).toMatchObject({
        status: 'CALCULADO',
        amount: '90.37',
        advanceAmount: '30.13',
      });
      expect(res.body.advanceTransition).toBe('ACTIVA');
      // Oferta sin visita: no hay concepto VISITA.
      expect(
        res.body.payments.some(
          (p: { concept: string }) => p.concept === 'VISITA',
        ),
      ).toBe(false);
    });

    it('permisos: cliente, trabajador asignado y administrador; un tercero recibe 404', async () => {
      const { orderId } = await agreedOrder();
      await get(worker, `/orders/${orderId}/payments`).expect(200);
      await get(admin, `/orders/${orderId}/payments`).expect(200);
      await get(client2, `/orders/${orderId}/payments`).expect(404);
      await get(worker2, `/orders/${orderId}/payments`).expect(404);
      await get(client, `/orders/${randomUUID()}/payments`).expect(404);
      await http().get(`/api/orders/${orderId}/payments`).expect(401);
    });

    it('emite la constancia del servicio al aceptar la oferta, en la misma transaccion', async () => {
      const { orderId } = await agreedOrder();
      const res = await get(client, `/orders/${orderId}/receipts`).expect(200);
      expect(res.body.service).toMatchObject({
        clientId: client.id,
        workerId: worker.id,
        agreedAmount: '120.50',
      });
      expect(res.body.referenceNotice).toMatch(/solo una referencia/);
      expect(res.body.payments).toEqual([]);
      await get(client2, `/orders/${orderId}/receipts`).expect(404);
    });

    it('las constancias de pago son inmutables (la BD no permite editar ni borrar)', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO').expect(201);
      const declaration = await prisma.paymentDeclaration.findFirstOrThrow({
        where: { payment: { orderId } },
      });
      await expect(
        prisma.paymentDeclaration.update({
          where: { id: declaration.id },
          data: { amount: '1.00' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.paymentDeclaration.delete({ where: { id: declaration.id } }),
      ).rejects.toThrow();
      await expect(
        prisma.serviceReceipt.deleteMany({ where: { orderId } }),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------
  describe('Pagos: declaraciones y anticipo (RF-39, RF-42)', () => {
    it('registra la declaracion del cliente sin cambiar el pedido', async () => {
      const { orderId } = await agreedOrder();
      const res = await declare(client, orderId, 'ANTICIPO').expect(201);
      expect(res.body.orderTransition).toBe('NO_APLICA');
      expect(res.body.payment).toMatchObject({
        concept: 'ANTICIPO',
        comparison: 'SOLO_CLIENTE',
        expectedAmount: '30.13',
      });
      expect(res.body.payment.declarations[0]).toMatchObject({
        declaredBy: 'CLIENTE',
        userId: client.id,
        method: 'EFECTIVO',
        amount: '30.13',
      });
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
    });

    it('cada parte declara una sola vez por concepto (409) y las declaraciones son independientes', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO').expect(201);
      await declare(client, orderId, 'ANTICIPO').expect(409);
      const only = await get(worker, `/orders/${orderId}/payments`).expect(200);
      const advance = only.body.payments.find(
        (p: { concept: string }) => p.concept === 'ANTICIPO',
      );
      // La del cliente no completa la del trabajador.
      expect(advance.comparison).toBe('SOLO_CLIENTE');
      expect(advance.declarations).toHaveLength(1);
      expect(
        await prisma.paymentDeclaration.count({
          where: { payment: { orderId } },
        }),
      ).toBe(1);
    });

    it('dos declaraciones simultaneas de la misma parte: una gana y la otra recibe 409', async () => {
      const { orderId } = await agreedOrder();
      const results = await Promise.all([
        declare(client, orderId, 'ANTICIPO'),
        declare(client, orderId, 'ANTICIPO'),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect(
        await prisma.paymentDeclaration.count({
          where: { payment: { orderId } },
        }),
      ).toBe(1);
    });

    it('montos distintos: informa la diferencia, avisa a ambos y a los administradores y la lista el administrador', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO', {
        amount: '20.00',
        method: 'EFECTIVO',
      }).expect(201);
      const res = await declare(worker, orderId, 'ANTICIPO', {
        amount: '30.13',
        method: 'QR',
      }).expect(201);
      expect(res.body.payment).toMatchObject({
        comparison: 'MONTOS_DIFERENTES',
        difference: '10.13',
        methodsMatch: false,
      });
      for (const user of [client, worker, admin]) {
        const found = await notificationsOf(user.id, 'PAGO_CON_DIFERENCIA');
        expect(found.length).toBeGreaterThan(0);
      }
      const list = await get(admin, '/admin/payments/differences').expect(200);
      expect(
        list.body.data.some(
          (row: { orderId: string }) => row.orderId === orderId,
        ),
      ).toBe(true);
      await get(client, '/admin/payments/differences').expect(403);
    });

    it('avisa a la contraparte de cada declaracion (dentro de la transaccion)', async () => {
      const { orderId } = await agreedOrder();
      const before = (await notificationsOf(worker.id, 'PAGO_DECLARADO'))
        .length;
      await declare(client, orderId, 'ANTICIPO').expect(201);
      expect((await notificationsOf(worker.id, 'PAGO_DECLARADO')).length).toBe(
        before + 1,
      );
    });

    it('valida el cuerpo, el metodo y los permisos', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO', {
        amount: '0',
        method: 'EFECTIVO',
      }).expect(400);
      await declare(client, orderId, 'ANTICIPO', {
        amount: '10.123',
        method: 'EFECTIVO',
      }).expect(400);
      await declare(client, orderId, 'ANTICIPO', {
        amount: '10',
        method: 'TARJETA',
      }).expect(400);
      await declare(client, orderId, 'ANTICIPO', {
        amount: '10',
        method: 'QR',
        userId: worker.id,
        declaredBy: 'TRABAJADOR',
      }).expect(400);
      await declare(client, orderId, 'OTRO').expect(400);
      await declare(client2, orderId, 'ANTICIPO').expect(404);
      await declare(worker2, orderId, 'ANTICIPO').expect(404);
      // El administrador no es parte del pedido.
      await declare(admin, orderId, 'ANTICIPO').expect(404);
      await http()
        .post(`/api/orders/${orderId}/payments/ANTICIPO/declarations`)
        .send({ amount: '10', method: 'QR' })
        .expect(401);
    });

    it('no admite declaraciones de un pedido cancelado ni sin acuerdo', async () => {
      const { orderId } = await agreedOrder();
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'Cambio de planes',
      }).expect(200);
      await declare(client, orderId, 'ANTICIPO').expect(409);

      const open = await createOrder();
      await declare(client, open, 'ANTICIPO').expect(409);
    });

    it('no debilita los invariantes: tras el anticipo, una declaracion posterior no vuelve a transicionar', async () => {
      const { orderId } = await agreedOrder();
      await declare(worker, orderId, 'ANTICIPO').expect(201);
      expect(await statusOf(orderId)).toBe(OrderStatus.ANTICIPO_REGISTRADO);
      const again = await declare(client, orderId, 'ANTICIPO').expect(201);
      expect(again.body.orderTransition).toBe('NO_APLICA');
      // Saltarse el flujo sigue prohibido: del anticipo no se pasa a TERMINADO.
      await expect(
        prisma.$transaction((tx) =>
          orders.transition(tx, {
            orderId,
            from: OrderStatus.ANTICIPO_REGISTRADO,
            to: OrderStatus.TERMINADO,
            actor: { type: 'SISTEMA', process: 'PRUEBA' },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------
  describe('Anticipo confirmado por el trabajador asignado (decision confirmada)', () => {
    const advanceRows = (orderId: string) =>
      prisma.paymentDeclaration.findMany({
        where: { payment: { orderId, concept: 'ANTICIPO' } },
        orderBy: { createdAt: 'asc' },
      });
    const advanceHistory = (orderId: string) =>
      prisma.orderStatusHistory.findMany({
        where: { orderId, toStatus: OrderStatus.ANTICIPO_REGISTRADO },
      });

    it('el trabajador confirma: conserva monto, fecha, participantes e historial', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO').expect(201);
      const res = await declare(worker, orderId, 'ANTICIPO').expect(201);

      expect(res.body.orderTransition).toBe('ANTICIPO_REGISTRADO');
      expect(res.body.payment).toMatchObject({
        expectedAmount: '30.13',
        requiredConfirmation: 'TRABAJADOR',
        comparison: 'MONTOS_COINCIDEN',
      });
      expect(await statusOf(orderId)).toBe(OrderStatus.ANTICIPO_REGISTRADO);

      const rows = await advanceRows(orderId);
      expect(rows.map((r) => [r.declaredBy, r.userId])).toEqual([
        ['CLIENTE', client.id],
        ['TRABAJADOR', worker.id],
      ]);
      expect(rows[1].amount.toFixed(2)).toBe('30.13');
      expect(rows[1].createdAt).toBeInstanceOf(Date);
      const receipt = await prisma.serviceReceipt.findUniqueOrThrow({
        where: { orderId },
      });
      expect(receipt).toMatchObject({
        clientId: client.id,
        workerId: worker.id,
      });
      const history = await advanceHistory(orderId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: OrderStatus.ACORDADO,
        changedById: worker.id,
        actorRole: RoleName.TRABAJADOR,
      });
    });

    it('el cliente no puede confirmar la recepcion por el trabajador', async () => {
      const { orderId } = await agreedOrder();
      // No puede elegir la parte en el cuerpo.
      await declare(client, orderId, 'ANTICIPO', {
        amount: '30.13',
        method: 'EFECTIVO',
        declaredBy: 'TRABAJADOR',
      }).expect(400);
      const res = await declare(client, orderId, 'ANTICIPO').expect(201);
      expect(res.body.orderTransition).toBe('NO_APLICA');
      await declare(client, orderId, 'ANTICIPO').expect(409);

      const rows = await advanceRows(orderId);
      expect(rows.map((r) => r.declaredBy)).toEqual(['CLIENTE']);
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
      expect(await advanceHistory(orderId)).toHaveLength(0);
    });

    it('un tercero, el administrador o un anonimo no confirman ni registran nada', async () => {
      const { orderId } = await agreedOrder();
      await declare(worker2, orderId, 'ANTICIPO').expect(404);
      await declare(client2, orderId, 'ANTICIPO').expect(404);
      await declare(admin, orderId, 'ANTICIPO').expect(404);
      await http()
        .post(`/api/orders/${orderId}/payments/ANTICIPO/declarations`)
        .send({ amount: '30.13', method: 'EFECTIVO' })
        .expect(401);
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
    });

    it('repetir la confirmacion es idempotente, tambien con el trabajo ya avanzado', async () => {
      const { orderId } = await agreedOrder();
      const first = await declare(worker, orderId, 'ANTICIPO').expect(201);
      const notified = (await notificationsOf(client.id, 'PAGO_DECLARADO'))
        .length;

      const again = await declare(worker, orderId, 'ANTICIPO').expect(201);
      expect(again.body.orderTransition).toBe('ANTICIPO_REGISTRADO');
      expect(again.body.payment).toEqual(first.body.payment);

      await post(worker, `/orders/${orderId}/start`).expect(200);
      await declare(worker, orderId, 'ANTICIPO').expect(201);
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_EJECUCION);

      // Con otros datos no se edita la declaracion.
      await declare(worker, orderId, 'ANTICIPO', {
        amount: '30.13',
        method: 'QR',
      }).expect(409);
      await declare(worker, orderId, 'ANTICIPO', {
        amount: '31.00',
        method: 'EFECTIVO',
      }).expect(409);

      expect(await advanceRows(orderId)).toHaveLength(1);
      expect(await advanceHistory(orderId)).toHaveLength(1);
      expect((await notificationsOf(client.id, 'PAGO_DECLARADO')).length).toBe(
        notified,
      );
    });

    it('confirmaciones simultaneas: un solo registro y una sola transicion', async () => {
      const { orderId } = await agreedOrder();
      const results = await Promise.all([
        declare(worker, orderId, 'ANTICIPO'),
        declare(worker, orderId, 'ANTICIPO'),
        declare(worker, orderId, 'ANTICIPO'),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(await advanceRows(orderId)).toHaveLength(1);
      expect(await advanceHistory(orderId)).toHaveLength(1);
      expect(await prisma.payment.count({ where: { orderId } })).toBe(1);
    });

    it('rechaza un monto distinto del 25 % sin registrar nada', async () => {
      const { orderId } = await agreedOrder();
      for (const amount of ['30.12', '30.14', '120.50']) {
        const res = await declare(worker, orderId, 'ANTICIPO', {
          amount,
          method: 'EFECTIVO',
        }).expect(409);
        expect(res.body.message).toMatch(/Bs 30\.13/);
      }
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
    });

    it('rechaza la confirmacion si el estado no corresponde', async () => {
      const open = await createOrder();
      // Sin acuerdo no hay trabajador asignado: para el, el pedido no existe.
      await declare(worker, open, 'ANTICIPO').expect(404);

      const { orderId } = await agreedOrder();
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'Cambio de planes',
      }).expect(200);
      await declare(worker, orderId, 'ANTICIPO').expect(409);
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
      expect(await statusOf(orderId)).toBe(OrderStatus.CANCELADO);
    });

    const declaredNotices = (orderId: string) =>
      prisma.notification.findMany({
        where: { type: 'PAGO_DECLARADO', resourceId: orderId },
        select: { userId: true },
      });

    it('cliente y trabajador a la vez: una sola transicion, del trabajador, y un aviso a cada uno', async () => {
      for (let i = 0; i < 3; i += 1) {
        const { orderId } = await agreedOrder();
        const [byClient, byWorker] = await Promise.all([
          declare(client, orderId, 'ANTICIPO'),
          declare(worker, orderId, 'ANTICIPO'),
        ]);
        expect([byClient.status, byWorker.status]).toEqual([201, 201]);
        expect(byClient.body.orderTransition).toBe('NO_APLICA');
        expect(byWorker.body.orderTransition).toBe('ANTICIPO_REGISTRADO');
        const history = await advanceHistory(orderId);
        expect(history).toHaveLength(1);
        expect(history[0].changedById).toBe(worker.id);
        expect(await advanceRows(orderId)).toHaveLength(2);
        expect(
          (await declaredNotices(orderId)).map((n) => n.userId).sort(),
        ).toEqual([client.id, worker.id].sort());
      }
    });

    it('confirmaciones repetidas y simultaneas avisan al cliente una sola vez', async () => {
      const { orderId } = await agreedOrder();
      await Promise.all(
        Array.from({ length: 5 }, () => declare(worker, orderId, 'ANTICIPO')),
      );
      await declare(worker, orderId, 'ANTICIPO').expect(201);
      expect(await declaredNotices(orderId)).toEqual([{ userId: client.id }]);
      expect(
        await prisma.notification.count({
          where: { type: 'PAGO_CON_DIFERENCIA', resourceId: orderId },
        }),
      ).toBe(0);
      expect(await advanceRows(orderId)).toHaveLength(1);
      expect(await advanceHistory(orderId)).toHaveLength(1);
    });

    it('una declaracion del trabajador sin avance previo: el cliente no lo avanza, el trabajador si', async () => {
      const { orderId } = await agreedOrder();
      // Dato anterior a la regla: declaracion guardada con el pedido ACORDADO.
      const payment = await prisma.payment.create({
        data: { orderId, concept: 'ANTICIPO', expectedAmount: '30.13' },
      });
      await prisma.paymentDeclaration.create({
        data: {
          paymentId: payment.id,
          declaredBy: 'TRABAJADOR',
          userId: worker.id,
          method: 'EFECTIVO',
          amount: '30.13',
        },
      });
      const byClient = await declare(client, orderId, 'ANTICIPO').expect(201);
      expect(byClient.body.orderTransition).toBe('NO_APLICA');
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);

      const byWorker = await declare(worker, orderId, 'ANTICIPO').expect(201);
      expect(byWorker.body.orderTransition).toBe('ANTICIPO_REGISTRADO');
      expect(await advanceRows(orderId)).toHaveLength(2);
      expect((await advanceHistory(orderId))[0].changedById).toBe(worker.id);
    });

    it('un trabajador suspendido no puede confirmar', async () => {
      const { orderId } = await agreedOrder({ by: worker2 });
      const profile = await prisma.workerProfile.findUniqueOrThrow({
        where: { userId: worker2.id },
      });
      const profiles = app.get(WorkerProfileService);
      await profiles.changeStatusByAdmin(admin.id, profile.id, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Prueba',
      });
      try {
        await declare(worker2, orderId, 'ANTICIPO').expect(403);
        expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
        expect(await advanceRows(orderId)).toHaveLength(0);
      } finally {
        await profiles.changeStatusByAdmin(admin.id, profile.id, {
          status: WorkerProfileStatus.APROBADO,
        });
      }
    });
  });

  // ---------------------------------------------------------------------
  describe('Guarda del anticipo en OrdersService.transition()', () => {
    // Simula a otro modulo que intenta pedir la transicion por su cuenta: son
    // intentos que DEBEN fallar. El camino permitido se prueba por la API.
    const attempt = (orderId: string, actor: OrderActor) =>
      prisma.$transaction((tx) =>
        orders.transition(tx, {
          orderId,
          to: OrderStatus.ANTICIPO_REGISTRADO,
          actor,
        } as Parameters<OrdersService['transition']>[1]),
      );
    const as = (u: PublicUser, role: RoleName): OrderActor => ({
      type: 'USUARIO',
      userId: u.id,
      role,
    });
    const untouched = async (orderId: string) => {
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId, toStatus: OrderStatus.ANTICIPO_REGISTRADO },
        }),
      ).toBe(0);
    };
    /** Declaracion guardada sin avanzar el pedido (dato anterior a la regla). */
    const storedDeclaration = async (
      orderId: string,
      userId: string,
      amount = '30.13',
    ) => {
      const payment = await prisma.payment.create({
        data: { orderId, concept: 'ANTICIPO', expectedAmount: '30.13' },
      });
      await prisma.paymentDeclaration.create({
        data: {
          paymentId: payment.id,
          declaredBy: 'TRABAJADOR',
          userId,
          method: 'EFECTIVO',
          amount,
        },
      });
    };

    it('el trabajador asignado avanza el pedido al confirmar por la API', async () => {
      const { orderId } = await agreedOrder();
      await declare(worker, orderId, 'ANTICIPO').expect(201);
      expect(await statusOf(orderId)).toBe(OrderStatus.ANTICIPO_REGISTRADO);
    });

    it('rechaza al trabajador asignado sin confirmacion, tambien si solo declaro el cliente', async () => {
      const { orderId } = await agreedOrder();
      const actor = as(worker, RoleName.TRABAJADOR);
      await expect(attempt(orderId, actor)).rejects.toThrow(
        /confirmación válida/,
      );
      await declare(client, orderId, 'ANTICIPO').expect(201);
      await expect(attempt(orderId, actor)).rejects.toThrow(
        /confirmación válida/,
      );
      await untouched(orderId);
    });

    it('rechaza a cliente, administrador, sistema y otro trabajador aunque exista la confirmacion', async () => {
      const { orderId } = await agreedOrder();
      await storedDeclaration(orderId, worker.id);
      for (const actor of [
        as(client, RoleName.CLIENTE),
        as(client, RoleName.TRABAJADOR),
        as(admin, RoleName.ADMINISTRADOR),
        as(admin, RoleName.TRABAJADOR),
        as(worker2, RoleName.TRABAJADOR),
        as(worker, RoleName.CLIENTE),
        { type: 'SISTEMA', process: 'OTRO_MODULO' } satisfies OrderActor,
      ]) {
        await expect(attempt(orderId, actor)).rejects.toThrow(
          /Solo el trabajador asignado/,
        );
      }
      await untouched(orderId);
    });

    it('rechaza la confirmacion de otro pedido del mismo trabajador', async () => {
      const confirmed = await agreedOrder();
      const pending = await agreedOrder();
      await declare(worker, confirmed.orderId, 'ANTICIPO').expect(201);
      await expect(
        attempt(pending.orderId, as(worker, RoleName.TRABAJADOR)),
      ).rejects.toThrow(/confirmación válida/);
      await untouched(pending.orderId);
    });

    it('rechaza una confirmacion de otro monto o de otro usuario', async () => {
      const wrongAmount = await agreedOrder();
      await storedDeclaration(wrongAmount.orderId, worker.id, '1.00');
      const wrongUser = await agreedOrder();
      await storedDeclaration(wrongUser.orderId, worker2.id);
      for (const { orderId } of [wrongAmount, wrongUser]) {
        await expect(
          attempt(orderId, as(worker, RoleName.TRABAJADOR)),
        ).rejects.toThrow(/confirmación válida/);
        await untouched(orderId);
      }
    });
  });

  // ---------------------------------------------------------------------
  describe('Pagos: visita (RF-25, RN-04) y saldo (RF-40, RN-03)', () => {
    it('«Pago confirmado» de la visita (flujo de A) registra el cobro en efectivo y su constancia, una sola vez', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: true });
      await registerAdvance(orderId);
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      await post(
        worker,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(200);
      // Reintento (doble clic): no duplica el cobro.
      await post(
        worker,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(200);
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { orderId_concept: { orderId, concept: 'VISITA' } },
        include: { declarations: true },
      });
      expect(payment.expectedAmount?.toFixed(2)).toBe('30.00');
      expect(payment.declarations).toHaveLength(1);
      expect(payment.declarations[0]).toMatchObject({
        declaredBy: 'TRABAJADOR',
        userId: worker.id,
        method: 'EFECTIVO',
      });
      expect(payment.declarations[0].amount.toFixed(2)).toBe('30.00');

      const res = await get(client, `/orders/${orderId}/payments`).expect(200);
      const visit = res.body.payments.find(
        (p: { concept: string }) => p.concept === 'VISITA',
      );
      expect(visit).toMatchObject({
        requiredConfirmation: 'TRABAJADOR',
        comparison: 'SOLO_TRABAJADOR',
      });
      expect(
        (await notificationsOf(client.id, 'PAGO_DECLARADO')).length,
      ).toBeGreaterThan(0);
    });

    it('el cliente puede declarar «Ya pagué» de la visita (solo efectivo); el trabajador no por este endpoint', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: true });
      await registerAdvance(orderId);
      // Antes de la visita no hay nada que declarar.
      await declare(client, orderId, 'VISITA', {
        amount: '30.00',
        method: 'EFECTIVO',
      }).expect(409);
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      await declare(client, orderId, 'VISITA', {
        amount: '30.00',
        method: 'QR',
      }).expect(400);
      await declare(worker, orderId, 'VISITA', {
        amount: '30.00',
        method: 'EFECTIVO',
      }).expect(409);
      const res = await declare(client, orderId, 'VISITA', {
        amount: '30.00',
        method: 'EFECTIVO',
      }).expect(201);
      expect(res.body.payment.comparison).toBe('SOLO_CLIENTE');
      // Y despues el trabajador confirma: ambas quedan, ninguna infiere la otra.
      await post(
        worker,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(200);
      const after = await get(worker, `/orders/${orderId}/payments`).expect(
        200,
      );
      expect(
        after.body.payments.find(
          (p: { concept: string }) => p.concept === 'VISITA',
        ).comparison,
      ).toBe('MONTOS_COINCIDEN');
    });

    it('una visita sin costo no genera concepto de pago', async () => {
      const { orderId } = await agreedOrder({
        requiresVisit: true,
        visitCost: '0',
      });
      const res = await get(client, `/orders/${orderId}/payments`).expect(200);
      expect(
        res.body.payments.some(
          (p: { concept: string }) => p.concept === 'VISITA',
        ),
      ).toBe(false);
    });

    it('el saldo solo se declara con el trabajo terminado (RF-40)', async () => {
      const orderId = await executingOrder();
      await declare(worker, orderId, 'SALDO', {
        amount: '90.37',
        method: 'EFECTIVO',
      }).expect(409);
      await post(worker, `/orders/${orderId}/finish`).expect(200);
      const res = await declare(worker, orderId, 'SALDO', {
        amount: '90.37',
        method: 'QR',
      }).expect(201);
      expect(res.body.orderTransition).toBe('NO_APLICA');
      expect(res.body.payment).toMatchObject({
        concept: 'SALDO',
        requiredConfirmation: 'TRABAJADOR',
        comparison: 'SOLO_TRABAJADOR',
      });
      // Declarar el saldo no cierra el pedido: eso lo decide el flujo de A.
      expect(await statusOf(orderId)).toBe(OrderStatus.TERMINADO);
      // El cliente tambien puede, con otro monto: queda informativo.
      const client_ = await declare(client, orderId, 'SALDO', {
        amount: '80.00',
        method: 'EFECTIVO',
      }).expect(201);
      expect(client_.body.payment).toMatchObject({
        comparison: 'MONTOS_DIFERENTES',
        difference: '10.37',
      });
    });

    it('el saldo esperado incluye los presupuestos adicionales aceptados y no cambia el anticipo', async () => {
      const orderId = await executingOrder();
      const budget = await post(
        worker,
        `/orders/${orderId}/additional-budgets`,
        {
          amount: '50.00',
          reason: 'Cambio de tuberia',
          materials: 'Tubo PVC',
        },
      ).expect(201);
      // Con el adicional pendiente todavia no suma.
      const pending = await get(client, `/orders/${orderId}/payments`).expect(
        200,
      );
      expect(pending.body.agreement.acceptedAdditional).toBe('0.00');
      await post(
        client,
        `/orders/${orderId}/additional-budgets/${budget.body.budget.id as string}/accept`,
      ).expect(200);
      const res = await get(client, `/orders/${orderId}/payments`).expect(200);
      expect(res.body.agreement).toEqual({
        baseAmount: '120.50',
        acceptedAdditional: '50.00',
        totalAmount: '170.50',
      });
      // anticipo 30.13 (sobre el monto acordado); saldo = 170.50 - 30.13.
      expect(res.body.balance).toMatchObject({
        status: 'CALCULADO',
        amount: '140.37',
        advanceAmount: '30.13',
        additionalBudgetsTotal: '50.00',
      });
    });

    it('guarda el monto esperado del anticipo congelado al crearse el pago', async () => {
      const { orderId } = await agreedOrder();
      await declare(client, orderId, 'ANTICIPO').expect(201);
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { orderId_concept: { orderId, concept: 'ANTICIPO' } },
      });
      expect(payment.expectedAmount?.toFixed(2)).toBe('30.13');
    });
  });

  // ---------------------------------------------------------------------
  describe('Calificaciones (RF-44 a RF-46)', () => {
    it('sin estados configurados las calificaciones estan deshabilitadas', async () => {
      const orderId = await finishedOrder();
      const mine = await get(client, `/orders/${orderId}/reviews/mine`).expect(
        200,
      );
      expect(mine.body).toMatchObject({
        canReview: false,
        alreadyReviewed: false,
      });
      expect(mine.body.reason).toMatch(/todavía no están habilitadas/);
      await post(client, `/orders/${orderId}/reviews`, { rating: 5 }).expect(
        409,
      );
    });

    it('califica un trabajo terminado: una por parte, mutua, sin autocalificacion y solo participantes', async () => {
      reviewsConfig.policy = statusEligibilityPolicy([
        OrderStatus.TERMINADO,
        OrderStatus.CERRADO,
      ]);
      const orderId = await finishedOrder();
      const mine = await get(client, `/orders/${orderId}/reviews/mine`).expect(
        200,
      );
      expect(mine.body.canReview).toBe(true);

      const review = await post(client, `/orders/${orderId}/reviews`, {
        rating: 5,
        comment: 'Excelente trabajo',
      }).expect(201);
      expect(review.body).toMatchObject({
        orderId,
        authorRole: 'CLIENTE',
        rating: 5,
        comment: 'Excelente trabajo',
        hidden: false,
      });
      // Una sola vez por parte y pedido.
      await post(client, `/orders/${orderId}/reviews`, { rating: 4 }).expect(
        409,
      );
      expect(
        (await get(client, `/orders/${orderId}/reviews/mine`).expect(200)).body,
      ).toMatchObject({ alreadyReviewed: true, canReview: false });

      // Mutua: el trabajador califica al cliente.
      const back = await post(worker, `/orders/${orderId}/reviews`, {
        rating: 4,
      }).expect(201);
      expect(back.body.authorRole).toBe('TRABAJADOR');
      const stored = await prisma.review.findMany({ where: { orderId } });
      expect(stored).toHaveLength(2);
      expect(stored.find((r) => r.authorId === client.id)?.targetId).toBe(
        worker.id,
      );
      expect(stored.find((r) => r.authorId === worker.id)?.targetId).toBe(
        client.id,
      );

      // Terceros y administradores no califican.
      await post(client2, `/orders/${orderId}/reviews`, { rating: 5 }).expect(
        404,
      );
      await post(worker2, `/orders/${orderId}/reviews`, { rating: 5 }).expect(
        404,
      );
      await post(admin, `/orders/${orderId}/reviews`, { rating: 5 }).expect(
        404,
      );
      // Aviso al calificado.
      expect(
        (await notificationsOf(worker.id, 'CALIFICACION_RECIBIDA')).length,
      ).toBeGreaterThan(0);
    });

    it('no se califica un trabajo no terminado ni cancelado, y valida el puntaje', async () => {
      reviewsConfig.policy = statusEligibilityPolicy([OrderStatus.TERMINADO]);
      const executing = await executingOrder();
      await post(client, `/orders/${executing}/reviews`, { rating: 5 }).expect(
        409,
      );
      const cancelled = await agreedOrder();
      await post(client, `/orders/${cancelled.orderId}/cancel-work`, {
        reason: 'Cambio de planes',
      }).expect(200);
      await post(client, `/orders/${cancelled.orderId}/reviews`, {
        rating: 5,
      }).expect(409);

      const finished = await finishedOrder();
      for (const rating of [0, 6, 2.5, '5', null]) {
        await post(client, `/orders/${finished}/reviews`, { rating }).expect(
          400,
        );
      }
      await post(client, `/orders/${finished}/reviews`, {
        rating: 5,
        comment: 'a'.repeat(1001),
      }).expect(400);
      await post(client, `/orders/${finished}/reviews`, {
        rating: 5,
        authorId: worker.id,
        targetId: client.id,
      }).expect(400);
    });

    it('la base de datos impide la autocalificacion, duplicados y editar el puntaje', async () => {
      reviewsConfig.policy = statusEligibilityPolicy([OrderStatus.TERMINADO]);
      const orderId = await finishedOrder();
      await expect(
        prisma.review.create({
          data: {
            orderId,
            authorId: client.id,
            targetId: client.id,
            authorRole: RoleName.CLIENTE,
            rating: 5,
          },
        }),
      ).rejects.toThrow();
      await post(client, `/orders/${orderId}/reviews`, { rating: 3 }).expect(
        201,
      );
      const review = await prisma.review.findFirstOrThrow({
        where: { orderId },
      });
      await expect(
        prisma.review.update({ where: { id: review.id }, data: { rating: 5 } }),
      ).rejects.toThrow();
      await expect(
        prisma.review.delete({ where: { id: review.id } }),
      ).rejects.toThrow();
    });

    it('perfil publico: promedio y opiniones sin datos privados; sin calificaciones lo indica', async () => {
      reviewsConfig.policy = statusEligibilityPolicy([OrderStatus.TERMINADO]);
      // worker2 aun no tiene calificaciones.
      const fresh = await http()
        .get(`/api/workers/${worker2.id}/public-profile`)
        .expect(200);
      expect(fresh.body.rating).toMatchObject({
        average: null,
        count: 0,
        message: 'Este trabajador aún no tiene calificaciones.',
      });

      const o1 = await agreedOrder({ by: worker2 });
      await registerAdvance(o1.orderId);
      await post(worker2, `/orders/${o1.orderId}/start`).expect(200);
      await post(worker2, `/orders/${o1.orderId}/finish`).expect(200);
      const o2 = await agreedOrder({ by: worker2, owner: client2 });
      await registerAdvance(o2.orderId);
      await post(worker2, `/orders/${o2.orderId}/start`).expect(200);
      await post(worker2, `/orders/${o2.orderId}/finish`).expect(200);
      await post(client, `/orders/${o1.orderId}/reviews`, {
        rating: 5,
        comment: 'Muy puntual',
      }).expect(201);
      await post(client2, `/orders/${o2.orderId}/reviews`, {
        rating: 4,
      }).expect(201);
      // Las opiniones del trabajador sobre el cliente no cuentan en su perfil.
      await post(worker2, `/orders/${o1.orderId}/reviews`, {
        rating: 1,
      }).expect(201);

      // Es PUBLICO: sin token.
      const res = await http()
        .get(`/api/workers/${worker2.id}/public-profile`)
        .expect(200);
      expect(res.body.rating).toMatchObject({ average: 4.5, count: 2 });
      expect(res.body.recentOpinions).toHaveLength(2);
      expect(res.body.recentOpinions[0].author).toBe('client2 E.');
      const text = JSON.stringify(res.body);
      for (const secret of [
        worker2.email,
        '71000002',
        client.email,
        client.id,
        client2.id,
        o1.orderId,
        ADDRESS,
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(res.body.profile).toMatchObject({
        workerId: worker2.id,
        firstName: 'worker2',
        yearsOfExperience: 5,
      });

      const page = await http()
        .get(`/api/workers/${worker2.id}/reviews?limit=1&page=2`)
        .expect(200);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 1, total: 2 });
      expect(page.body.data).toHaveLength(1);
      await http()
        .get(`/api/workers/${worker2.id}/reviews?limit=500`)
        .expect(400);

      // Calificaciones recibidas por el cliente (RF-44 criterio 2).
      const received = await get(client, '/reviews/received').expect(200);
      expect(received.body.data[0]).toMatchObject({ rating: 1 });
    });

    it('un trabajador inexistente, sin perfil aprobado o un cliente no tienen perfil publico (404)', async () => {
      await http()
        .get(`/api/workers/${randomUUID()}/public-profile`)
        .expect(404);
      await http().get(`/api/workers/${client.id}/public-profile`).expect(404);
      await http().get(`/api/workers/${client.id}/reviews`).expect(404);
      await http().get('/api/workers/no-es-uuid/public-profile').expect(400);
    });

    it('el administrador oculta una opinion: deja de mostrarse y el promedio se recalcula (RF-46 A1)', async () => {
      reviewsConfig.policy = statusEligibilityPolicy([OrderStatus.TERMINADO]);
      const before = await http()
        .get(`/api/workers/${worker.id}/public-profile`)
        .expect(200);
      const baseCount = before.body.rating.count as number;
      const orderId = await finishedOrder();
      const created = await post(client, `/orders/${orderId}/reviews`, {
        rating: 1,
        comment: 'Opinion que incumple las reglas',
      }).expect(201);
      const withReview = await http()
        .get(`/api/workers/${worker.id}/public-profile`)
        .expect(200);
      expect(withReview.body.rating.count).toBe(baseCount + 1);

      await patch(
        client,
        `/admin/reviews/${created.body.id as string}/hide`,
      ).expect(403);
      const hidden = await patch(
        admin,
        `/admin/reviews/${created.body.id as string}/hide`,
      ).expect(200);
      expect(hidden.body).toMatchObject({ hidden: true, hiddenById: admin.id });
      // Idempotente.
      await patch(
        admin,
        `/admin/reviews/${created.body.id as string}/hide`,
      ).expect(200);
      const after = await http()
        .get(`/api/workers/${worker.id}/public-profile`)
        .expect(200);
      expect(after.body.rating.count).toBe(baseCount);
      expect(JSON.stringify(after.body)).not.toContain(
        'Opinion que incumple las reglas',
      );
      await patch(admin, `/admin/reviews/${randomUUID()}/hide`).expect(404);
      const list = await get(admin, '/admin/reviews').expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      await get(client, '/admin/reviews').expect(403);
    });
  });

  // ---------------------------------------------------------------------
  describe('Seguimiento del pedido (RF-32)', () => {
    it('une historial, negociacion, flujo y pagos en orden cronologico, con autor y sin la direccion', async () => {
      const orderId = await createOrder();
      const offer1 = await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot(), { requiresVisit: true, visitCost: '30.00' }),
      ).expect(201);
      const offer2 = await post(
        worker2,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      await post(client, `/offers/${offer1.body.id as string}/accept`).expect(
        200,
      );
      await registerAdvance(orderId);
      await declare(client, orderId, 'ANTICIPO').expect(201);
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      await post(
        worker,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(200);
      await post(worker, `/orders/${orderId}/start`).expect(200);
      await post(worker, `/orders/${orderId}/finish`).expect(200);

      const res = await get(
        client,
        `/orders/${orderId}/timeline?limit=100`,
      ).expect(200);
      const events = res.body.data as {
        source: string;
        type: string;
        at: string;
        summary: string;
        actor: { type: string; userId?: string; role?: string };
        details?: Record<string, unknown>;
      }[];
      const times = events.map((e) => new Date(e.at).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      const types = events.map((e) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'PEDIDO_PUBLICADO',
          'OFERTA_PROPUESTA',
          'OFERTA_ACEPTADA',
          'PEDIDO_ACORDADO',
          'PEDIDO_ANTICIPO_REGISTRADO',
          'VISITA_COSTO',
          'PEDIDO_TERMINADO',
          'CONSTANCIA_SERVICIO',
          'PAGO_ANTICIPO_CLIENTE',
          'PAGO_VISITA_TRABAJADOR',
          'PLAZO_CONFORMIDAD',
        ]),
      );
      expect(new Set(events.map((e) => e.source))).toEqual(
        new Set(['orders', 'offers', 'workflow', 'payments']),
      );
      // Quien ofrecio, a quien y el costo de la visita al acordar.
      const accepted = events.find((e) => e.type === 'OFERTA_ACEPTADA');
      expect(accepted?.details).toMatchObject({
        workerId: worker.id,
        clientId: client.id,
        agreedAmount: '120.50',
        visitCost: '30.00',
      });
      expect(accepted?.actor).toMatchObject({
        userId: client.id,
        role: 'CLIENTE',
      });
      // El cliente ve las ofertas de ambos trabajadores.
      expect(
        new Set(
          events
            .filter((e) => e.source === 'offers')
            .map((e) => e.details?.workerId),
        ),
      ).toEqual(new Set([worker.id, worker2.id]));
      // Sin direccion ni ubicacion en vivo.
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(ADDRESS);
      expect(text.toLowerCase()).not.toMatch(
        /latitud|longitud|ubicaci[oó]n en vivo/,
      );

      // El trabajador asignado solo ve SU negociacion, no la del otro trabajador.
      const asWorker = await get(worker, `/orders/${orderId}/timeline`).expect(
        200,
      );
      const offerEvents = (asWorker.body.data as typeof events).filter(
        (e) => e.source === 'offers',
      );
      expect(offerEvents.length).toBeGreaterThan(0);
      expect(offerEvents.every((e) => e.details?.workerId === worker.id)).toBe(
        true,
      );
      expect(JSON.stringify(asWorker.body)).not.toContain(worker2.id);
      expect(JSON.stringify(asWorker.body)).not.toContain(offer2.body.id);

      // El administrador ve todo.
      const asAdmin = await get(
        admin,
        `/orders/${orderId}/timeline?limit=100`,
      ).expect(200);
      expect(asAdmin.body.data.length).toBe(events.length);
    });

    it('pagina por cursor sin repetir ni saltar eventos', async () => {
      const orderId = await finishedOrder();
      const all = await get(
        client,
        `/orders/${orderId}/timeline?limit=100`,
      ).expect(200);
      const total = all.body.data.length as number;
      expect(total).toBeGreaterThan(3);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await get(
          client,
          `/orders/${orderId}/timeline?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200);
        expect(page.body.data.length).toBeLessThanOrEqual(2);
        seen.push(
          ...page.body.data.map(
            (e: { source: string; id: string }) => `${e.source}:${e.id}`,
          ),
        );
        cursor = page.body.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 50);
      expect(seen).toEqual(
        all.body.data.map(
          (e: { source: string; id: string }) => `${e.source}:${e.id}`,
        ),
      );
      expect(new Set(seen).size).toBe(total);
    });

    it('protege el acceso y valida los parametros', async () => {
      const { orderId } = await agreedOrder();
      await get(client2, `/orders/${orderId}/timeline`).expect(404);
      await get(worker2, `/orders/${orderId}/timeline`).expect(404);
      await get(client, `/orders/${randomUUID()}/timeline`).expect(404);
      await http().get(`/api/orders/${orderId}/timeline`).expect(401);
      await get(client, `/orders/${orderId}/timeline?limit=0`).expect(400);
      await get(client, `/orders/${orderId}/timeline?limit=101`).expect(400);
      await get(client, `/orders/${orderId}/timeline?cursor=basura`).expect(
        400,
      );
    });

    it('registra el reclamo y su resolucion sin exponer el texto', async () => {
      const orderId = await finishedOrder();
      const claim = await http()
        .post(`/api/orders/${orderId}/claims`)
        .set('Authorization', auth(client))
        .field('description', 'La llave sigue goteando y el piso quedo mojado')
        .expect(201);
      await post(admin, `/admin/claims/${claim.body.id as string}/decision`, {
        decision: 'Se reprograma la reparacion',
        justification: 'El trabajador acepto volver',
      }).expect(200);
      const res = await get(
        worker,
        `/orders/${orderId}/timeline?limit=100`,
      ).expect(200);
      const types = (res.body.data as { type: string }[]).map((e) => e.type);
      expect(types).toEqual(
        expect.arrayContaining(['RECLAMO_PRESENTADO', 'RECLAMO_RESUELTO']),
      );
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('La llave sigue goteando');
      expect(text).not.toContain('Se reprograma la reparacion');
    });
  });

  // ---------------------------------------------------------------------
  describe('Avisos internos de eventos reales (RF-33)', () => {
    it('al cancelar el trabajo no avisa a quien perdio la oferta al aceptarse otra', async () => {
      const orderId = await createOrder();
      const winner = await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      await post(
        worker2,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      await post(client, `/offers/${winner.body.id as string}/accept`).expect(
        200,
      );
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'Cambio de planes',
      }).expect(200);

      const received = await prisma.notification.findMany({
        where: { type: 'PEDIDO_CANCELADO', resourceId: orderId },
        select: { userId: true },
      });
      expect(received.map((row) => row.userId)).toEqual([worker.id]);
    });

    it('al cancelar un pedido en negociacion avisa a quienes tenian oferta abierta', async () => {
      const orderId = await createOrder();
      await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      await post(client, `/orders/me/${orderId}/cancel`, {
        reason: 'Cancelacion de prueba',
      }).expect(200);

      const received = await prisma.notification.findMany({
        where: { type: 'PEDIDO_CANCELADO', resourceId: orderId },
        select: { userId: true },
      });
      expect(received.map((row) => row.userId)).toEqual([worker.id]);
    });

    it('al vencer un pedido avisa al cliente y a los trabajadores con oferta abierta', async () => {
      const orderId = await createOrder();
      await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      // Una oferta retirada antes del vencimiento no recibe el aviso.
      const withdrawn = await post(
        worker2,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      await post(
        worker2,
        `/offers/${withdrawn.body.id as string}/withdraw`,
      ).expect(200);

      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${orderId}::uuid`;
      await app.get(OrderExpirationService).expireDue();

      const received = await prisma.notification.findMany({
        where: { type: 'PEDIDO_VENCIDO', resourceId: orderId },
        select: { userId: true },
      });
      expect(received.map((row) => row.userId).sort()).toEqual(
        [client.id, worker.id].sort(),
      );
    });

    it('avisa la nueva oferta, la aceptacion, el trabajo terminado y la cancelacion', async () => {
      const orderId = await createOrder();
      const offer = await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      const received = await prisma.notification.findMany({
        where: {
          userId: client.id,
          type: 'OFERTA_RECIBIDA',
          resourceId: offer.body.id,
        },
      });
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        resourceType: 'OFERTA',
        readAt: null,
      });
      // El autor de la oferta no se avisa a si mismo.
      expect(
        await prisma.notification.count({
          where: { userId: worker.id, resourceId: offer.body.id },
        }),
      ).toBe(0);

      await post(client, `/offers/${offer.body.id as string}/accept`).expect(
        200,
      );
      expect(
        await prisma.notification.count({
          where: {
            userId: worker.id,
            type: 'OFERTA_ACEPTADA',
            resourceId: offer.body.id,
          },
        }),
      ).toBe(1);

      await registerAdvance(orderId);
      await post(worker, `/orders/${orderId}/start`).expect(200);
      await post(worker, `/orders/${orderId}/finish`).expect(200);
      expect(
        await prisma.notification.count({
          where: {
            userId: client.id,
            type: 'TRABAJO_TERMINADO',
            resourceId: orderId,
          },
        }),
      ).toBe(1);

      const other = await agreedOrder();
      await post(client, `/orders/${other.orderId}/cancel-work`, {
        reason: 'Cambio de planes',
      }).expect(200);
      expect(
        await prisma.notification.count({
          where: {
            userId: worker.id,
            type: 'PEDIDO_CANCELADO',
            resourceId: other.orderId,
          },
        }),
      ).toBe(1);
      // El cliente que cancela no se avisa a si mismo.
      expect(
        await prisma.notification.count({
          where: {
            userId: client.id,
            type: 'PEDIDO_CANCELADO',
            resourceId: other.orderId,
          },
        }),
      ).toBe(0);
    });

    it('avisa a los oferentes con ofertas abiertas al cancelar un pedido sin acuerdo', async () => {
      const orderId = await createOrder();
      await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      const withdrawn = await post(
        worker2,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      await post(
        worker2,
        `/offers/${withdrawn.body.id as string}/withdraw`,
      ).expect(200);
      await http()
        .post(`/api/orders/me/${orderId}/cancel`)
        .set('Authorization', auth(client))
        .send({ reason: 'Cancelacion de prueba' })
        .expect(200);
      expect(
        await prisma.notification.count({
          where: {
            userId: worker.id,
            type: 'PEDIDO_CANCELADO',
            resourceId: orderId,
          },
        }),
      ).toBe(1);
      // Quien retiro su oferta no recibe el aviso.
      expect(
        await prisma.notification.count({
          where: {
            userId: worker2.id,
            type: 'PEDIDO_CANCELADO',
            resourceId: orderId,
          },
        }),
      ).toBe(0);
    });

    it('avisa el presupuesto adicional, el reclamo y su resolucion, y nunca incluye datos privados', async () => {
      const orderId = await executingOrder();
      const budget = await post(
        worker,
        `/orders/${orderId}/additional-budgets`,
        {
          amount: '50.00',
          reason: 'Cambio de tuberia',
          materials: 'Tubo PVC',
        },
      ).expect(201);
      expect(
        await prisma.notification.count({
          where: {
            userId: client.id,
            type: 'PRESUPUESTO_ADICIONAL_PROPUESTO',
            resourceId: orderId,
          },
        }),
      ).toBe(1);
      await post(
        client,
        `/orders/${orderId}/additional-budgets/${budget.body.budget.id as string}/accept`,
      ).expect(200);
      expect(
        await prisma.notification.count({
          where: {
            userId: worker.id,
            type: 'PRESUPUESTO_ADICIONAL_ACEPTADO',
            resourceId: orderId,
          },
        }),
      ).toBe(1);
      await post(worker, `/orders/${orderId}/finish`).expect(200);
      const claim = await http()
        .post(`/api/orders/${orderId}/claims`)
        .set('Authorization', auth(client))
        .field('description', 'El trabajo quedo incompleto en la cocina')
        .expect(201);
      expect(
        await prisma.notification.count({
          where: { userId: admin.id, type: 'RECLAMO_PRESENTADO' },
        }),
      ).toBeGreaterThan(0);
      await post(
        admin,
        `/admin/claims/${claim.body.id as string}/review`,
      ).expect(200);
      await post(admin, `/admin/claims/${claim.body.id as string}/decision`, {
        decision: 'Se reprograma',
        justification: 'Acuerdo entre las partes',
      }).expect(200);
      for (const userId of [client.id, worker.id]) {
        expect(
          await prisma.notification.count({
            where: { userId, type: 'RECLAMO_RESUELTO', resourceId: orderId },
          }),
        ).toBe(1);
      }
      const all = await prisma.notification.findMany({
        where: { OR: [{ userId: client.id }, { userId: worker.id }] },
      });
      const text = JSON.stringify(all);
      expect(text).not.toContain(ADDRESS);
      expect(text).not.toContain('71000001');
    });

    it('los avisos se guardan en la transaccion del hecho: si el aviso falla, el hecho se revierte', async () => {
      const orderId = await createOrder();
      const offer = await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(nextSlot()),
      ).expect(201);
      const notifications = app.get(
        (await import('../src/modules/notifications/notifications.service.js'))
          .NotificationsService,
      );
      const original = notifications.create.bind(notifications);
      notifications.create = () => Promise.reject(new Error('fallo simulado'));
      try {
        await post(client, `/offers/${offer.body.id as string}/accept`).expect(
          500,
        );
      } finally {
        notifications.create = original;
      }
      // El hecho no quedo a medias: la oferta sigue vigente y el pedido sin acordar.
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_NEGOCIACION);
      expect(
        (await prisma.offer.findUniqueOrThrow({ where: { id: offer.body.id } }))
          .status,
      ).toBe('VIGENTE');
      await post(client, `/offers/${offer.body.id as string}/accept`).expect(
        200,
      );
    });
  });

  // ---------------------------------------------------------------------
  describe('Agenda (RF-29 a RF-31)', () => {
    it('muestra el horario semanal y los trabajos acordados que ocupan la agenda', async () => {
      const start = nextMondayAt(9, 30);
      const { orderId } = await agreedOrder({ startAt: start });
      const res = await get(worker, '/agenda/me').expect(200);
      expect(res.body.timeZone).toBe('America/La_Paz');
      expect(res.body.schedules).toEqual([
        expect.objectContaining({
          dayOfWeek: 'LUNES',
          startTime: '08:00',
          endTime: '18:00',
        }),
      ]);
      const job = res.body.jobs.find(
        (j: { orderId: string }) => j.orderId === orderId,
      );
      expect(job).toMatchObject({
        orderStatus: 'ACORDADO',
        durationMinutes: 30,
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
      });
      expect(JSON.stringify(res.body)).not.toContain(ADDRESS);
      // Solo trabajadores aprobados.
      await get(client, '/agenda/me').expect(403);
      await http().get('/api/agenda/me').expect(401);
    });

    it('detecta cruces con trabajos acordados y libera la franja al cancelar (RF-30)', async () => {
      const start = nextMondayAt(10, 31);
      const { orderId } = await agreedOrder({ startAt: start });
      const overlapping = await post(worker, '/agenda/me/check', {
        startAt: new Date(start.getTime() + 15 * 60_000).toISOString(),
        durationMinutes: 30,
      }).expect(200);
      expect(overlapping.body.available).toBe(false);
      expect(overlapping.body.conflicts).toHaveLength(1);
      expect(overlapping.body.conflicts[0].orderId).toBe(orderId);

      // Contiguo (el otro termina justo cuando empieza este): sin cruce.
      const contiguous = await post(worker, '/agenda/me/check', {
        startAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
        durationMinutes: 30,
      }).expect(200);
      expect(contiguous.body.available).toBe(true);

      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'Cambio de planes',
      }).expect(200);
      const released = await post(worker, '/agenda/me/check', {
        startAt: start.toISOString(),
        durationMinutes: 30,
      }).expect(200);
      expect(released.body.available).toBe(true);
    });

    it('informa si el rango cae fuera del horario de atencion sin bloquear nada', async () => {
      // Martes: el trabajador solo atiende los lunes.
      const tuesday = new Date(nextMondayAt(10, 32).getTime() + DAY);
      const res = await post(worker, '/agenda/me/check', {
        startAt: tuesday.toISOString(),
        durationMinutes: 60,
      }).expect(200);
      expect(res.body).toMatchObject({
        withinSchedule: false,
        available: true,
      });
      expect(res.body.note).toMatch(/fuera de tu horario/);
      const monday = await post(worker, '/agenda/me/check', {
        startAt: nextMondayAt(10, 32).toISOString(),
        durationMinutes: 60,
      }).expect(200);
      expect(monday.body).toMatchObject({ withinSchedule: true, note: null });
    });

    it('valida la fecha (zona explicita) y la duracion', async () => {
      await post(worker, '/agenda/me/check', {
        startAt: '2026-12-07T10:00:00',
        durationMinutes: 30,
      }).expect(400);
      await post(worker, '/agenda/me/check', {
        startAt: nextMondayAt(10, 33).toISOString(),
        durationMinutes: 0,
      }).expect(400);
      await post(worker, '/agenda/me/check', {
        startAt: nextMondayAt(10, 33).toISOString(),
        durationMinutes: 30 * 24 * 60 + 1,
      }).expect(400);
      await post(client, '/agenda/me/check', {
        startAt: nextMondayAt(10, 33).toISOString(),
        durationMinutes: 30,
      }).expect(403);
    });

    it('la aceptacion de ofertas sigue rechazando un cruce real (regla existente, sin cambios)', async () => {
      const start = nextMondayAt(11, 34);
      await agreedOrder({ startAt: start });
      const orderId = await createOrder(client2);
      const offer = await post(
        worker,
        `/offers/orders/${orderId}`,
        offerBody(new Date(start.getTime() + 10 * 60_000)),
      ).expect(201);
      await post(client2, `/offers/${offer.body.id as string}/accept`).expect(
        409,
      );
    });
  });
});
