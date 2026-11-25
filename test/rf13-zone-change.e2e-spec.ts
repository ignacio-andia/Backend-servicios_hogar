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
import { WorkerActiveWorkRegistry } from '../src/modules/worker-profile/active-work.registry.js';
import { WorkerProfileService } from '../src/modules/worker-profile/worker-profile.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deleteOrderData } from './utils/orders-cleanup.js';
import { deleteWorkerData } from './utils/worker-profile-cleanup.js';

// RF-13: que puede hacer un trabajador con una solicitud de cambio de zona
// pendiente. Nuevas oportunidades: no. Negociaciones ya abiertas y trabajos
// acordados: si. Corre sobre la base de .env y borra solo lo que crea.

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@rf13-e2e.test';
const DAY = 24 * 60 * 60 * 1000;
const PENDING_MESSAGE =
  'Tiene una solicitud de cambio de zona pendiente: no puede ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire.';

describe('RF-13: solicitud de cambio de zona pendiente (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let users: UsersService;
  let profiles: WorkerProfileService;
  let storageDir: string;
  let jpeg: Buffer;

  let admin: PublicUser;
  let client: PublicUser;
  let otherClient: PublicUser;
  let otherWorker: PublicUser;
  let category: CatalogItem;
  let zoneA: CatalogItem;
  let zoneB: CatalogItem;
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
      email: `${name}-${RUN_ID}${EMAIL_DOMAIN}`,
      passwordHash: 'hash',
      phone: '70000041',
    });
    created.push(user);
    return user;
  };
  const newWorker = async (name: string): Promise<Worker> => {
    const user = await newUser(name);
    const profile = await profiles.create(user.id, {
      yearsOfExperience: 3,
      zoneId: zoneA.id,
      categoryIds: [category.id],
      schedules: [{ dayOfWeek: 'LUNES', startTime: '08:00', endTime: '18:00' }],
    });
    await profiles.submit(user.id);
    await profiles.changeStatusByAdmin(admin.id, profile.id, {
      status: WorkerProfileStatus.APROBADO,
    });
    return { user: await users.findById(user.id), profileId: profile.id };
  };

  const newOrder = async (zone = zoneA, owner = client) => {
    const res = await http()
      .post('/api/orders')
      .set('Authorization', auth(owner))
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
  const offerBody = (requiresVisit = false) => ({
    amount: '120.50',
    requiresVisit,
    ...(requiresVisit ? { visitCost: '30.00' } : {}),
    materialsIncluded: false,
    // Cada oferta en un dia distinto: sin cruces de agenda (RF-30).
    proposedStartAt: new Date(Date.now() + (2 + slot++) * DAY).toISOString(),
    estimatedDurationMinutes: 30,
  });
  const sendOffer = (worker: Worker, orderId: string, requiresVisit = false) =>
    post(worker.user, `/offers/orders/${orderId}`, offerBody(requiresVisit));
  const openOffer = async (worker: Worker, requiresVisit = false) => {
    const orderId = await newOrder();
    const res = await sendOffer(worker, orderId, requiresVisit).expect(201);
    return { orderId, offerId: res.body.id as string };
  };
  const agreedOrder = async (worker: Worker, requiresVisit = false) => {
    const offer = await openOffer(worker, requiresVisit);
    await post(client, `/offers/${offer.offerId}/accept`).expect(200);
    return offer;
  };

  /**
   * Solicitud PENDIENTE insertada como dato de prueba: por HTTP no se puede
   * crear con trabajo activo u ofertas abiertas (RF-13, regla 7).
   */
  const insertPending = async (worker: Worker) =>
    (
      await prisma.zoneChangeRequest.create({
        data: {
          profileId: worker.profileId,
          fromZoneId: zoneA.id,
          toZoneId: zoneB.id,
          reason: 'Solicitud de prueba RF-13',
        },
      })
    ).id;

  const statusOf = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const declare = (
    user: PublicUser,
    orderId: string,
    concept: 'ANTICIPO' | 'SALDO',
    amount: string,
  ) =>
    post(user, `/orders/${orderId}/payments/${concept}/declarations`, {
      amount,
      method: 'EFECTIVO',
    });

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'rf13-e2e-'));
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
    otherClient = await newUser('other-client');
    category = await catalogs.create(CatalogKind.CATEGORY, admin.id, {
      name: `Plomeria RF13 ${RUN_ID}`,
    });
    zoneA = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Norte RF13 ${RUN_ID}`,
    });
    zoneB = await catalogs.create(CatalogKind.ZONE, admin.id, {
      name: `Sur RF13 ${RUN_ID}`,
    });
    jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#3366aa' },
    })
      .jpeg()
      .toBuffer();
    otherWorker = (await newWorker('other-worker')).user;
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

  const requestChange = (worker: Worker, toZone = zoneB) =>
    post(worker.user, '/worker-profile/me/zone-change-requests', {
      toZoneId: toZone.id,
      reason: 'Me mudé de barrio',
    });
  const pendingCount = (worker: Worker) =>
    prisma.zoneChangeRequest.count({
      where: { profileId: worker.profileId, status: 'PENDIENTE' },
    });
  const openOfferCount = (worker: Worker) =>
    prisma.offer.count({
      where: {
        workerId: worker.user.id,
        status: 'VIGENTE',
        expiresAt: { gt: new Date() },
      },
    });
  const decide = (requestId: string, body: object) =>
    http()
      .patch(`/api/worker-profile/admin/zone-change-requests/${requestId}`)
      .set('Authorization', auth(admin))
      .send(body);
  const expectBlocked = async (worker: Worker, active: string) => {
    const res = await requestChange(worker).expect(409);
    expect(res.body.message).toEqual([
      `No puede solicitar un cambio de zona mientras tenga trabajo activo (${active} activos).`,
    ]);
    expect(await pendingCount(worker)).toBe(0);
  };

  describe('regla 7: no se solicita con negociaciones o trabajos activos', () => {
    it('con una oferta vigente no puede solicitar el cambio', async () => {
      const worker = await newWorker('open-offer');
      await openOffer(worker);

      await expectBlocked(worker, '1 ofertas');
      const zone = await get(worker.user, '/worker-profile/me/zone').expect(
        200,
      );
      expect(zone.body).toMatchObject({
        canRequestChange: false,
        blockers: [{ code: 'TRABAJO_ACTIVO' }],
      });
    });

    it.each(['withdraw', 'reject'])(
      'con la oferta cerrada (%s) puede solicitarlo',
      async (action) => {
        const worker = await newWorker(`closed-${action}`);
        const { offerId } = await openOffer(worker);
        await post(
          action === 'withdraw' ? worker.user : client,
          `/offers/${offerId}/${action}`,
        ).expect(200);

        await requestChange(worker).expect(201);
      },
    );

    it('una oferta que perdio frente a otra (SIN_EFECTO) no bloquea', async () => {
      const loser = await newWorker('loser');
      const winner = await newWorker('winner');
      const { orderId, offerId } = await openOffer(winner);
      await sendOffer(loser, orderId).expect(201);
      await post(client, `/offers/${offerId}/accept`).expect(200);

      await requestChange(loser).expect(201);
    });

    it('con la oferta vencida (aun sin marcar) puede solicitarlo', async () => {
      const worker = await newWorker('expired-offer');
      const { offerId } = await openOffer(worker);
      await prisma.offer.update({
        where: { id: offerId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await requestChange(worker).expect(201);
    });

    it('al cancelarse el pedido su oferta deja de bloquear', async () => {
      const worker = await newWorker('cancelled-order');
      const { orderId } = await openOffer(worker);
      await post(client, `/orders/me/${orderId}/cancel`).expect(200);

      await requestChange(worker).expect(201);
    });

    it('con un trabajo activo sigue sin poder; cerrado, la oferta aceptada no bloquea', async () => {
      const worker = await newWorker('accepted-closed');
      const { orderId } = await agreedOrder(worker);
      await expectBlocked(worker, '1 pedidos');

      await declare(worker.user, orderId, 'ANTICIPO', '30.13').expect(201);
      await post(worker.user, `/orders/${orderId}/start`).expect(200);
      await post(worker.user, `/orders/${orderId}/finish`).expect(200);
      await expectBlocked(worker, '1 pedidos');
      await post(client, `/orders/${orderId}/confirm-conformity`).expect(200);
      expect(
        await prisma.offer.count({
          where: { orderId, status: 'ACEPTADA' },
        }),
      ).toBe(1);

      await requestChange(worker).expect(201);
      // Regla 6: con la solicitud pendiente aun registra el pago final.
      await declare(worker.user, orderId, 'SALDO', '90.00').expect(201);
      await declare(worker.user, orderId, 'SALDO', '90.00').expect(409);
    });
  });

  describe('reglas 1 y 2: sin oportunidades nuevas', () => {
    it('no oferta, no es candidato y no se le asigna un pedido sin negociacion', async () => {
      const worker = await newWorker('blocked-new');
      await requestChange(worker).expect(201);
      const orderId = await newOrder();

      const res = await sendOffer(worker, orderId).expect(409);
      expect(res.body.message).toBe(PENDING_MESSAGE);
      const candidates = await profiles.findApprovedWorkers({
        categoryId: category.id,
        zoneId: zoneA.id,
      });
      expect(candidates.map((c) => c.userId)).not.toContain(worker.user.id);

      // En negociacion por la oferta de otro: asignarle el pedido es nuevo.
      const other = await newWorker('blocked-new-other');
      await sendOffer(other, orderId).expect(201);
      await expect(
        prisma.$transaction((tx) =>
          app.get(OrdersService).transition(tx, {
            orderId,
            to: OrderStatus.ACORDADO,
            actor: {
              type: 'USUARIO',
              userId: client.id,
              role: RoleName.CLIENTE,
            },
            assignWorkerId: worker.user.id,
          }),
        ),
      ).rejects.toThrow(PENDING_MESSAGE);
      expect(await statusOf(orderId)).toBe(OrderStatus.EN_NEGOCIACION);
    });
  });

  describe('visibilidad de pedidos con la solicitud pendiente', () => {
    const availableIds = async (worker: Worker) => {
      const res = await get(worker.user, '/orders/available?limit=50').expect(
        200,
      );
      expect(res.body.meta.total).toBe(res.body.data.length);
      return (res.body.data as { id: string }[]).map((order) => order.id);
    };
    /** Detalle y primera foto de un pedido que hoy ve. */
    const imagePath = async (worker: Worker, orderId: string) => {
      const res = await get(worker.user, `/orders/available/${orderId}`).expect(
        200,
      );
      return `/orders/available/${orderId}/images/${res.body.images[0].id as string}`;
    };

    it.each(['retirada', 'rechazada'])(
      'oculta listado, detalle y fotos; vuelven al quedar %s',
      async (outcome) => {
        const worker = await newWorker(`hidden-${outcome}`);
        const orderId = await newOrder();
        const image = await imagePath(worker, orderId);
        expect(await availableIds(worker)).toContain(orderId);

        const requested = await requestChange(worker).expect(201);
        const requestId = requested.body.id as string;

        expect(await availableIds(worker)).toEqual([]);
        await get(worker.user, `/orders/available/${orderId}`).expect(404);
        await get(worker.user, image).expect(404);
        // Los pedidos de la zona solicitada tampoco, hasta la aprobacion.
        const newZoneOrder = await newOrder(zoneB);
        await get(worker.user, `/orders/available/${newZoneOrder}`).expect(404);
        // Otro trabajador sigue viendolos.
        await get(otherWorker, `/orders/available/${orderId}`).expect(200);

        if (outcome === 'retirada') {
          await post(
            worker.user,
            `/worker-profile/me/zone-change-requests/${requestId}/withdraw`,
          ).expect(200);
        } else {
          await decide(requestId, {
            decision: 'RECHAZADA',
            comment: 'Sin cobertura',
          }).expect(200);
        }
        expect(await availableIds(worker)).toContain(orderId);
        await get(worker.user, image).expect(200);
      },
    );

    it('conserva a la vista solo el pedido que ya esta negociando', async () => {
      const worker = await newWorker('hidden-negotiating');
      const { orderId, offerId } = await openOffer(worker);
      const other = await newOrder();
      const image = await imagePath(worker, orderId);
      await insertPending(worker);

      expect(await availableIds(worker)).toEqual([orderId]);
      await get(worker.user, image).expect(200);
      await get(worker.user, `/orders/available/${other}`).expect(404);

      // Cerrada la negociacion, tambien se oculta.
      await post(worker.user, `/offers/${offerId}/withdraw`).expect(200);
      expect(await availableIds(worker)).toEqual([]);
      await get(worker.user, image).expect(404);
    });
  });

  describe('reglas 3 a 5: negociaciones ya abiertas', () => {
    it('ambas partes contraofertan y el cliente acepta; el trabajo continua', async () => {
      const worker = await newWorker('negotiating');
      const { orderId, offerId } = await openOffer(worker);
      await insertPending(worker);

      await post(client, `/offers/${offerId}/counter`, {
        amount: '110.00',
      }).expect(200);
      await post(worker.user, `/offers/${offerId}/counter`, {
        amount: '120.50',
      }).expect(200);
      // Un ajeno sigue sin acceso.
      await post(otherClient, `/offers/${offerId}/accept`).expect(404);
      await post(worker.user, `/offers/${offerId}/accept`).expect(403);
      await post(client, `/offers/${offerId}/accept`).expect(200);

      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
      await declare(worker.user, orderId, 'ANTICIPO', '30.13').expect(201);
      await post(worker.user, `/orders/${orderId}/start`).expect(200);
      expect(await pendingCount(worker)).toBe(1);
    });

    it('un perfil suspendido no continua la negociacion', async () => {
      const worker = await newWorker('negotiating-suspended');
      const { offerId } = await openOffer(worker);
      await insertPending(worker);
      await profiles.changeStatusByAdmin(admin.id, worker.profileId, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Motivo de prueba',
      });

      // La suspension cierra sus ofertas.
      await post(client, `/offers/${offerId}/accept`).expect(403);
    });
  });

  describe('regla 8: tras la aprobacion cuenta la nueva zona', () => {
    it('ve y oferta pedidos de la zona nueva, no de la anterior', async () => {
      const worker = await newWorker('approved-zone');
      const res = await requestChange(worker).expect(201);
      const oldZoneOrder = await newOrder(zoneA);
      const newZoneOrder = await newOrder(zoneB);
      // Pendiente: ni siquiera en la zona solicitada.
      await sendOffer(worker, newZoneOrder).expect(409);

      await decide(res.body.id as string, { decision: 'APROBADA' }).expect(200);

      const available = await get(worker.user, '/orders/available?limit=50')
        .expect(200)
        .then((r) => (r.body.data as { id: string }[]).map((o) => o.id));
      expect(available).toContain(newZoneOrder);
      expect(available).not.toContain(oldZoneOrder);
      await sendOffer(worker, oldZoneOrder).expect(404);
      await sendOffer(worker, newZoneOrder).expect(201);
      const inZone = async (zoneId: string) =>
        (
          await profiles.findApprovedWorkers({
            categoryId: category.id,
            zoneId,
          })
        ).map((c) => c.userId);
      expect(await inZone(zoneB.id)).toContain(worker.user.id);
      expect(await inZone(zoneA.id)).not.toContain(worker.user.id);
    });
  });

  describe('concurrencia', () => {
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    /** Retiene una fila en otra transaccion hasta llamar a release(). */
    const hold = async (
      lock: (
        tx: Parameters<WorkerActiveWorkRegistry['lockWorker']>[0],
      ) => Promise<unknown>,
    ) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));
      const done = prisma.$transaction(
        async (tx) => {
          await lock(tx);
          markLocked();
          await held;
        },
        { timeout: 15_000 },
      );
      await locked;
      return async () => {
        release();
        await done;
      };
    };
    const holdWorker = (worker: Worker) =>
      hold((tx) =>
        app.get(WorkerActiveWorkRegistry).lockWorker(tx, worker.user.id),
      );
    /** Lanza las dos peticiones en ese orden, ambas esperando al trabajador. */
    const queued = async (
      worker: Worker,
      first: () => PromiseLike<{ status: number }>,
      second: () => PromiseLike<{ status: number }>,
    ) => {
      const release = await holdWorker(worker);
      const a = first().then((r) => r.status);
      await pause(250);
      const b = second().then((r) => r.status);
      await pause(250);
      await release();
      return Promise.all([a, b]);
    };

    it.each(['solicitud', 'oferta'])(
      'ofertar y solicitar a la vez (primero la %s): solo una gana',
      async (winner) => {
        const worker = await newWorker(`race-create-${winner}`);
        const orderId = await newOrder();
        const offer = () => sendOffer(worker, orderId);
        const change = () => requestChange(worker);

        const statuses =
          winner === 'solicitud'
            ? await queued(worker, change, offer)
            : await queued(worker, offer, change);

        expect(statuses).toEqual([201, 409]);
        expect(
          (await pendingCount(worker)) + (await openOfferCount(worker)),
        ).toBe(1);
      },
    );

    it('sin ordenar las peticiones tampoco coexisten', async () => {
      for (let i = 0; i < 6; i += 1) {
        const worker = await newWorker(`race-free-${i}`);
        const orderId = await newOrder();

        const results = await Promise.all([
          sendOffer(worker, orderId),
          requestChange(worker),
        ]);

        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
          201, 409,
        ]);
        expect(
          (await pendingCount(worker)) + (await openOfferCount(worker)),
        ).toBe(1);
      }
    });

    it.each(['counter', 'accept'])(
      '%s y solicitar a la vez: la negociacion continua y la solicitud se rechaza',
      async (action) => {
        for (const requestFirst of [true, false]) {
          const worker = await newWorker(`race-${action}-${requestFirst}`);
          const { offerId } = await openOffer(worker);
          const negotiate = () =>
            post(
              client,
              `/offers/${offerId}/${action}`,
              action === 'counter' ? { amount: '100.00' } : undefined,
            );
          const change = () => requestChange(worker);

          const statuses = requestFirst
            ? await queued(worker, change, negotiate)
            : await queued(worker, negotiate, change);

          expect(statuses).toEqual(requestFirst ? [409, 200] : [200, 409]);
          expect(await pendingCount(worker)).toBe(0);
        }
      },
    );

    it.each(['counter', 'accept'])(
      '%s iniciado antes del vencimiento no revive una oferta que la solicitud ya no conto',
      async (action) => {
        const worker = await newWorker(`race-expiry-${action}`);
        const { orderId, offerId } = await openOffer(worker);
        // La negociacion espera la cuenta del cliente (su primer bloqueo).
        const release = await hold(
          (tx) =>
            tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${client.id}::uuid FOR UPDATE`,
        );
        await prisma.offer.update({
          where: { id: offerId },
          data: { expiresAt: new Date(Date.now() + 700) },
        });
        const negotiation = post(
          client,
          `/offers/${offerId}/${action}`,
          action === 'counter' ? { amount: '100.00' } : undefined,
        ).then((r) => r.status);
        await pause(1200);
        // Ya vencida: la solicitud entra.
        await requestChange(worker).expect(201);
        await release();

        expect(await negotiation).toBe(409);
        expect(await openOfferCount(worker)).toBe(0);
        expect(await statusOf(orderId)).toBe(OrderStatus.EN_NEGOCIACION);
      },
    );
  });

  describe('trabajos acordados', () => {
    it('continua anticipo, visita, cobro, ejecucion, adicional, finalizacion y saldo', async () => {
      const worker = await newWorker('agreed-visit');
      const { orderId } = await agreedOrder(worker, true);
      await insertPending(worker);
      const asWorker = (url: string, body?: object) =>
        post(worker.user, `/orders/${orderId}${url}`, body);

      // Anticipo: la declaracion del cliente no avanza el pedido.
      const byClient = await declare(
        client,
        orderId,
        'ANTICIPO',
        '30.13',
      ).expect(201);
      expect(byClient.body.orderTransition).toBe('NO_APLICA');
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
      // Ajenos: 404; monto distinto del 25 %: 409.
      await declare(otherWorker, orderId, 'ANTICIPO', '30.13').expect(404);
      await declare(otherClient, orderId, 'ANTICIPO', '30.13').expect(404);
      // El administrador de prueba tambien es cliente, pero no es parte: 404.
      await declare(admin, orderId, 'ANTICIPO', '30.13').expect(404);
      await get(otherWorker, `/orders/${orderId}/workflow`).expect(404);
      const wrong = await declare(
        worker.user,
        orderId,
        'ANTICIPO',
        '30.12',
      ).expect(409);
      expect(wrong.body.message).toContain('anticipo esperado');
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);

      const confirmed = await declare(
        worker.user,
        orderId,
        'ANTICIPO',
        '30.13',
      ).expect(201);
      expect(confirmed.body.orderTransition).toBe('ANTICIPO_REGISTRADO');
      // Idempotente.
      await declare(worker.user, orderId, 'ANTICIPO', '30.13').expect(201);
      expect(
        await prisma.paymentDeclaration.count({
          where: { declaredBy: 'TRABAJADOR', payment: { orderId } },
        }),
      ).toBe(1);

      await post(otherWorker, `/orders/${orderId}/visit`).expect(404);
      await post(client, `/orders/${orderId}/visit`).expect(403);
      await asWorker('/visit').expect(201);
      await asWorker('/visit/payment-confirmation').expect(200);
      await asWorker('/visit/payment-confirmation').expect(200);
      await asWorker('/start').expect(200);
      const budget = await asWorker('/additional-budgets', {
        amount: '40.00',
        reason: 'Cambio de llave de paso',
        materials: 'Llave de media pulgada',
      }).expect(201);
      await post(
        client,
        `/orders/${orderId}/additional-budgets/${budget.body.budget.id as string}/accept`,
      ).expect(200);
      await asWorker('/finish').expect(200);
      await declare(worker.user, orderId, 'SALDO', '100.00').expect(201);
      await post(client, `/orders/${orderId}/confirm-conformity`).expect(200);
      expect(await statusOf(orderId)).toBe(OrderStatus.CERRADO);
      // La solicitud sigue pendiente: nada de lo anterior la toco.
      expect(
        await prisma.zoneChangeRequest.count({
          where: { profileId: worker.profileId, status: 'PENDIENTE' },
        }),
      ).toBe(1);
    });

    it('no puede crear ofertas para pedidos nuevos', async () => {
      const worker = await newWorker('no-new-offer');
      await insertPending(worker);
      const orderId = await newOrder();

      const res = await sendOffer(worker, orderId).expect(409);
      expect(res.body.message).toBe(PENDING_MESSAGE);
      expect(await prisma.offer.count({ where: { orderId } })).toBe(0);
    });

    it('un perfil suspendido sigue sin poder continuar el trabajo (403)', async () => {
      const worker = await newWorker('suspended');
      const { orderId } = await agreedOrder(worker);
      await insertPending(worker);
      await profiles.changeStatusByAdmin(admin.id, worker.profileId, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Motivo de prueba',
      });

      await declare(worker.user, orderId, 'ANTICIPO', '30.13').expect(403);
      await post(worker.user, `/orders/${orderId}/start`).expect(403);
      expect(await statusOf(orderId)).toBe(OrderStatus.ACORDADO);
    });
  });
});
