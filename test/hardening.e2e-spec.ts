//=========================================================
// MODIFICADO: hardening.e2e-spec.ts
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
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import {
  OrderStatus,
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
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { ConformityClosureService } from '../src/modules/service-workflow/conformity-closure.service.js';
import { WorkerProfileService } from '../src/modules/worker-profile/worker-profile.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deleteOrderData } from './utils/orders-cleanup.js';
import { deleteWorkerData } from './utils/worker-profile-cleanup.js';

// Estabilizacion: privacidad del contacto, trabajadores suspendidos y
// transiciones protegidas. Corre sobre la base de .env y borra solo lo suyo.

const RUN_ID = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60 * 1000;

describe('Estabilizacion del backend (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let users: UsersService;
  let profiles: WorkerProfileService;
  let storageDir: string;
  let jpeg: Buffer;

  let admin: PublicUser;
  let client: PublicUser;
  let category: CatalogItem;
  let zone: CatalogItem;
  const created: PublicUser[] = [];

  interface Worker {
    user: PublicUser;
    profileId: string;
  }

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);
  const get = (user: PublicUser, url: string) =>
    http().get(`/api${url}`).set('Authorization', auth(user));

  const newUser = async (name: string) => {
    const user = await users.create({
      firstName: name,
      lastName: 'E2E',
      email: `${name}-${RUN_ID}@hardening-e2e.test`,
      passwordHash: 'hash',
      phone: '70000051',
    });
    created.push(user);
    return user;
  };
  const newWorker = async (name: string): Promise<Worker> => {
    const user = await newUser(name);
    const profile = await profiles.create(user.id, {
      yearsOfExperience: 3,
      zoneId: zone.id,
      categoryIds: [category.id],
      schedules: [{ dayOfWeek: 'LUNES', startTime: '08:00', endTime: '18:00' }],
    });
    await profiles.submit(user.id);
    await profiles.changeStatusByAdmin(admin.id, profile.id, {
      status: WorkerProfileStatus.APROBADO,
    });
    return { user: await users.findById(user.id), profileId: profile.id };
  };
  const suspendProfile = (worker: Worker) =>
    profiles.changeStatusByAdmin(admin.id, worker.profileId, {
      status: WorkerProfileStatus.SUSPENDIDO,
      reason: 'Motivo de prueba',
    });

  const newOrder = async () => {
    const res = await http()
      .post('/api/orders')
      .set('Authorization', auth(client))
      .field('categoryId', category.id)
      .field('zoneId', zone.id)
      .field('description', `Fuga de agua en la cocina ${randomUUID()}`)
      .field('budgetAmount', '150.00')
      .field('addressLine', 'Av. Siempre Viva 742')
      .attach('images', jpeg, { filename: 'foto.jpg' })
      .expect(201);
    return res.body.order.id as string;
  };

  let slot = 0;
  const openOffer = async (worker: Worker, orderId?: string) => {
    const id = orderId ?? (await newOrder());
    const res = await post(worker.user, `/offers/orders/${id}`, {
      amount: '120.50',
      requiresVisit: false,
      materialsIncluded: false,
      proposedStartAt: new Date(Date.now() + (2 + slot++) * DAY).toISOString(),
      estimatedDurationMinutes: 30,
    }).expect(201);
    return { orderId: id, offerId: res.body.id as string };
  };
  const agreedOrder = async (worker: Worker) => {
    const offer = await openOffer(worker);
    await post(client, `/offers/${offer.offerId}/accept`).expect(200);
    return offer;
  };
  const statusOf = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  /** Anticipo, inicio y fin por la API: pedido TERMINADO. */
  const finishedOrder = async (worker: Worker) => {
    const { orderId } = await agreedOrder(worker);
    await post(
      worker.user,
      `/orders/${orderId}/payments/ANTICIPO/declarations`,
      {
        amount: '30.13',
        method: 'EFECTIVO',
      },
    ).expect(201);
    await post(worker.user, `/orders/${orderId}/start`).expect(200);
    await post(worker.user, `/orders/${orderId}/finish`).expect(200);
    return orderId;
  };

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'hardening-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
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
    const catalogs = app.get(CatalogsService);
    const adminUser = await newUser('admin');
    await prisma.userRole.create({
      data: { userId: adminUser.id, role: RoleName.ADMINISTRADOR },
    });
    admin = await users.findById(adminUser.id);
    client = await newUser('client');
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Plomeria HD ${RUN_ID}`,
    });
    zone = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Norte HD ${RUN_ID}`,
    });
    jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#3366aa' },
    })
      .jpeg()
      .toBuffer();
  });

  afterAll(async () => {
    if (prisma) {
      const ids = created.map((user) => user.id);
      await deleteOrderData(prisma, ids);
      await deleteWorkerData(prisma, ids);
      await prisma.serviceCategory.deleteMany({
        where: { name: { contains: RUN_ID } },
      });
      await prisma.zone.deleteMany({ where: { name: { contains: RUN_ID } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  describe('limite de intentos de autenticacion', () => {
    const login = (email: string, password: string) =>
      http().post('/api/auth/login').send({ email, password });

    it('tras 5 fallos responde 429 con Retry-After, tambien a la clave correcta', async () => {
      const email = `limite-${RUN_ID}@hardening-e2e.test`;
      const res = await http()
        .post('/api/auth/register')
        .send({
          firstName: 'Limite',
          lastName: 'E2E',
          email,
          password: 'Password123',
        })
        .expect(201);
      created.push(res.body.user as PublicUser);

      for (let i = 0; i < 5; i += 1) {
        await login(email, 'Incorrecta123').expect(401);
      }
      const blocked = await login(email, 'Password123').expect(429);
      expect(blocked.body).toMatchObject({
        statusCode: 429,
        error: 'Too Many Requests',
      });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.body.accessToken).toBeUndefined();
      // Otra cuenta desde la misma conexion sigue pudiendo intentar.
      await login(`otro-${email}`, 'Incorrecta123').expect(401);
    });

    it('limita los registros por conexion (429)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        // Correo repetido: no crea cuentas, pero cuenta como intento.
        const res = await http()
          .post('/api/auth/register')
          .send({
            firstName: 'Limite',
            lastName: 'E2E',
            email: `limite-${RUN_ID}@hardening-e2e.test`,
            password: 'Password123',
          });
        statuses.push(res.status);
      }
      expect(statuses.filter((status) => status === 409)).toHaveLength(19);
      expect(statuses.slice(19)).toEqual([429, 429]);
    });
  });

  describe('cobro de la visita tras cancelar el trabajo', () => {
    /** Pedido acordado con visita cobrable, ya realizada o no. */
    const visitOrder = async (worker: Worker, visit: boolean) => {
      const orderId = await newOrder();
      const offer = await post(worker.user, `/offers/orders/${orderId}`, {
        amount: '120.50',
        requiresVisit: true,
        visitCost: '30.00',
        materialsIncluded: false,
        proposedStartAt: new Date(
          Date.now() + (40 + slot++) * DAY,
        ).toISOString(),
        estimatedDurationMinutes: 30,
      }).expect(201);
      await post(client, `/offers/${offer.body.id as string}/accept`).expect(
        200,
      );
      await declare(worker.user, orderId, 'ANTICIPO', '30.13').expect(201);
      if (visit) {
        await post(worker.user, `/orders/${orderId}/visit`).expect(201);
      }
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'Prueba',
      }).expect(200);
      return orderId;
    };
    const declare = (
      user: PublicUser,
      orderId: string,
      concept: string,
      amount: string,
    ) =>
      post(user, `/orders/${orderId}/payments/${concept}/declarations`, {
        amount,
        method: 'EFECTIVO',
      });

    it('se registra la visita realizada, una sola vez; anticipo y saldo no', async () => {
      const worker = await newWorker('visit-cancelled');
      const other = await newWorker('visit-cancelled-other');
      const orderId = await visitOrder(worker, true);
      const confirm = (user: PublicUser) =>
        post(user, `/orders/${orderId}/visit/payment-confirmation`);

      await confirm(other.user).expect(404);
      await confirm(client).expect(403);
      await declare(other.user, orderId, 'VISITA', '30.00').expect(404);
      await confirm(worker.user).expect(200);
      await confirm(worker.user).expect(200);
      await declare(client, orderId, 'VISITA', '30.00').expect(201);
      await declare(client, orderId, 'VISITA', '30.00').expect(409);
      expect(
        await prisma.paymentDeclaration.count({
          where: { payment: { orderId, concept: 'VISITA' } },
        }),
      ).toBe(2);

      await declare(client, orderId, 'ANTICIPO', '30.13').expect(409);
      await declare(client, orderId, 'SALDO', '90.00').expect(409);
      await declare(worker.user, orderId, 'SALDO', '90.00').expect(409);
      expect(await statusOf(orderId)).toBe(OrderStatus.CANCELADO);
    });

    it('sin visita realizada no hay nada que cobrar', async () => {
      const worker = await newWorker('visit-not-done');
      const orderId = await visitOrder(worker, false);

      await post(
        worker.user,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(409);
      await declare(client, orderId, 'VISITA', '30.00').expect(409);
    });
  });

  describe('RF-27: rechazo del presupuesto adicional', () => {
    /** Visita realizada, trabajo iniciado y un adicional pendiente. */
    const pendingBudget = async (worker: Worker) => {
      const orderId = await newOrder();
      const offer = await post(worker.user, `/offers/orders/${orderId}`, {
        amount: '120.50',
        requiresVisit: true,
        visitCost: '30.00',
        materialsIncluded: false,
        proposedStartAt: new Date(
          Date.now() + (80 + slot++) * DAY,
        ).toISOString(),
        estimatedDurationMinutes: 30,
      }).expect(201);
      await post(client, `/offers/${offer.body.id as string}/accept`).expect(
        200,
      );
      const asWorker = (url: string, body?: object) =>
        post(worker.user, `/orders/${orderId}${url}`, body);
      await asWorker('/payments/ANTICIPO/declarations', {
        amount: '30.13',
        method: 'EFECTIVO',
      }).expect(201);
      await asWorker('/visit').expect(201);
      await asWorker('/start').expect(200);
      const budget = await asWorker('/additional-budgets', {
        amount: '40.00',
        reason: 'Cambio de llave',
        materials: 'Llave de paso',
      }).expect(201);
      const budgetId = budget.body.budget.id as string;
      const url = `/orders/${orderId}/additional-budgets/${budgetId}`;
      return { orderId, budgetId, url, asWorker };
    };

    it('cierra el pedido con motivo, aviso y constancia; solo queda la visita', async () => {
      const worker = await newWorker('reject-budget');
      const { orderId, budgetId, url, asWorker } = await pendingBudget(worker);

      // Tiene tambien rol de cliente, pero no es el dueno.
      await post(worker.user, `${url}/reject`).expect(404);
      // El administrador de prueba tambien es cliente, pero no es el dueno.
      await post(admin, `${url}/reject`).expect(404);
      await post(client, `${url}/reject`, { reason: 'x'.repeat(401) }).expect(
        400,
      );
      const res = await post(client, `${url}/reject`, {
        reason: 'Es demasiado caro',
      }).expect(200);
      expect(res.body).toMatchObject({
        status: OrderStatus.CERRADO,
        budget: { id: budgetId, status: 'RECHAZADO' },
      });
      // Repetir o aceptar despues: 409 sin cambios.
      await post(client, `${url}/reject`).expect(409);
      await post(client, `${url}/accept`).expect(409);
      await asWorker('/finish').expect(409);
      await post(client, `/orders/${orderId}/claims`).expect(400);

      const history = await prisma.orderStatusHistory.findFirstOrThrow({
        where: { orderId, toStatus: OrderStatus.CERRADO },
      });
      expect(history).toMatchObject({
        changedById: client.id,
        reason: 'Presupuesto adicional rechazado: Es demasiado caro',
      });
      expect(
        await prisma.notification.count({
          where: {
            userId: worker.user.id,
            resourceId: orderId,
            type: 'PRESUPUESTO_ADICIONAL_RECHAZADO',
          },
        }),
      ).toBe(1);
      const timeline = await get(
        client,
        `/orders/${orderId}/timeline?limit=100`,
      ).expect(200);
      expect(
        (timeline.body.data as { type: string }[]).map((event) => event.type),
      ).toContain('ADICIONAL_RECHAZADO');

      // Pagos: la visita si; el saldo no.
      await asWorker('/visit/payment-confirmation').expect(200);
      await asWorker('/payments/SALDO/declarations', {
        amount: '90.00',
        method: 'EFECTIVO',
      }).expect(409);
      const payments = await get(client, `/orders/${orderId}/payments`).expect(
        200,
      );
      expect(payments.body.balance).toMatchObject({
        status: 'NO_APLICA',
        amount: null,
      });
      const mine = await get(client, `/orders/${orderId}/reviews/mine`).expect(
        200,
      );
      expect(mine.body.canReview).toBe(false);
      // El acuerdo termino: el asignado ya no ve la direccion.
      await get(worker.user, `/orders/assigned/${orderId}`).expect(404);
    });

    it('rechazar y aceptar a la vez: solo una respuesta gana', async () => {
      const worker = await newWorker('reject-race');
      const { orderId, url } = await pendingBudget(worker);

      const results = await Promise.all([
        post(client, `${url}/reject`),
        post(client, `${url}/accept`),
      ]);

      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect([OrderStatus.CERRADO, OrderStatus.EN_EJECUCION]).toContain(
        await statusOf(orderId),
      );
    });
  });

  describe('RF-16: busqueda de trabajadores', () => {
    const search = (user: PublicUser, categoryId: string, zoneId: string) =>
      get(
        user,
        `/workers/search?categoryId=${categoryId}&zoneId=${zoneId}&limit=50`,
      );

    it('solo muestra aprobados disponibles de esa categoria y zona, sin contacto', async () => {
      const catalogs = app.get(CatalogsService);
      const own = await catalogs.create(CatalogKind.ZONE, admin.id, {
        name: `Busqueda HD ${RUN_ID}`,
      });
      const previous = zone;
      zone = own;
      const found = await newWorker('search-found');
      const suspended = await newWorker('search-suspended');
      const pending = await newWorker('search-pending');
      zone = previous;
      await suspendProfile(suspended);
      await prisma.zoneChangeRequest.create({
        data: {
          profileId: pending.profileId,
          fromZoneId: own.id,
          toZoneId: zone.id,
          reason: 'Dato de prueba',
        },
      });

      const res = await search(client, category.id, own.id).expect(200);
      expect(res.body.message).toBeNull();
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        workerId: found.user.id,
        firstName: 'search-found',
        specialties: [{ id: category.id }],
        schedules: [
          { dayOfWeek: 'LUNES', startTime: '08:00', endTime: '18:00' },
        ],
        rating: { average: null, count: 0 },
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /email|phone|70000051|@hardening|status|document/i,
      );
      // El propio trabajador no se ve a si mismo (RN-14).
      const self = await search(found.user, category.id, own.id).expect(200);
      expect(self.body.data).toEqual([]);
    });

    it('sin resultados lo indica; valida la entrada y exige sesion de cliente', async () => {
      const empty = await app
        .get(CatalogsService)
        .create(CatalogKind.ZONE, admin.id, { name: `Vacia HD ${RUN_ID}` });
      const res = await search(client, category.id, empty.id).expect(200);
      expect(res.body).toMatchObject({ data: [], meta: { total: 0 } });
      expect(res.body.message).toContain('Puede publicar su pedido');

      await search(client, category.id, randomUUID()).expect(404);
      await get(client, '/workers/search').expect(400);
      await http()
        .get(`/api/workers/search?categoryId=${category.id}&zoneId=${empty.id}`)
        .expect(401);
    });
  });

  describe('RF-52: reportes administrativos', () => {
    const today = () =>
      new Date(Date.now() - 4 * 60 * 60_000).toISOString().slice(0, 10);
    const report = (user: PublicUser, type: string, query: string) =>
      get(user, `/admin/reports/${type}?${query}`);
    const range = () => `from=${today()}&to=${today()}`;

    it('agrupa pedidos y cancelaciones por categoria, zona y estado', async () => {
      const before = await report(admin, 'pedidos', range()).expect(200);
      const cancelled = await newOrder();
      await post(client, `/orders/me/${cancelled}/cancel`, {
        reason: 'Cancelacion de prueba',
      }).expect(200);
      await newOrder();

      const res = await report(admin, 'pedidos', range()).expect(200);
      expect(res.body.columns).toEqual([
        'categoria',
        'zona',
        'estado',
        'total',
      ]);
      expect(res.body.total).toBe((before.body.total as number) + 2);
      const rows = res.body.rows as (string | number)[][];
      expect(
        rows.find((r) => r[0] === category.name && r[2] === 'CANCELADO'),
      ).toBeDefined();
      expect(rows.reduce((sum, r) => sum + (r[3] as number), 0)).toBe(
        res.body.total,
      );
      const cancellations = await report(
        admin,
        'cancelaciones',
        range(),
      ).expect(200);
      expect(cancellations.body.rows).toContainEqual([
        category.name,
        zone.name,
        'PUBLICADO',
        expect.any(Number),
      ]);
    });

    it.each(['trabajadores', 'calificaciones', 'reclamos'])(
      'entrega el reporte de %s sin datos personales',
      async (type) => {
        const res = await report(admin, type, range()).expect(200);
        expect(res.body).toMatchObject({ report: type });
        expect(JSON.stringify(res.body)).not.toMatch(/@hardening|70000051/);
      },
    );

    it('exporta CSV e indica cuando no hay datos', async () => {
      const csv = await report(
        admin,
        'pedidos',
        `${range()}&format=csv`,
      ).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('attachment');
      expect(csv.text).toContain('categoria,zona,estado,total');

      const empty = await report(
        admin,
        'pedidos',
        'from=2000-01-01&to=2000-01-02',
      ).expect(200);
      expect(empty.body).toMatchObject({ rows: [], total: 0 });
      expect(empty.body.message).toContain('No hay datos');
    });

    it('valida la entrada y es solo para administradores', async () => {
      await report(admin, 'pedidos', 'from=2026-02-30&to=2026-03-01').expect(
        400,
      );
      await report(admin, 'pedidos', 'from=2026-03-02&to=2026-03-01').expect(
        400,
      );
      await report(admin, 'pedidos', '').expect(400);
      await report(admin, 'inexistente', range()).expect(400);
      await report(client, 'pedidos', range()).expect(403);
      await http().get(`/api/admin/reports/pedidos?${range()}`).expect(401);
    });
  });

  describe('bitacora de reclamos', () => {
    it('registra revision y decision con estados, sin el texto del reclamo', async () => {
      const worker = await newWorker('audited-claim');
      const orderId = await finishedOrder(worker);
      const claim = await http()
        .post(`/api/orders/${orderId}/claims`)
        .set('Authorization', auth(client))
        .field('description', 'TEXTO-PRIVADO-DEL-RECLAMO')
        .expect(201);
      const claimId = claim.body.id as string;
      await post(admin, `/admin/claims/${claimId}/review`).expect(200);
      await post(admin, `/admin/claims/${claimId}/decision`, {
        decision: 'DECISION-PRIVADA',
        justification: 'JUSTIFICACION-PRIVADA',
      }).expect(200);
      // Repetirla falla y no agrega registros.
      await post(admin, `/admin/claims/${claimId}/decision`, {
        decision: 'Otra',
        justification: 'Otra',
      }).expect(409);

      const res = await get(
        admin,
        `/audit-logs?entityType=RECLAMO&entityId=${claimId}`,
      ).expect(200);
      expect(
        (res.body.data as { details: object }[]).map((log) => log.details),
      ).toEqual([
        { orderId, fromStatus: 'EN_REVISION', toStatus: 'RESUELTO' },
        { orderId, fromStatus: 'ABIERTO', toStatus: 'EN_REVISION' },
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/PRIVAD/);
    });
  });

  describe('bitacora de cuentas', () => {
    it('registra los cambios de estado hechos por el administrador', async () => {
      const target = await newUser('audited-account');
      await http()
        .patch(`/api/users/${target.id}/status`)
        .set('Authorization', auth(admin))
        .send({ status: 'SUSPENDIDO' })
        .expect(200);

      const res = await get(
        admin,
        `/audit-logs?entityType=USUARIO&entityId=${target.id}`,
      ).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        action: 'CAMBIO_ESTADO',
        details: { fromStatus: 'ACTIVO', toStatus: 'SUSPENDIDO' },
        actor: { id: admin.id },
      });
    });
  });

  describe('transiciones protegidas frente a otros modulos', () => {
    const attempt = (orderId: string, change: Record<string, unknown>) =>
      prisma.$transaction((tx) =>
        app.get(OrdersService).transition(tx, {
          orderId,
          ...change,
        } as Parameters<OrdersService['transition']>[1]),
      );
    const asClient = () => ({
      type: 'USUARIO',
      userId: client.id,
      role: RoleName.CLIENTE,
    });

    it('no pasa a ACORDADO sin la oferta aceptada de ese trabajador', async () => {
      const worker = await newWorker('agree-open');
      const other = await newWorker('agree-none');
      const { orderId, offerId } = await openOffer(worker);
      for (const assignWorkerId of [worker.user.id, other.user.id]) {
        await expect(
          attempt(orderId, {
            to: OrderStatus.ACORDADO,
            actor: asClient(),
            assignWorkerId,
          }),
        ).rejects.toThrow('sin una oferta aceptada');
      }
      // Tampoco con la oferta aceptada de otro trabajador.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.offer.update({
            where: { id: offerId },
            data: { status: 'ACEPTADA', closedAt: new Date() },
          });
          await app.get(OrdersService).transition(tx, {
            orderId,
            to: OrderStatus.ACORDADO,
            actor: {
              type: 'USUARIO',
              userId: client.id,
              role: RoleName.CLIENTE,
            },
            assignWorkerId: other.user.id,
          });
        }),
      ).rejects.toThrow('sin una oferta aceptada');
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_NEGOCIACION);

      // El flujo real sigue funcionando.
      await post(client, `/offers/${offerId}/accept`).expect(200);
      expect(
        await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
      ).toMatchObject({
        status: OrderStatus.ACORDADO,
        assignedWorkerId: worker.user.id,
      });
    });

    it('no se cierra sin conformidad ni antes del plazo; ambos cierres reales funcionan', async () => {
      const worker = await newWorker('close-flow');
      const conformed = await finishedOrder(worker);
      for (const actor of [
        asClient(),
        { type: 'SISTEMA', process: 'OTRO_MODULO' },
        { type: 'SISTEMA', process: 'CIERRE_CONFORMIDAD' },
      ]) {
        await expect(
          attempt(conformed, { to: OrderStatus.CERRADO, actor }),
        ).rejects.toThrow('falta la conformidad');
      }
      expect(await statusOf(conformed)).toBe(OrderStatus.TERMINADO);
      await post(client, `/orders/${conformed}/confirm-conformity`).expect(200);
      expect(await statusOf(conformed)).toBe(OrderStatus.CERRADO);

      const expired = await finishedOrder(worker);
      const closure = app.get(ConformityClosureService);
      await expect(closure.closeOne(expired)).resolves.toBe(false);
      await prisma.$executeRaw`UPDATE "order_executions" SET "conformity_deadline" = now() - interval '1 minute' WHERE "order_id" = ${expired}::uuid`;
      await expect(closure.closeOne(expired)).resolves.toBe(true);
      expect(await statusOf(expired)).toBe(OrderStatus.CERRADO);
    });
  });

  describe('trabajador suspendido y pedido asignado', () => {
    it('pierde la direccion y las fotos; el cliente y el administrador no', async () => {
      const worker = await newWorker('assigned-suspended');
      const { orderId } = await agreedOrder(worker);
      const view = await get(worker.user, `/orders/assigned/${orderId}`).expect(
        200,
      );
      expect(view.body.address.addressLine).toBe('Av. Siempre Viva 742');
      const image = `/orders/assigned/${orderId}/images/${view.body.images[0].id as string}`;
      await get(worker.user, image).expect(200);
      const other = await newWorker('assigned-other');
      await get(other.user, `/orders/assigned/${orderId}`).expect(404);

      await suspendProfile(worker);
      const denied = await get(
        worker.user,
        `/orders/assigned/${orderId}`,
      ).expect(403);
      expect(JSON.stringify(denied.body)).not.toContain('Siempre Viva');
      await get(worker.user, image).expect(403);
      await get(worker.user, `${image}?variant=thumb`).expect(403);

      // El dueno y el administrador conservan su acceso.
      const owner = await get(client, `/orders/me/${orderId}`).expect(200);
      expect(owner.body.address.addressLine).toBe('Av. Siempre Viva 742');
      await get(
        client,
        `/orders/me/${orderId}/images/${view.body.images[0].id as string}`,
      ).expect(200);
      await get(admin, `/orders/admin/${orderId}`).expect(200);

      // Reactivado, recupera el acceso.
      await profiles.changeStatusByAdmin(admin.id, worker.profileId, {
        status: WorkerProfileStatus.APROBADO,
      });
      await get(worker.user, image).expect(200);
    });

    it('con la cuenta suspendida no hay sesion (401)', async () => {
      const worker = await newWorker('assigned-account');
      const { orderId } = await agreedOrder(worker);
      await users.updateStatus(admin.id, worker.user.id, {
        status: 'SUSPENDIDO',
      });
      await get(worker.user, `/orders/assigned/${orderId}`).expect(401);
    });

    it('un cambio de zona pendiente no le quita el acceso (RF-13)', async () => {
      const worker = await newWorker('assigned-pending');
      const { orderId } = await agreedOrder(worker);
      const target = await app
        .get(CatalogsService)
        .create(CatalogKind.ZONE, admin.id, { name: `Sur HD ${RUN_ID}` });
      await prisma.zoneChangeRequest.create({
        data: {
          profileId: worker.profileId,
          fromZoneId: zone.id,
          toZoneId: target.id,
          reason: 'Dato de prueba',
        },
      });
      await get(worker.user, `/orders/assigned/${orderId}`).expect(200);
    });
  });

  describe('contacto del cliente por WhatsApp', () => {
    const contact = (worker: Worker, offerId: string) =>
      get(worker.user, `/offers/me/${offerId}/whatsapp`);

    it('durante la negociacion y el acuerdo si; con el pedido cerrado no', async () => {
      const worker = await newWorker('contact-flow');
      const { orderId, offerId } = await openOffer(worker);
      await contact(worker, offerId).expect(200);

      await post(client, `/offers/${offerId}/accept`).expect(200);
      await contact(worker, offerId).expect(200);

      await post(
        worker.user,
        `/orders/${orderId}/payments/ANTICIPO/declarations`,
        { amount: '30.13', method: 'EFECTIVO' },
      ).expect(201);
      await post(worker.user, `/orders/${orderId}/start`).expect(200);
      await post(worker.user, `/orders/${orderId}/finish`).expect(200);
      await contact(worker, offerId).expect(200);
      await post(client, `/orders/${orderId}/confirm-conformity`).expect(200);

      const closed = await contact(worker, offerId).expect(409);
      expect(JSON.stringify(closed.body)).not.toMatch(/wa\.me|70000051/);
    });

    it.each(['reject', 'withdraw', 'expired', 'superseded', 'cancelled'])(
      'una oferta sin vigencia (%s) no entrega el telefono',
      async (how) => {
        const worker = await newWorker(`contact-${how}`);
        const { orderId, offerId } = await openOffer(worker);
        if (how === 'reject') {
          await post(client, `/offers/${offerId}/reject`).expect(200);
        } else if (how === 'withdraw') {
          await post(worker.user, `/offers/${offerId}/withdraw`).expect(200);
        } else if (how === 'expired') {
          await prisma.offer.update({
            where: { id: offerId },
            data: { expiresAt: new Date(Date.now() - 1000) },
          });
        } else if (how === 'superseded') {
          const other = await newWorker('contact-winner');
          const winner = await openOffer(other, orderId);
          await post(client, `/offers/${winner.offerId}/accept`).expect(200);
        } else {
          await post(client, `/orders/me/${orderId}/cancel`, {
            reason: 'Cancelacion de prueba',
          }).expect(200);
        }

        const res = await contact(worker, offerId).expect(409);
        expect(JSON.stringify(res.body)).not.toMatch(/wa\.me|70000051/);
      },
    );

    it('una oferta ajena responde 404 y un trabajador suspendido 403', async () => {
      const worker = await newWorker('contact-owner');
      const other = await newWorker('contact-other');
      const { offerId } = await agreedOrder(worker);
      await contact(other, offerId).expect(404);

      await suspendProfile(worker);
      await contact(worker, offerId).expect(403);
    });
  });
});
