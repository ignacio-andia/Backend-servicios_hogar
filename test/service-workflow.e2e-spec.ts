import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
import { ClaimsConfig } from '../src/modules/claims/claims.config.js';
import { OrderRetentionService } from '../src/modules/orders/order-retention.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { ConformityClosureService } from '../src/modules/service-workflow/conformity-closure.service.js';
import {
  WorkflowEvent,
  WorkflowEventRegistry,
} from '../src/modules/service-workflow/workflow-events.registry.js';
import { WorkflowQueryService } from '../src/modules/service-workflow/workflow-query.service.js';
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

// Corre sobre un esquema temporal con TODAS las migraciones (incluida la del
// ciclo de vida del trabajo): no toca los datos del esquema public.
// La aplicacion se arranca con AppModule, que registra todos los modulos.
const RUN_ID = randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

describe('ServiceWorkflowModule y ClaimsModule (RF-25 a RF-28, RF-34, RF-36 a RF-38, e2e)', () => {
  let app: INestApplication<App>;
  let isolated: IsolatedSchema;
  let scoped: PrismaClient;
  let prisma: PrismaService;
  let jwt: JwtService;
  let orders: OrdersService;
  let queries: WorkflowQueryService;
  let closure: ConformityClosureService;
  let storageDir: string;
  let jpeg: Buffer;

  let admin: PublicUser;
  let client: PublicUser;
  let client2: PublicUser;
  let worker: PublicUser;
  let worker2: PublicUser;
  let zone: CatalogItem;
  let category: CatalogItem;

  const seen: WorkflowEvent[] = [];
  let failHookFor: WorkflowEvent['type'] | null = null;

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const post = (user: PublicUser, url: string, body?: object) =>
    http().post(`/api${url}`).set('Authorization', auth(user)).send(body);
  const get = (user: PublicUser, url: string) =>
    http().get(`/api${url}`).set('Authorization', auth(user));

  let slot = 0;
  const nextSlot = () => {
    const n = slot++;
    return nextMondayAt(8 + (n % 9), Math.floor(n / 9));
  };

  /** Pedido ACORDADO con la oferta indicada (estado inicial del flujo). */
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
    const created = await http()
      .post('/api/orders')
      .set('Authorization', auth(owner))
      .field('categoryId', category.id)
      .field('zoneId', zone.id)
      .field('description', 'Fuga de agua debajo del lavaplatos de la cocina')
      .field('budgetAmount', '150.00')
      .field('addressLine', 'Av. Siempre Viva 742')
      .attach('images', jpeg, { filename: 'foto.jpg' })
      .expect(201);
    const orderId = created.body.order.id as string;
    const requiresVisit = options.requiresVisit ?? false;
    const offer = await post(by, `/offers/orders/${orderId}`, {
      amount: '120.50',
      requiresVisit,
      ...(requiresVisit ? { visitCost: options.visitCost ?? '30.00' } : {}),
      materialsIncluded: false,
      proposedStartAt: (options.startAt ?? nextSlot()).toISOString(),
      estimatedDurationMinutes: 30,
    }).expect(201);
    await post(owner, `/offers/${offer.body.id as string}/accept`).expect(200);
    return { orderId };
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

  /** Pedido sin visita, ya EN_EJECUCION. */
  const executingOrder = async (owner = client, by = worker) => {
    const { orderId } = await agreedOrder({ owner, by });
    await registerAdvance(orderId);
    await post(by, `/orders/${orderId}/start`).expect(200);
    return orderId;
  };
  const finishedOrder = async () => {
    const orderId = await executingOrder();
    await post(worker, `/orders/${orderId}/finish`).expect(200);
    return orderId;
  };
  const expireDeadline = (orderId: string) =>
    prisma.$executeRaw`UPDATE "order_executions" SET "conformity_deadline" = now() - interval '1 minute' WHERE "order_id" = ${orderId}::uuid`;

  const claim = (
    user: PublicUser,
    orderId: string,
    photos = 0,
    description: string | null = 'La llave sigue goteando',
  ) => {
    const req = http()
      .post(`/api/orders/${orderId}/claims`)
      .set('Authorization', auth(user));
    if (description !== null) {
      req.field('description', description);
    }
    for (let i = 0; i < photos; i += 1) {
      req.attach('images', jpeg, { filename: `r${i}.jpg` });
    }
    return req;
  };

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'workflow-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    isolated = await createIsolatedSchema('workflow');
    // Cliente propio: ademas de calificar las tablas del esquema temporal, fija
    // el search_path de la sesion, porque este modulo usa SQL crudo (FOR UPDATE)
    // con tablas sin calificar.
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

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    orders = app.get(OrdersService);
    queries = app.get(WorkflowQueryService);
    closure = app.get(ConformityClosureService);
    const catalogs = app.get(CatalogsService);
    const users = app.get(UsersService);
    const profiles = app.get(WorkerProfileService);

    // Hook de prueba: registra los eventos y puede fallar a pedido (atomicidad).
    app.get(WorkflowEventRegistry).register({
      name: 'e2e-recorder',
      inTransaction: (event) => {
        if (failHookFor === event.type) {
          return Promise.reject(new Error('fallo simulado del hook'));
        }
        seen.push(event);
        return Promise.resolve();
      },
    });

    const newUser = (name: string, phone?: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}@workflow-e2e.test`,
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
    failHookFor = null;
    seen.length = 0;
  });

  // ---------------------------------------------------------------------
  describe('RF-25: visita y cobro', () => {
    it('registra la visita solo con anticipo, una vez y solo el trabajador asignado', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: true });
      // Sin anticipo registrado todavia.
      await post(worker, `/orders/${orderId}/visit`).expect(409);
      await registerAdvance(orderId);
      // Rol equivocado (403), trabajador ajeno (404).
      await post(client, `/orders/${orderId}/visit`).expect(403);
      await post(worker2, `/orders/${orderId}/visit`).expect(404);
      // No puede iniciar el trabajo sin registrar la visita requerida.
      await post(worker, `/orders/${orderId}/start`).expect(409);

      const res = await post(worker, `/orders/${orderId}/visit`).expect(201);
      expect(res.body.status).toBe(OrderStatus.VISITA_REALIZADA);
      expect(res.body.visit.visitCost).toBe('30.00');
      // Reintento: no duplica ni cambia nada.
      await post(worker, `/orders/${orderId}/visit`).expect(409);
      expect(await prisma.orderVisit.count({ where: { orderId } })).toBe(1);
      expect(seen.some((e) => e.type === 'VISITA_REGISTRADA')).toBe(true);
    });

    it('una oferta por fotos no admite visita', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: false });
      await registerAdvance(orderId);
      await post(worker, `/orders/${orderId}/visit`).expect(409);
    });

    it('el cobro de la visita queda registrado en pagos, una sola vez y con su constancia', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: true });
      await registerAdvance(orderId);
      const url = `/orders/${orderId}/visit/payment-confirmation`;
      // Sin visita registrada todavia no hay cobro que confirmar.
      await post(worker, url).expect(409);
      // El anticipo ya se registro: aun no hay pago de la visita.
      const visitPayment = { orderId, concept: 'VISITA' as const };
      expect(await prisma.payment.count({ where: visitPayment })).toBe(0);
      const noticesToClient = () =>
        prisma.notification.count({
          where: {
            userId: client.id,
            type: 'PAGO_DECLARADO',
            resourceId: orderId,
          },
        });
      const noticesBefore = await noticesToClient();
      await post(worker, `/orders/${orderId}/visit`).expect(201);

      await post(client, url).expect(403);
      await post(worker2, url).expect(404);
      // Doble confirmacion simultanea y un reintento: idempotente.
      const results = await Promise.all([post(worker, url), post(worker, url)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      await post(worker, url).expect(200);

      const payments = await prisma.payment.findMany({
        where: visitPayment,
        include: { declarations: true },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0].concept).toBe('VISITA');
      expect(payments[0].declarations).toHaveLength(1);
      expect(payments[0].declarations[0]).toMatchObject({
        declaredBy: 'TRABAJADOR',
        userId: worker.id,
        method: 'EFECTIVO',
      });
      expect(payments[0].declarations[0].amount.toFixed(2)).toBe('30.00');
      expect(await prisma.serviceReceipt.count({ where: { orderId } })).toBe(1);
      // El cliente recibe un solo aviso del cobro.
      expect(await noticesToClient()).toBe(noticesBefore + 1);
      // Confirmar el cobro no cambia el estado del pedido.
      expect(await statusOf(orderId)).toBe(OrderStatus.VISITA_REALIZADA);
    });

    it('una visita sin costo no pide confirmacion de cobro', async () => {
      const { orderId } = await agreedOrder({
        requiresVisit: true,
        visitCost: '0',
      });
      await registerAdvance(orderId);
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      await post(
        worker,
        `/orders/${orderId}/visit/payment-confirmation`,
      ).expect(409);
    });
  });

  // ---------------------------------------------------------------------
  describe('RF-26: presupuesto adicional', () => {
    const body = {
      amount: '50.00',
      reason: 'Tuberia danada',
      materials: '2 m de tubo',
    };

    it('detiene el trabajo; el cliente acepta y el monto final suma el adicional', async () => {
      const orderId = await executingOrder();
      for (const bad of [
        { ...body, amount: '0' },
        { ...body, amount: '-5' },
        { ...body, amount: 'abc' },
        { ...body, amount: '10.123' },
        { ...body, materials: '' },
        { ...body, reason: '' },
      ]) {
        await post(worker, `/orders/${orderId}/additional-budgets`, bad).expect(
          400,
        );
      }
      await post(client, `/orders/${orderId}/additional-budgets`, body).expect(
        403,
      );
      await post(worker2, `/orders/${orderId}/additional-budgets`, body).expect(
        404,
      );

      const created = await post(
        worker,
        `/orders/${orderId}/additional-budgets`,
        body,
      ).expect(201);
      expect(created.body.status).toBe(
        OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
      );
      const budgetId = created.body.budget.id as string;
      // Detenido: el trabajador no puede terminar ni crear otro.
      await post(worker, `/orders/${orderId}/finish`).expect(409);
      await post(worker, `/orders/${orderId}/additional-budgets`, body).expect(
        409,
      );
      // Todavia no cambia el monto acordado.
      expect(await queries.getAgreedAmount(orderId)).toEqual({
        baseAmount: '120.50',
        acceptedAdditional: '0.00',
        totalAmount: '120.50',
      });

      // Permisos: solo el cliente dueno.
      await post(
        worker,
        `/orders/${orderId}/additional-budgets/${budgetId}/accept`,
      ).expect(404);
      await post(
        client2,
        `/orders/${orderId}/additional-budgets/${budgetId}/accept`,
      ).expect(404);
      // Doble clic concurrente: solo uno gana.
      const results = await Promise.all([
        post(
          client,
          `/orders/${orderId}/additional-budgets/${budgetId}/accept`,
        ),
        post(
          client,
          `/orders/${orderId}/additional-budgets/${budgetId}/accept`,
        ),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_EJECUCION);
      expect(await queries.getAgreedAmount(orderId)).toEqual({
        baseAmount: '120.50',
        acceptedAdditional: '50.00',
        totalAmount: '170.50',
      });
      // El trabajador puede continuar y terminar.
      await post(worker, `/orders/${orderId}/finish`).expect(200);
    });

    it('el rechazo NO esta implementado (decision pendiente del docente)', async () => {
      const orderId = await executingOrder();
      const created = await post(
        worker,
        `/orders/${orderId}/additional-budgets`,
        body,
      ).expect(201);
      const budgetId = created.body.budget.id as string;
      // RF-27: solo el rechazo del cliente cierra el pedido.
      expect(budgetId).toBeDefined();
      await expect(
        prisma.$transaction((tx) =>
          orders.transition(tx, {
            orderId,
            to: OrderStatus.CERRADO,
            actor: { type: 'SISTEMA', process: 'PRUEBA' },
          }),
        ),
      ).rejects.toThrow(/falta el rechazo del presupuesto adicional/);
      expect(await statusOf(orderId)).toBe(
        OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
      );
    });

    it('un fallo del hook transaccional revierte todo (estado y presupuesto)', async () => {
      const orderId = await executingOrder();
      failHookFor = 'ADICIONAL_PROPUESTO';
      await post(worker, `/orders/${orderId}/additional-budgets`, body).expect(
        500,
      );
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_EJECUCION);
      expect(await prisma.additionalBudget.count({ where: { orderId } })).toBe(
        0,
      );
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId },
      });
      expect(
        history.some(
          (h) => h.toStatus === OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
        ),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  describe('RF-28: terminado y conformidad', () => {
    it('termina con plazo exacto de 7 dias y el cliente confirma la conformidad', async () => {
      const orderId = await executingOrder();
      await post(client, `/orders/${orderId}/finish`).expect(403);
      await post(worker2, `/orders/${orderId}/finish`).expect(404);
      const res = await post(worker, `/orders/${orderId}/finish`).expect(200);
      expect(res.body.status).toBe(OrderStatus.TERMINADO);
      const { finishedAt, conformityDeadline } = res.body.execution as {
        finishedAt: string;
        conformityDeadline: string;
      };
      expect(
        new Date(conformityDeadline).getTime() - new Date(finishedAt).getTime(),
      ).toBe(7 * DAY);
      expect(seen.some((e) => e.type === 'TRABAJO_TERMINADO')).toBe(true);
      // Terminar dos veces: 409.
      await post(worker, `/orders/${orderId}/finish`).expect(409);

      await post(worker, `/orders/${orderId}/confirm-conformity`).expect(404);
      await post(client2, `/orders/${orderId}/confirm-conformity`).expect(404);
      await post(client, `/orders/${orderId}/confirm-conformity`).expect(200);
      expect(await statusOf(orderId)).toBe(OrderStatus.CERRADO);
      await post(client, `/orders/${orderId}/confirm-conformity`).expect(409);
      // Historial unico: sin duplicados.
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId, toStatus: OrderStatus.CERRADO },
      });
      expect(history).toHaveLength(1);
    });

    it('GET workflow: el cliente y el trabajador ven el flujo; un tercero, 404', async () => {
      const orderId = await finishedOrder();
      const asClient = await get(client, `/orders/${orderId}/workflow`).expect(
        200,
      );
      expect(asClient.body.status).toBe(OrderStatus.TERMINADO);
      expect(asClient.body.execution.conformityDeadline).toBeTruthy();
      await get(worker, `/orders/${orderId}/workflow`).expect(200);
      await get(client2, `/orders/${orderId}/workflow`).expect(404);
      await get(worker2, `/orders/${orderId}/workflow`).expect(404);
      expect(await queries.hasWorkFinished(orderId)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  describe('RF-28: cierre automatico por plazo vencido', () => {
    it('cierra solo los TERMINADO con plazo cumplido, una vez, como proceso del sistema', async () => {
      const due = await finishedOrder();
      const notDue = await finishedOrder();
      await expireDeadline(due);
      expect(await closure.closeDue()).toBe(1);
      expect(await statusOf(due)).toBe(OrderStatus.CERRADO);
      expect(await statusOf(notDue)).toBe(OrderStatus.TERMINADO);
      const row = await prisma.orderStatusHistory.findFirstOrThrow({
        where: { orderId: due, toStatus: OrderStatus.CERRADO },
      });
      expect(row.actorType).toBe('SISTEMA');
      expect(row.systemProcess).toBe('CIERRE_CONFORMIDAD');
      // Idempotente.
      expect(await closure.closeDue()).toBe(0);
      expect(await closure.closeOne(due)).toBe(false);
      // Un pedido dentro de plazo no se cierra ni con closeOne.
      expect(await closure.closeOne(notDue)).toBe(false);
    });

    it('no toca un pedido reclamado', async () => {
      const orderId = await finishedOrder();
      await claim(client, orderId).expect(201);
      await expireDeadline(orderId);
      expect(await closure.closeOne(orderId)).toBe(false);
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_RECLAMO);
    });
  });

  // ---------------------------------------------------------------------
  describe('RF-37 y RF-38: reclamo y decision', () => {
    it('presenta el reclamo sin fotos (opcionales) y el pedido pasa a EN_RECLAMO', async () => {
      const orderId = await finishedOrder();
      await claim(client, orderId, 0, null).expect(400); // descripcion obligatoria
      await claim(client2, orderId).expect(404);
      await claim(worker, orderId).expect(404);
      const res = await claim(client, orderId).expect(201);
      expect(res.body.status).toBe('ABIERTO');
      expect(res.body.images).toEqual([]);
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_RECLAMO);
      // Segundo reclamo: 409; el cliente ya no puede confirmar conformidad.
      await claim(client, orderId).expect(409);
      await post(client, `/orders/${orderId}/confirm-conformity`).expect(409);
      expect(await prisma.claim.count({ where: { orderId } })).toBe(1);
      expect(seen.some((e) => e.type === 'RECLAMO_PRESENTADO')).toBe(true);
    });

    it('guarda fotos como evidencia con permisos de descarga', async () => {
      const orderId = await finishedOrder();
      const res = await claim(client, orderId, 2).expect(201);
      expect(res.body.images).toHaveLength(2);
      expect(JSON.stringify(res.body)).not.toMatch(/storage|key/i);
      const claimId = res.body.id as string;
      const imageId = res.body.images[0].id as string;
      const url = `/claims/${claimId}/images/${imageId}`;
      const own = await get(client, url).expect(200);
      expect(own.headers['content-type']).toMatch(/image\/webp/);
      await get(admin, url).expect(200);
      await get(client2, url).expect(404);
      await get(worker, url).expect(404);
    });

    it('rechaza el reclamo despues del plazo y el pedido sigue TERMINADO', async () => {
      const orderId = await finishedOrder();
      await expireDeadline(orderId);
      await claim(client, orderId).expect(409);
      expect(await statusOf(orderId)).toBe(OrderStatus.TERMINADO);
      expect(await prisma.claim.count({ where: { orderId } })).toBe(0);
    });

    it('un pedido no terminado no admite reclamo', async () => {
      const orderId = await executingOrder();
      await claim(client, orderId).expect(409);
    });

    it('el administrador revisa y registra la decision; ambas partes la ven', async () => {
      const orderId = await finishedOrder();
      const created = await claim(client, orderId).expect(201);
      const claimId = created.body.id as string;

      await get(client, '/admin/claims').expect(403);
      const list = await get(admin, '/admin/claims?status=ABIERTO').expect(200);
      expect(
        (list.body.data as { id: string }[]).some((c) => c.id === claimId),
      ).toBe(true);
      await post(client, `/admin/claims/${claimId}/decision`, {
        decision: 'x',
        justification: 'y',
      }).expect(403);
      await post(admin, `/admin/claims/${claimId}/decision`, {
        decision: '',
        justification: 'y',
      }).expect(400);

      await post(admin, `/admin/claims/${claimId}/review`).expect(200);
      await post(admin, `/admin/claims/${claimId}/review`).expect(409);
      const results = await Promise.all([
        post(admin, `/admin/claims/${claimId}/decision`, {
          decision: 'Se repara sin costo',
          justification: 'Evidencia suficiente',
        }),
        post(admin, `/admin/claims/${claimId}/decision`, {
          decision: 'Otra',
          justification: 'Otra',
        }),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect(await statusOf(orderId)).toBe(OrderStatus.CERRADO);
      const row = await prisma.claim.findUniqueOrThrow({
        where: { id: claimId },
      });
      expect(row.status).toBe('RESUELTO');
      expect(row.decidedById).toBe(admin.id);

      const asClient = await get(client, `/orders/${orderId}/claim`).expect(
        200,
      );
      expect(asClient.body.decision).toBeTruthy();
      expect(asClient.body.description).toBeTruthy();
      const asWorker = await get(worker, `/orders/${orderId}/claim`).expect(
        200,
      );
      expect(asWorker.body.decision).toBe(row.decision);
      expect(asWorker.body.description).toBeUndefined();
      await get(worker2, `/orders/${orderId}/claim`).expect(404);
      expect(seen.some((e) => e.type === 'RECLAMO_RESUELTO')).toBe(true);
      // Resuelto: no se decide de nuevo.
      await post(admin, `/admin/claims/${claimId}/decision`, {
        decision: 'z',
        justification: 'z',
      }).expect(409);
    });

    it('reclamo y cierre por plazo en carrera: gana exactamente uno', async () => {
      for (let i = 0; i < 4; i += 1) {
        const orderId = await finishedOrder();
        await prisma.$executeRaw`UPDATE "order_executions" SET "conformity_deadline" = clock_timestamp() + interval '150 milliseconds' WHERE "order_id" = ${orderId}::uuid`;
        await Promise.all([
          claim(client, orderId).then((r) => r.status),
          new Promise((resolve) => setTimeout(resolve, 150)).then(() =>
            closure.closeOne(orderId),
          ),
        ]);
        const status = await statusOf(orderId);
        const claims = await prisma.claim.count({ where: { orderId } });
        // Invariante: con reclamo, EN_RECLAMO; sin reclamo, CERRADO. Nunca ambos.
        expect(
          (status === OrderStatus.EN_RECLAMO && claims === 1) ||
            (status === OrderStatus.CERRADO && claims === 0),
        ).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------
  describe('RF-34: cancelar trabajo', () => {
    it('registra quien, cuando y por que; libera la franja de la agenda', async () => {
      const startAt = nextMondayAt(16, 20);
      const { orderId } = await agreedOrder({ startAt });
      await post(client, `/orders/${orderId}/cancel-work`, {}).expect(400); // motivo obligatorio
      await post(worker, `/orders/${orderId}/cancel-work`, {
        reason: 'x',
      }).expect(404);
      await post(client2, `/orders/${orderId}/cancel-work`, {
        reason: 'x',
      }).expect(404);
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'Cambiaron mis planes',
      }).expect(200);
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(order.status).toBe(OrderStatus.CANCELADO);
      expect(order.cancelledAt).not.toBeNull();
      const row = await prisma.orderStatusHistory.findFirstOrThrow({
        where: { orderId, toStatus: OrderStatus.CANCELADO },
      });
      expect(row.changedById).toBe(client.id);
      expect(row.reason).toBe('Cambiaron mis planes');
      // Repetir: 409 y sin duplicar.
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'otra',
      }).expect(409);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId, toStatus: OrderStatus.CANCELADO },
        }),
      ).toBe(1);
      // No se limpia (ya hubo acuerdo): conserva su descripcion y direccion.
      expect(order.anonymizedAt).toBeNull();
      // La franja queda libre: el mismo trabajador acepta otro pedido a la misma hora.
      await agreedOrder({ startAt });
    });

    it('no se puede cancelar un trabajo terminado (se usa el reclamo)', async () => {
      const orderId = await finishedOrder();
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'x',
      }).expect(409);
    });

    it('permite cancelar mientras espera la respuesta a un adicional', async () => {
      const orderId = await executingOrder();
      await post(worker, `/orders/${orderId}/additional-budgets`, {
        amount: '10',
        reason: 'r',
        materials: 'm',
      }).expect(201);
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'No acepto el costo',
      }).expect(200);
      expect(await statusOf(orderId)).toBe(OrderStatus.CANCELADO);
    });
  });

  // ---------------------------------------------------------------------
  describe('RF-36: inasistencia (solo registro)', () => {
    it('registra el hecho una vez, sin cambiar el estado ni penalizar', async () => {
      const { orderId } = await agreedOrder();
      await post(worker, `/orders/${orderId}/no-show`, {}).expect(404);
      await post(client2, `/orders/${orderId}/no-show`, {}).expect(404);
      const first = await post(client, `/orders/${orderId}/no-show`, {
        description: 'No llego a la cita',
      }).expect(200);
      expect(first.body.created).toBe(true);
      const again = await post(client, `/orders/${orderId}/no-show`, {}).expect(
        200,
      );
      expect(again.body.created).toBe(false);
      expect(again.body.report.id).toBe(first.body.report.id);
      expect(await prisma.noShowReport.count({ where: { orderId } })).toBe(1);
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
      expect(
        seen.filter((e) => e.type === 'INASISTENCIA_REPORTADA'),
      ).toHaveLength(1);
    });

    it('no se reporta con el trabajo ya iniciado', async () => {
      const orderId = await executingOrder();
      await post(client, `/orders/${orderId}/no-show`, {}).expect(409);
    });
  });

  // ---------------------------------------------------------------------
  describe('invariantes de transition() frente a otros modulos', () => {
    const system = { type: 'SISTEMA', process: 'PRUEBA_OTRO_MODULO' } as const;
    const attempt = (orderId: string, to: OrderStatus) =>
      prisma.$transaction((tx) =>
        orders.transition(tx, {
          orderId,
          to,
          actor: system,
        } as Parameters<OrdersService['transition']>[1]),
      );

    it('no permite TERMINADO sin registro de ejecucion terminada', async () => {
      const orderId = await executingOrder();
      await expect(attempt(orderId, OrderStatus.TERMINADO)).rejects.toThrow(
        /ejecucion/,
      );
      await prisma.orderExecution.delete({ where: { orderId } });
      await expect(attempt(orderId, OrderStatus.TERMINADO)).rejects.toThrow(
        /ejecucion/,
      );
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_EJECUCION);
    });

    it('no permite saltarse la visita requerida por la oferta', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: true });
      await registerAdvance(orderId);
      await expect(attempt(orderId, OrderStatus.EN_EJECUCION)).rejects.toThrow(
        /requiere visita/,
      );
      await expect(
        attempt(orderId, OrderStatus.VISITA_REALIZADA),
      ).rejects.toThrow(/visita/);
      expect(await statusOf(orderId)).toBe(OrderStatus.ANTICIPO_REGISTRADO);
      // El camino correcto sigue funcionando.
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      await post(worker, `/orders/${orderId}/start`).expect(200);
    });

    it('una oferta por fotos no admite VISITA_REALIZADA por otra via', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: false });
      await registerAdvance(orderId);
      await expect(
        attempt(orderId, OrderStatus.VISITA_REALIZADA),
      ).rejects.toThrow();
    });

    it('el adicional exige un presupuesto pendiente y no se cierra con uno pendiente', async () => {
      const orderId = await executingOrder();
      await expect(
        attempt(orderId, OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE),
      ).rejects.toThrow(/exactamente un presupuesto/);
      await post(worker, `/orders/${orderId}/additional-budgets`, {
        amount: '10',
        reason: 'r',
        materials: 'm',
      }).expect(201);
      await expect(attempt(orderId, OrderStatus.EN_EJECUCION)).rejects.toThrow(
        /pendiente/,
      );
    });

    it('no permite EN_RECLAMO sin reclamo ni cerrar un reclamo sin decision', async () => {
      const orderId = await finishedOrder();
      await expect(attempt(orderId, OrderStatus.EN_RECLAMO)).rejects.toThrow(
        /reclamo abierto/,
      );
      await claim(client, orderId).expect(201);
      await expect(attempt(orderId, OrderStatus.CERRADO)).rejects.toThrow(
        /decision/,
      );
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_RECLAMO);
    });

    it('no permite cerrar un TERMINADO sin registro de fin', async () => {
      const orderId = await finishedOrder();
      await prisma.$executeRaw`UPDATE "order_executions" SET "finished_at" = NULL, "conformity_deadline" = NULL WHERE "order_id" = ${orderId}::uuid`;
      await expect(attempt(orderId, OrderStatus.CERRADO)).rejects.toThrow(
        /ejecucion/,
      );
    });

    it('el anticipo avanza el pedido con la confirmacion del trabajador por la API', async () => {
      const { orderId } = await agreedOrder();
      await registerAdvance(orderId);
      expect(await statusOf(orderId)).toBe(OrderStatus.ANTICIPO_REGISTRADO);
    });
  });

  // ---------------------------------------------------------------------
  describe('adicional pendiente al cancelar (SIN_EFECTO_POR_CANCELACION)', () => {
    it('queda sin efecto, ya no puede aceptarse y no suma al monto acordado', async () => {
      const orderId = await executingOrder();
      const created = await post(
        worker,
        `/orders/${orderId}/additional-budgets`,
        { amount: '40.00', reason: 'Pieza extra', materials: 'valvula' },
      ).expect(201);
      const budgetId = created.body.budget.id as string;
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'No acepto el costo',
      }).expect(200);

      const row = await prisma.additionalBudget.findUniqueOrThrow({
        where: { id: budgetId },
      });
      expect(row.status).toBe('SIN_EFECTO_POR_CANCELACION');
      expect(row.respondedAt).toBeNull();
      await post(
        client,
        `/orders/${orderId}/additional-budgets/${budgetId}/accept`,
      ).expect(409);
      // El respaldo de la BD: un estado final no cambia.
      await expect(
        prisma.$executeRaw`UPDATE "additional_budgets" SET "status" = 'ACEPTADO', "responded_at" = now() WHERE "id" = ${budgetId}::uuid`,
      ).rejects.toThrow();
      expect((await queries.getAgreedAmount(orderId))?.acceptedAdditional).toBe(
        '0.00',
      );
      const view = await get(client, `/orders/${orderId}/workflow`).expect(200);
      expect(view.body.additionalBudgets[0].status).toBe(
        'SIN_EFECTO_POR_CANCELACION',
      );
    });
  });

  // ---------------------------------------------------------------------
  describe('pedido cancelado conserva historial y evidencias', () => {
    it('mantiene fotos, direccion, descripcion e historial, tambien tras la recuperacion de cerrados', async () => {
      const { orderId } = await agreedOrder();
      await registerAdvance(orderId);
      const before = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      await post(client, `/orders/${orderId}/cancel-work`, {
        reason: 'Cambio de planes',
      }).expect(200);

      await app.get(OrderRetentionService).recoverClosedOrders();

      const after = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(after.status).toBe(OrderStatus.CANCELADO);
      expect(after.anonymizedAt).toBeNull();
      expect(after.description).toBe(before.description);
      expect(after.assignedWorkerId).toBe(worker.id);
      expect(await prisma.orderImage.count({ where: { orderId } })).toBe(1);
      expect(await prisma.orderAddress.count({ where: { orderId } })).toBe(1);
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        OrderStatus.PUBLICADO,
        OrderStatus.EN_NEGOCIACION,
        OrderStatus.ACORDADO,
        OrderStatus.ANTICIPO_REGISTRADO,
        OrderStatus.CANCELADO,
      ]);
    });
  });

  // ---------------------------------------------------------------------
  describe('concurrencia de visita y finalizacion', () => {
    it('doble operacion simultanea de visita: una gana, la otra 409, un solo registro', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: true });
      await registerAdvance(orderId);
      const results = await Promise.all([
        post(worker, `/orders/${orderId}/visit`),
        post(worker, `/orders/${orderId}/visit`),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect(await prisma.orderVisit.count({ where: { orderId } })).toBe(1);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId, toStatus: OrderStatus.VISITA_REALIZADA },
        }),
      ).toBe(1);
    });

    it('doble finalizacion simultanea: una gana, la otra 409, un solo plazo e historial', async () => {
      const orderId = await executingOrder();
      const results = await Promise.all([
        post(worker, `/orders/${orderId}/finish`),
        post(worker, `/orders/${orderId}/finish`),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId, toStatus: OrderStatus.TERMINADO },
        }),
      ).toBe(1);
      const winner = results.find((r) => r.status === 200)!;
      const execution = await prisma.orderExecution.findUniqueOrThrow({
        where: { orderId },
      });
      expect(execution.conformityDeadline?.toISOString()).toBe(
        winner.body.execution.conformityDeadline,
      );
    });

    it('finalizar y cancelar a la vez: gana uno solo y el estado es coherente', async () => {
      const orderId = await executingOrder();
      const results = await Promise.all([
        post(worker, `/orders/${orderId}/finish`),
        post(client, `/orders/${orderId}/cancel-work`, { reason: 'carrera' }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const status = await statusOf(orderId);
      expect([OrderStatus.TERMINADO, OrderStatus.CANCELADO]).toContain(status);
      expect(await queries.hasWorkFinished(orderId)).toBe(
        status === OrderStatus.TERMINADO,
      );
    });
  });

  // ---------------------------------------------------------------------
  describe('ejecuciones simultaneas del job de cierre', () => {
    it('dos pasadas concurrentes cierran cada pedido exactamente una vez', async () => {
      const due: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const orderId = await finishedOrder();
        await expireDeadline(orderId);
        due.push(orderId);
      }
      // Otras pruebas pueden dejar pedidos vencidos sin cerrar: se cuentan todos.
      const dueBefore = await prisma.orderExecution.count({
        where: {
          conformityDeadline: { lte: new Date() },
          order: { status: OrderStatus.TERMINADO },
        },
      });
      expect(dueBefore).toBeGreaterThanOrEqual(3);
      const [a, b] = await Promise.all([
        closure.closeDue(),
        closure.closeDue(),
      ]);
      expect(a + b).toBe(dueBefore);
      for (const orderId of due) {
        expect(await statusOf(orderId)).toBe(OrderStatus.CERRADO);
        expect(
          await prisma.orderStatusHistory.count({
            where: { orderId, toStatus: OrderStatus.CERRADO },
          }),
        ).toBe(1);
      }
    });

    it('closeOne simultaneo sobre el mismo pedido: solo uno lo cierra', async () => {
      const orderId = await finishedOrder();
      await expireDeadline(orderId);
      const results = await Promise.all([
        closure.closeOne(orderId),
        closure.closeOne(orderId),
        closure.closeOne(orderId),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId, toStatus: OrderStatus.CERRADO },
        }),
      ).toBe(1);
    });
  });

  // ---------------------------------------------------------------------
  describe('autenticacion y permisos', () => {
    const id = randomUUID();
    const endpoints: [string, string][] = [
      ['get', `/api/orders/${id}/workflow`],
      ['post', `/api/orders/${id}/visit`],
      ['post', `/api/orders/${id}/visit/payment-confirmation`],
      ['post', `/api/orders/${id}/start`],
      ['post', `/api/orders/${id}/additional-budgets`],
      ['post', `/api/orders/${id}/additional-budgets/${id}/accept`],
      ['post', `/api/orders/${id}/finish`],
      ['post', `/api/orders/${id}/confirm-conformity`],
      ['post', `/api/orders/${id}/cancel-work`],
      ['post', `/api/orders/${id}/no-show`],
      ['post', `/api/orders/${id}/claims`],
      ['get', `/api/orders/${id}/claim`],
      ['get', `/api/claims/${id}/images/${id}`],
      ['get', `/api/admin/claims`],
      ['get', `/api/admin/claims/${id}`],
      ['post', `/api/admin/claims/${id}/review`],
      ['post', `/api/admin/claims/${id}/decision`],
    ];

    it.each(endpoints)('%s %s sin token responde 401', async (method, url) => {
      const req =
        method === 'get' ? http().get(url) : http().post(url).send({});
      await req.expect(401);
    });

    it('un token invalido responde 401', async () => {
      await http()
        .post(`/api/orders/${id}/finish`)
        .set('Authorization', 'Bearer no-es-un-token')
        .expect(401);
    });

    it('un trabajador sin aprobar no puede actuar como trabajador', async () => {
      const users = app.get(UsersService);
      const profiles = app.get(WorkerProfileService);
      const pending = await users.create({
        firstName: 'pendiente',
        lastName: 'E2E',
        email: `pendiente-${RUN_ID}@workflow-e2e.test`,
        passwordHash: 'hash',
        phone: '71000009',
      });
      await profiles.create(pending.id, {
        yearsOfExperience: 1,
        zoneId: zone.id,
        categoryIds: [category.id],
        schedules: [
          { dayOfWeek: 'LUNES', startTime: '08:00', endTime: '18:00' },
        ],
      });
      await profiles.submit(pending.id);
      const orderId = await executingOrder();
      for (const url of ['visit', 'start', 'finish']) {
        await post(pending, `/orders/${orderId}/${url}`).expect(403);
      }
      await post(pending, `/orders/${orderId}/additional-budgets`, {
        amount: '10',
        reason: 'r',
        materials: 'm',
      }).expect(403);
    });

    it('solo el administrador accede a la administracion de reclamos', async () => {
      for (const user of [client, worker]) {
        await get(user, '/admin/claims').expect(403);
        await get(user, `/admin/claims/${id}`).expect(403);
        await post(user, `/admin/claims/${id}/review`).expect(403);
        await post(user, `/admin/claims/${id}/decision`, {
          decision: 'x',
          justification: 'y',
        }).expect(403);
      }
      await get(admin, `/admin/claims/${id}`).expect(404);
    });

    it('el administrador no actua como trabajador ni como cliente del pedido', async () => {
      const orderId = await executingOrder();
      await post(admin, `/orders/${orderId}/finish`).expect(403);
      await post(admin, `/orders/${orderId}/cancel-work`, {
        reason: 'x',
      }).expect(404);
      await get(admin, `/orders/${orderId}/workflow`).expect(404);
    });
  });

  // ---------------------------------------------------------------------
  describe('fotos del reclamo: limites y archivos pesados', () => {
    const claimFiles = async () =>
      readdir(path.join(storageDir, 'claim-images')).catch(
        () => [] as string[],
      );
    const withSettings = async (
      values: { minImages?: number; maxImages?: number },
      work: () => Promise<void>,
    ) => {
      const settings = app.get(ClaimsConfig) as unknown as {
        minImages: number;
        maxImages: number;
      };
      const previous = {
        minImages: settings.minImages,
        maxImages: settings.maxImages,
      };
      Object.assign(settings, values);
      try {
        await work();
      } finally {
        Object.assign(settings, previous);
      }
    };

    it('una foto mas pesada que el maximo responde 413 y no crea nada', async () => {
      const orderId = await finishedOrder();
      const heavy = Buffer.alloc(11 * 1024 * 1024, 1);
      const res = await http()
        .post(`/api/orders/${orderId}/claims`)
        .set('Authorization', auth(client))
        .field('description', 'Foto enorme')
        .attach('images', heavy, { filename: 'enorme.jpg' });
      expect(res.status).toBe(413);
      expect(res.body.message).toMatch(/MB/);
      expect(await prisma.claim.count({ where: { orderId } })).toBe(0);
      expect(await statusOf(orderId)).toBe(OrderStatus.TERMINADO);
    });

    it('mas fotos que el maximo configurado responde 400', async () => {
      const orderId = await finishedOrder();
      await withSettings({ maxImages: 2 }, async () => {
        await claim(client, orderId, 3).expect(400);
      });
      expect(await prisma.claim.count({ where: { orderId } })).toBe(0);
      // Por encima del tope tecnico tambien se rechaza (multer o el servicio).
      await claim(client, orderId, 22).expect(400);
      expect(await prisma.claim.count({ where: { orderId } })).toBe(0);
    });

    it('el minimo configurable se exige solo cuando esta configurado', async () => {
      const orderId = await finishedOrder();
      await withSettings({ minImages: 1 }, async () => {
        await claim(client, orderId, 0).expect(400);
      });
      expect(await prisma.claim.count({ where: { orderId } })).toBe(0);
      await claim(client, orderId, 0).expect(201);
    });

    it('un archivo que no es imagen se rechaza y no deja archivos guardados', async () => {
      const orderId = await finishedOrder();
      const before = (await claimFiles()).length;
      await http()
        .post(`/api/orders/${orderId}/claims`)
        .set('Authorization', auth(client))
        .field('description', 'No es imagen')
        .attach('images', Buffer.from('esto no es una imagen'), {
          filename: 'falso.jpg',
        })
        .expect(400);
      expect(await prisma.claim.count({ where: { orderId } })).toBe(0);
      expect((await claimFiles()).length).toBe(before);
    });

    it('si el reclamo se rechaza (plazo vencido) las fotos guardadas se descartan', async () => {
      const orderId = await finishedOrder();
      await expireDeadline(orderId);
      const before = (await claimFiles()).length;
      await claim(client, orderId, 2).expect(409);
      expect((await claimFiles()).length).toBe(before);
    });

    it('las fotos de un reclamo confirmado permanecen y se pueden leer tras cerrar el pedido', async () => {
      const orderId = await finishedOrder();
      const created = await claim(client, orderId, 2).expect(201);
      const claimId = created.body.id as string;
      await post(admin, `/admin/claims/${claimId}/decision`, {
        decision: 'Resuelto',
        justification: 'Con evidencia',
      }).expect(200);
      await app.get(OrderRetentionService).recoverClosedOrders();
      const imageId = created.body.images[1].id as string;
      await get(
        admin,
        `/claims/${claimId}/images/${imageId}?variant=thumb`,
      ).expect(200);
      expect(await prisma.claimImage.count({ where: { claimId } })).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  describe('integridad del flujo de reclamos', () => {
    it('dos reclamos simultaneos: uno solo se crea, con historial unico', async () => {
      const orderId = await finishedOrder();
      const results = await Promise.all([
        claim(client, orderId, 1),
        claim(client, orderId, 1),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect(await prisma.claim.count({ where: { orderId } })).toBe(1);
      const row = await prisma.claim.findUniqueOrThrow({
        where: { orderId },
        include: { images: true },
      });
      expect(row.clientId).toBe(client.id);
      expect(row.images.map((i) => i.position)).toEqual([1]);
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId, toStatus: OrderStatus.EN_RECLAMO },
      });
      expect(history).toHaveLength(1);
      expect(history[0].changedById).toBe(client.id);
    });

    it('reclamo y conformidad simultaneos: gana exactamente uno', async () => {
      const orderId = await finishedOrder();
      const [claimRes, confirmRes] = await Promise.all([
        claim(client, orderId),
        post(client, `/orders/${orderId}/confirm-conformity`),
      ]);
      const claimWon = claimRes.status === 201;
      const confirmWon = confirmRes.status === 200;
      expect(Number(claimWon) + Number(confirmWon)).toBe(1);
      expect(await statusOf(orderId)).toBe(
        claimWon ? OrderStatus.EN_RECLAMO : OrderStatus.CERRADO,
      );
      expect(await prisma.claim.count({ where: { orderId } })).toBe(
        claimWon ? 1 : 0,
      );
    });

    it('el trabajador no ve el reclamo ni la decision mientras sigue abierto', async () => {
      const orderId = await finishedOrder();
      const created = await claim(client, orderId).expect(201);
      const asWorker = await get(worker, `/orders/${orderId}/claim`).expect(
        200,
      );
      expect(asWorker.body.status).toBe('ABIERTO');
      expect(asWorker.body.description).toBeUndefined();
      expect(asWorker.body.decision).toBeNull();
      await post(admin, `/admin/claims/${created.body.id}/review`).expect(200);
      const review = await get(worker, `/orders/${orderId}/claim`).expect(200);
      expect(review.body.decision).toBeNull();
    });

    it('decision y cierre son atomicos: un fallo del hook revierte ambos', async () => {
      const orderId = await finishedOrder();
      const created = await claim(client, orderId).expect(201);
      failHookFor = 'RECLAMO_RESUELTO';
      await post(admin, `/admin/claims/${created.body.id}/decision`, {
        decision: 'x',
        justification: 'y',
      }).expect(500);
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_RECLAMO);
      const row = await prisma.claim.findUniqueOrThrow({ where: { orderId } });
      expect(row.status).toBe('ABIERTO');
      expect(row.decision).toBeNull();
    });

    it('un reclamo resuelto no se reabre ni se vuelve a presentar', async () => {
      const orderId = await finishedOrder();
      const created = await claim(client, orderId).expect(201);
      await post(admin, `/admin/claims/${created.body.id}/decision`, {
        decision: 'x',
        justification: 'y',
      }).expect(200);
      await claim(client, orderId).expect(409);
      await post(admin, `/admin/claims/${created.body.id}/review`).expect(409);
      expect(await statusOf(orderId)).toBe(OrderStatus.CERRADO);
    });
  });

  // ---------------------------------------------------------------------
  describe('flujo completo con visita', () => {
    it('visita, adicional desde la visita, aceptacion, terminado y conformidad', async () => {
      const { orderId } = await agreedOrder({ requiresVisit: true });
      await registerAdvance(orderId);
      await post(worker, `/orders/${orderId}/visit`).expect(201);
      const created = await post(
        worker,
        `/orders/${orderId}/additional-budgets`,
        {
          amount: '25.50',
          reason: 'Mas complejo de lo previsto',
          materials: 'sellador',
        },
      ).expect(201);
      await post(
        client,
        `/orders/${orderId}/additional-budgets/${created.body.budget.id as string}/accept`,
      ).expect(200);
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_EJECUCION);
      const execution = await prisma.orderExecution.findUniqueOrThrow({
        where: { orderId },
      });
      expect(execution.startedAt).not.toBeNull();
      await post(worker, `/orders/${orderId}/finish`).expect(200);
      await post(client, `/orders/${orderId}/confirm-conformity`).expect(200);
      expect((await queries.getAgreedAmount(orderId))?.totalAmount).toBe(
        '146.00',
      );
    });
  });
});
