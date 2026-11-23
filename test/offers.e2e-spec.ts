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
  OfferStatus,
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
import { WorkerProfileService } from '../src/modules/worker-profile/worker-profile.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deleteOrderData } from './utils/orders-cleanup.js';
import { deleteWorkerData } from './utils/worker-profile-cleanup.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@offers-e2e.test';
const label = (text: string) => `${text} ${RUN_ID}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Proximo LUNES (al menos un dia despues) a la hora local de La Paz indicada.
 * La Paz es UTC-4 todo el ano: las 10:00 locales son las 14:00 UTC. Los
 * trabajadores de prueba atienden los LUNES de 08:00 a 18:00.
 */
const nextMondayAt = (hour: number, minute = 0): Date => {
  const date = new Date(Date.now() + DAY);
  // getUTCDay: 1 = lunes. Se avanza en UTC sobre el mediodia para no cruzar
  // de dia por la diferencia horaria.
  date.setUTCHours(12, 0, 0, 0);
  while (date.getUTCDay() !== 1) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  date.setUTCHours(hour + 4, minute, 0, 0);
  return date;
};

describe('OffersModule: creacion y consultas (T6.2, e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let storageDir: string;
  let jpeg: Buffer;

  let admin: PublicUser;
  let client: PublicUser;
  let client2: PublicUser;
  let worker: PublicUser;
  let worker2: PublicUser;
  let workerOtherZone: PublicUser;
  let workerOtherCategory: PublicUser;
  let workerPending: PublicUser;
  let catA: CatalogItem;
  let catB: CatalogItem;
  let zoneA: CatalogItem;
  let zoneB: CatalogItem;

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;

  const newOrder = async (
    owner: PublicUser = client,
    categoryId: string = catA.id,
  ): Promise<string> => {
    const res = await http()
      .post('/api/orders')
      .set('Authorization', auth(owner))
      .field('categoryId', categoryId)
      .field('zoneId', zoneA.id)
      .field('description', 'Fuga de agua debajo del lavaplatos de la cocina')
      .field('budgetAmount', '150.00')
      .field('addressLine', 'Av. Siempre Viva 742')
      .attach('images', jpeg, { filename: 'foto.jpg' })
      .expect(201);
    return res.body.order.id as string;
  };
  const offerBody = (overrides: Record<string, unknown> = {}) => ({
    amount: '120.50',
    requiresVisit: true,
    visitCost: '0',
    materialsIncluded: false,
    proposedStartAt: nextMondayAt(10).toISOString(),
    estimatedDurationMinutes: 90,
    ...overrides,
  });
  const offer = (
    user: PublicUser,
    orderId: string,
    body: Record<string, unknown> = offerBody(),
  ) =>
    http()
      .post(`/api/offers/orders/${orderId}`)
      .set('Authorization', auth(user))
      .send(body);
  /** Cierra una oferta como lo hara T6.3 (estado final y su evento). */
  const closeOffer = async (offerId: string, status: OfferStatus) => {
    const row = await prisma.offer.update({
      where: { id: offerId },
      data: { status, closedAt: new Date() },
    });
    await prisma.offerEvent.create({
      data: {
        offerId,
        orderId: row.orderId,
        type: status as never,
        round: row.round,
        actorType: 'SISTEMA',
        systemProcess: 'PRUEBA',
      },
    });
  };

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'offers-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
        email: `${name}-${RUN_ID}${EMAIL_DOMAIN}`,
        passwordHash: 'hash',
        phone,
      });
    admin = await newUser('admin');
    client = await newUser('client');
    client2 = await newUser('client2');
    worker = await newUser('worker', '71000001');
    worker2 = await newUser('worker2', '71000002');
    workerOtherZone = await newUser('worker-zona', '71000003');
    workerOtherCategory = await newUser('worker-cat', '71000004');
    workerPending = await newUser('worker-pend', '71000005');
    await prisma.userRole.create({
      data: { userId: admin.id, role: RoleName.ADMINISTRADOR },
    });

    const newCatalog = (kind: CatalogKind, name: string) =>
      catalogs.create(kind, admin.id, { name: label(name) });
    catA = await newCatalog(CatalogKind.CATEGORY, 'Ofertas Plomeria');
    catB = await newCatalog(CatalogKind.CATEGORY, 'Ofertas Electricidad');
    zoneA = await newCatalog(CatalogKind.ZONE, 'Ofertas Norte');
    zoneB = await newCatalog(CatalogKind.ZONE, 'Ofertas Sur');

    const newWorker = async (
      user: PublicUser,
      zoneId: string,
      categoryId: string,
      approve = true,
    ) => {
      const profile = await profiles.create(user.id, {
        yearsOfExperience: 5,
        zoneId,
        categoryIds: [categoryId],
        schedules: [
          { dayOfWeek: 'LUNES', startTime: '08:00', endTime: '18:00' },
        ],
      });
      await profiles.submit(user.id);
      if (approve) {
        await profiles.changeStatusByAdmin(admin.id, profile.id, {
          status: WorkerProfileStatus.APROBADO,
        });
      }
    };
    await newWorker(worker, zoneA.id, catA.id);
    await newWorker(worker2, zoneA.id, catA.id);
    await newWorker(workerOtherZone, zoneB.id, catA.id);
    await newWorker(workerOtherCategory, zoneA.id, catB.id);
    await newWorker(workerPending, zoneA.id, catA.id, false);

    jpeg = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#3366aa' },
    })
      .jpeg()
      .toBuffer();
  });

  afterAll(async () => {
    const userIds = [
      admin,
      client,
      client2,
      worker,
      worker2,
      workerOtherZone,
      workerOtherCategory,
      workerPending,
    ].map((user) => user.id);
    await deleteOrderData(prisma, userIds);
    await deleteWorkerData(prisma, userIds);
    await prisma.serviceCategory.deleteMany({
      where: { name: { contains: RUN_ID } },
    });
    await prisma.zone.deleteMany({ where: { name: { contains: RUN_ID } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.FILE_STORAGE_DIR;
  });

  describe('POST /api/offers/orders/:orderId', () => {
    it('crea la oferta VIGENTE, ronda 1, turno del cliente, 24 horas y su evento PROPUESTA', async () => {
      const orderId = await newOrder();

      const res = await offer(worker, orderId).expect(201);

      expect(res.body).toMatchObject({
        orderId,
        status: OfferStatus.VIGENTE,
        round: 1,
        turn: 'CLIENTE',
        amount: '120.50',
        requiresVisit: true,
        visitCost: '0.00',
        materialsIncluded: false,
        estimatedDurationMinutes: 90,
        closedAt: null,
      });
      expect(
        Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt),
      ).toBeGreaterThanOrEqual(24 * HOUR - 1000);
      expect(
        Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt),
      ).toBeLessThanOrEqual(24 * HOUR + 1000);
      expect(res.body.history).toEqual([
        expect.objectContaining({
          type: 'PROPUESTA',
          round: 1,
          amount: '120.50',
          actorType: 'USUARIO',
          changedById: worker.id,
          actorRole: RoleName.TRABAJADOR,
        }),
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/address|Siempre Viva/i);

      const events = await prisma.offerEvent.findMany({
        where: { offerId: res.body.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ orderId, type: 'PROPUESTA' });
      // T6.4.1: la primera oferta abre la negociacion, sin asignar ni tocar
      // el plazo original de 7 dias.
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
      expect(order.status).toBe(OrderStatus.EN_NEGOCIACION);
      expect(order.assignedWorkerId).toBeNull();
      expect(order.expiresAt.getTime() - order.publishedAt.getTime()).toBe(
        7 * DAY,
      );
      expect(order.statusHistory.at(-1)).toMatchObject({
        fromStatus: OrderStatus.PUBLICADO,
        toStatus: OrderStatus.EN_NEGOCIACION,
        changedById: worker.id,
        actorRole: RoleName.TRABAJADOR,
      });
    });

    it('el horario de atencion no limita las ofertas: se oferta a cualquier hora', async () => {
      // Los trabajadores de prueba atienden solo los LUNES de 08:00 a 18:00
      // (hora de La Paz). Ninguno de estos horarios esta dentro y todos se
      // aceptan: el trabajador negocia el horario con el cliente.
      const outside = [
        { start: nextMondayAt(7), minutes: 60 }, // antes de abrir
        { start: nextMondayAt(17, 30), minutes: 120 }, // termina despues
        { start: nextMondayAt(23, 30), minutes: 90 }, // cruza la medianoche
        { start: new Date(nextMondayAt(3).getTime() + 6 * DAY), minutes: 30 }, // domingo 03:00
      ];
      for (const slot of outside) {
        const orderId = await newOrder();
        const res = await offer(
          worker,
          orderId,
          offerBody({
            proposedStartAt: slot.start.toISOString(),
            estimatedDurationMinutes: slot.minutes,
          }),
        ).expect(201);
        expect(res.body).toMatchObject({
          status: OfferStatus.VIGENTE,
          estimatedDurationMinutes: slot.minutes,
        });
        expect(Date.parse(res.body.proposedStartAt)).toBe(slot.start.getTime());
      }
    });

    it('un trabajador sin horarios de atencion tambien puede ofertar', async () => {
      const orderId = await newOrder();
      const profile = await prisma.workerProfile.findUniqueOrThrow({
        where: { userId: worker2.id },
        select: { id: true },
      });
      const schedules = await prisma.workerSchedule.findMany({
        where: { profileId: profile.id },
      });
      await prisma.workerSchedule.deleteMany({
        where: { profileId: profile.id },
      });
      try {
        await offer(worker2, orderId).expect(201);
      } finally {
        await prisma.workerSchedule.createMany({ data: schedules });
      }
    });

    it('sin visita no lleva costo; datos invalidos responden 400', async () => {
      const orderId = await newOrder();
      await offer(worker, orderId, offerBody({ amount: '0' })).expect(400);
      await offer(
        worker,
        orderId,
        offerBody({ estimatedDurationMinutes: 0 }),
      ).expect(400);
      await offer(
        worker,
        orderId,
        offerBody({ requiresVisit: true, visitCost: undefined }),
      ).expect(400);
      await offer(
        worker,
        orderId,
        offerBody({ requiresVisit: false, visitCost: '10' }),
      ).expect(400);
      await offer(
        worker,
        orderId,
        offerBody({
          proposedStartAt: new Date(Date.now() - HOUR).toISOString(),
        }),
      ).expect(400);

      const res = await offer(
        worker,
        orderId,
        offerBody({ requiresVisit: false, visitCost: undefined }),
      ).expect(201);
      expect(res.body).toMatchObject({ requiresVisit: false, visitCost: null });
    });

    it('rechaza a un trabajador no aprobado y a quien no es trabajador', async () => {
      const orderId = await newOrder();
      await offer(workerPending, orderId).expect(403);
      await offer(client2, orderId).expect(403);
      expect(await prisma.offer.count({ where: { orderId } })).toBe(0);
    });

    it('otra zona u otra especialidad no ven el pedido (404)', async () => {
      const orderId = await newOrder();
      await offer(workerOtherZone, orderId).expect(404);
      await offer(workerOtherCategory, orderId).expect(404);
    });

    it('un trabajador no oferta en su propio pedido (RN-14)', async () => {
      const own = await newOrder(worker);
      await offer(worker, own).expect(404);
      await offer(worker2, own).expect(201);
    });

    it('un pedido cancelado o vencido no admite ofertas', async () => {
      const cancelled = await newOrder();
      await http()
        .post(`/api/orders/me/${cancelled}/cancel`)
        .set('Authorization', auth(client))
        .send({})
        .expect(200);
      await offer(worker, cancelled).expect(404);

      const expired = await newOrder();
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired}::uuid`;
      await offer(worker, expired).expect(404);
    });

    it('con la categoria o la zona inactiva se bloquea; al reactivarla se puede ofertar', async () => {
      const orderId = await newOrder();
      await prisma.serviceCategory.update({
        where: { id: catA.id },
        data: { isActive: false },
      });
      try {
        await offer(worker, orderId).expect(404);
      } finally {
        await prisma.serviceCategory.update({
          where: { id: catA.id },
          data: { isActive: true },
        });
      }
      await prisma.zone.update({
        where: { id: zoneA.id },
        data: { isActive: false },
      });
      try {
        await offer(worker, orderId).expect(404);
      } finally {
        await prisma.zone.update({
          where: { id: zoneA.id },
          data: { isActive: true },
        });
      }
      await offer(worker, orderId).expect(201);
    });

    it('si el cliente cambia la categoria, la oferta nueva exige la especialidad actual y la anterior se conserva', async () => {
      const orderId = await newOrder();
      const before = await offer(worker, orderId).expect(201);
      await http()
        .patch(`/api/orders/me/${orderId}`)
        .set('Authorization', auth(client))
        .send({ categoryId: catB.id })
        .expect(200);

      await offer(worker2, orderId).expect(404);
      await offer(workerOtherCategory, orderId).expect(201);
      const kept = await prisma.offer.findUniqueOrThrow({
        where: { id: before.body.id },
      });
      expect(kept.status).toBe(OfferStatus.VIGENTE);
    });

    it('una segunda oferta vigente del mismo trabajador responde 409', async () => {
      const orderId = await newOrder();
      await offer(worker, orderId).expect(201);
      const res = await offer(worker, orderId).expect(409);
      expect(res.body.message).toContain('Ya tiene una oferta vigente');
      expect(await prisma.offer.count({ where: { orderId } })).toBe(1);
    });

    it.each([
      [OfferStatus.RETIRADA, 'Retiró su oferta'],
      [OfferStatus.RECHAZADA, 'fue rechazada'],
      [OfferStatus.SIN_EFECTO, 'quedó sin efecto'],
    ])(
      'despues de una oferta %s no puede volver a ofertar',
      async (status, message) => {
        const orderId = await newOrder();
        const first = await offer(worker, orderId).expect(201);
        await closeOffer(first.body.id, status);

        const res = await offer(worker, orderId).expect(409);
        expect(res.body.message).toContain(message);
        // Otro trabajador si puede.
        await offer(worker2, orderId).expect(201);
      },
    );

    it('despues de una oferta vencida puede volver a ofertar: la vieja queda VENCIDA con su evento', async () => {
      const orderId = await newOrder();
      const first = await offer(worker, orderId).expect(201);
      await prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${first.body.id}::uuid`;

      const second = await offer(worker, orderId).expect(201);

      expect(second.body.id).not.toBe(first.body.id);
      const old = await prisma.offer.findUniqueOrThrow({
        where: { id: first.body.id },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });
      expect(old.status).toBe(OfferStatus.VENCIDA);
      expect(old.closedAt).toBeInstanceOf(Date);
      expect(old.events.map((event) => event.type)).toEqual([
        'PROPUESTA',
        'VENCIDA',
      ]);
      expect(old.events[1]).toMatchObject({
        actorType: 'SISTEMA',
        systemProcess: 'VENCIMIENTO_OFERTA',
        amount: null,
      });
    });

    it('concurrencia: dos envios simultaneos del mismo trabajador crean una sola oferta', async () => {
      const orderId = await newOrder();

      const results = await Promise.all([
        offer(worker, orderId),
        offer(worker, orderId),
        offer(worker, orderId),
      ]);

      expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([
        201, 409, 409,
      ]);
      expect(await prisma.offer.count({ where: { orderId } })).toBe(1);
      expect(await prisma.offerEvent.count({ where: { orderId } })).toBe(1);
    });

    it('concurrencia: trabajadores distintos pueden ofertar a la vez en el mismo pedido', async () => {
      const orderId = await newOrder();

      const results = await Promise.all([
        offer(worker, orderId),
        offer(worker2, orderId),
      ]);

      expect(results.map((res) => res.status)).toEqual([201, 201]);
      expect(await prisma.offer.count({ where: { orderId } })).toBe(2);
    });

    it('el historial no se puede modificar ni borrar', async () => {
      const orderId = await newOrder();
      const res = await offer(worker, orderId).expect(201);

      await expect(
        prisma.offerEvent.updateMany({
          where: { offerId: res.body.id },
          data: { reason: 'cambio' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.offerEvent.deleteMany({ where: { offerId: res.body.id } }),
      ).rejects.toThrow();
    });
  });

  describe('consultas', () => {
    let orderId: string;
    let offerId: string;

    beforeAll(async () => {
      orderId = await newOrder(client2);
      offerId = (await offer(worker, orderId).expect(201)).body.id;
    });

    it('el trabajador lista y consulta sus ofertas, con filtro y paginacion', async () => {
      const list = await http()
        .get('/api/offers/me')
        .query({ status: 'VIGENTE', limit: 50 })
        .set('Authorization', auth(worker))
        .expect(200);
      expect(list.body.meta).toMatchObject({ page: 1, limit: 50 });
      expect(list.body.data.map((item: { id: string }) => item.id)).toContain(
        offerId,
      );
      expect(
        list.body.data.every(
          (item: { status: string }) => item.status === 'VIGENTE',
        ),
      ).toBe(true);

      const detail = await http()
        .get(`/api/offers/me/${offerId}`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(detail.body.history).toHaveLength(1);
      expect(JSON.stringify(detail.body)).not.toMatch(/address|Siempre Viva/i);
    });

    it('otro trabajador no ve la oferta (404) ni la lista', async () => {
      await http()
        .get(`/api/offers/me/${offerId}`)
        .set('Authorization', auth(worker2))
        .expect(404);
      const list = await http()
        .get('/api/offers/me')
        .set('Authorization', auth(worker2))
        .query({ limit: 50 })
        .expect(200);
      expect(
        list.body.data.map((item: { id: string }) => item.id),
      ).not.toContain(offerId);
    });

    it('el cliente ve las ofertas recibidas con el nombre del trabajador, sin contacto', async () => {
      const list = await http()
        .get('/api/offers/received')
        .query({ orderId })
        .set('Authorization', auth(client2))
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        id: offerId,
        worker: { id: worker.id, firstName: 'worker', lastName: 'E2E' },
      });
      expect(JSON.stringify(list.body)).not.toMatch(/email|phone|address/i);

      const detail = await http()
        .get(`/api/offers/received/${offerId}`)
        .set('Authorization', auth(client2))
        .expect(200);
      expect(detail.body.history[0]).toMatchObject({ type: 'PROPUESTA' });
    });

    it('otro cliente no ve la oferta ni el pedido ajeno', async () => {
      await http()
        .get(`/api/offers/received/${offerId}`)
        .set('Authorization', auth(client))
        .expect(404);
      await http()
        .get('/api/offers/received')
        .query({ orderId })
        .set('Authorization', auth(client))
        .expect(404);
      const list = await http()
        .get('/api/offers/received')
        .query({ limit: 50 })
        .set('Authorization', auth(client))
        .expect(200);
      expect(
        list.body.data.map((item: { id: string }) => item.id),
      ).not.toContain(offerId);
    });

    it('una oferta con la vigencia cumplida se muestra VENCIDA', async () => {
      const otherOrder = await newOrder(client2);
      const created = await offer(worker, otherOrder).expect(201);
      await prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${created.body.id}::uuid`;

      const detail = await http()
        .get(`/api/offers/received/${created.body.id}`)
        .set('Authorization', auth(client2))
        .expect(200);
      expect(detail.body.status).toBe('VENCIDA');
      const vigentes = await http()
        .get('/api/offers/received')
        .query({ orderId: otherOrder, status: 'VIGENTE' })
        .set('Authorization', auth(client2))
        .expect(200);
      expect(vigentes.body.data).toEqual([]);
    });

    it('sin el rol correspondiente responde 403', async () => {
      await http()
        .get('/api/offers/me')
        .set('Authorization', auth(client))
        .expect(403);
      await http()
        .get('/api/offers/received')
        .set('Authorization', auth(admin))
        .expect(200);
    });
  });

  describe('POST /api/offers/:offerId/counter (T6.3)', () => {
    const counter = (user: PublicUser, offerId: string, body: object) =>
      http()
        .post(`/api/offers/${offerId}/counter`)
        .set('Authorization', auth(user))
        .send(body);
    /** Pedido de `client` con una oferta de `worker` (ronda 1, turno del cliente). */
    const negotiation = async () => {
      const orderId = await newOrder();
      const created = await offer(worker, orderId).expect(201);
      return {
        orderId,
        offerId: created.body.id as string,
        original: created.body as Record<string, unknown>,
      };
    };

    it('cliente y trabajador se alternan hasta la ronda 3, solo cambia el monto y queda el historial', async () => {
      const { offerId, original } = await negotiation();

      const first = await counter(client, offerId, { amount: '100' }).expect(
        200,
      );
      expect(first.body).toMatchObject({
        round: 2,
        turn: 'TRABAJADOR',
        amount: '100.00',
        status: OfferStatus.VIGENTE,
        worker: { id: worker.id },
      });

      const second = await counter(worker, offerId, { amount: 110.5 }).expect(
        200,
      );
      expect(second.body).toMatchObject({
        round: 3,
        turn: 'CLIENTE',
        amount: '110.50',
      });
      // Condiciones originales intactas.
      for (const key of [
        'requiresVisit',
        'visitCost',
        'materialsIncluded',
        'proposedStartAt',
        'estimatedDurationMinutes',
        'createdAt',
      ]) {
        expect(second.body[key]).toEqual(original[key]);
      }
      type EventBody = {
        type: string;
        round: number;
        amount: string;
        actorRole: string;
      };
      expect(
        (second.body.history as EventBody[]).map((event) => [
          event.type,
          event.round,
          event.amount,
          event.actorRole,
        ]),
      ).toEqual([
        ['PROPUESTA', 1, '120.50', 'TRABAJADOR'],
        ['CONTRAOFERTA', 2, '100.00', 'CLIENTE'],
        ['CONTRAOFERTA', 3, '110.50', 'TRABAJADOR'],
      ]);

      // Ronda 3 alcanzada: no hay mas contraofertas.
      const max = await counter(client, offerId, { amount: '105' }).expect(409);
      expect(max.body.message).toContain('máximo de 3 rondas');
    });

    it('cada contraoferta reinicia la vigencia de 24 horas', async () => {
      const { offerId } = await negotiation();
      await prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() + interval '1 hour' WHERE "id" = ${offerId}::uuid`;

      const res = await counter(client, offerId, { amount: '100' }).expect(200);

      const [{ now }] = await prisma.$queryRaw<
        { now: Date }[]
      >`SELECT now() AS "now"`;
      const left = Date.parse(res.body.expiresAt) - now.getTime();
      expect(left).toBeGreaterThan(24 * HOUR - 60_000);
      expect(left).toBeLessThanOrEqual(24 * HOUR);
    });

    it('solo responde quien tiene el turno', async () => {
      const { offerId } = await negotiation();
      const early = await counter(worker, offerId, { amount: '100' }).expect(
        409,
      );
      expect(early.body.message).toContain('cliente');
      await counter(client, offerId, { amount: '100' }).expect(200);
      await counter(client, offerId, { amount: '90' }).expect(409);
    });

    it('quien no participa recibe 404', async () => {
      const { offerId } = await negotiation();
      await counter(client2, offerId, { amount: '100' }).expect(404);
      await counter(worker2, offerId, { amount: '100' }).expect(404);
      await counter(workerPending, offerId, { amount: '100' }).expect(404);
    });

    it('rechaza montos invalidos y cualquier otro campo (400)', async () => {
      const { offerId } = await negotiation();
      for (const body of [
        { amount: '0' },
        { amount: '-5' },
        { amount: '10.123' },
        { amount: 'abc' },
        {},
        { amount: '100', requiresVisit: false },
        { amount: '100', estimatedDurationMinutes: 30 },
      ]) {
        await counter(client, offerId, body).expect(400);
      }
      const row = await prisma.offer.findUniqueOrThrow({
        where: { id: offerId },
      });
      expect(row.round).toBe(1);
    });

    it('una oferta vencida o cerrada no admite contraofertas', async () => {
      const expired = await negotiation();
      await prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired.offerId}::uuid`;
      const res = await counter(client, expired.offerId, {
        amount: '100',
      }).expect(409);
      expect(res.body.message).toContain('venció');

      const closed = await negotiation();
      await closeOffer(closed.offerId, OfferStatus.RETIRADA);
      const res2 = await counter(client, closed.offerId, {
        amount: '100',
      }).expect(409);
      expect(res2.body.message).toContain('cerrada');
    });

    it('un pedido cancelado o vencido ya no admite negociacion', async () => {
      const cancelled = await negotiation();
      await http()
        .post(`/api/orders/me/${cancelled.orderId}/cancel`)
        .set('Authorization', auth(client))
        .send({})
        .expect(200);
      await counter(client, cancelled.offerId, { amount: '100' }).expect(409);

      const expired = await negotiation();
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired.orderId}::uuid`;
      const res = await counter(client, expired.offerId, {
        amount: '100',
      }).expect(409);
      expect(res.body.message).toContain('VENCIDO');
    });

    it('con la categoria o la zona inactiva se bloquea; al reactivarla continua', async () => {
      const { offerId } = await negotiation();
      await prisma.serviceCategory.update({
        where: { id: catA.id },
        data: { isActive: false },
      });
      try {
        const res = await counter(client, offerId, { amount: '100' }).expect(
          409,
        );
        expect(res.body.message).toContain('categoría');
      } finally {
        await prisma.serviceCategory.update({
          where: { id: catA.id },
          data: { isActive: true },
        });
      }
      await prisma.zone.update({
        where: { id: zoneA.id },
        data: { isActive: false },
      });
      try {
        const res = await counter(client, offerId, { amount: '100' }).expect(
          409,
        );
        expect(res.body.message).toContain('zona');
      } finally {
        await prisma.zone.update({
          where: { id: zoneA.id },
          data: { isActive: true },
        });
      }
      await counter(client, offerId, { amount: '100' }).expect(200);
    });

    it('tras un cambio de categoria la negociacion existente continua (decision 12)', async () => {
      const { orderId, offerId } = await negotiation();
      await http()
        .patch(`/api/orders/me/${orderId}`)
        .set('Authorization', auth(client))
        .send({ categoryId: catB.id })
        .expect(200);

      await counter(client, offerId, { amount: '100' }).expect(200);
      // El trabajador ya no tiene la especialidad de la categoria actual.
      await counter(worker, offerId, { amount: '105' }).expect(200);
    });

    it('el historial de contraofertas no se puede modificar ni borrar', async () => {
      const { offerId } = await negotiation();
      await counter(client, offerId, { amount: '100' }).expect(200);
      await expect(
        prisma.offerEvent.updateMany({
          where: { offerId, type: 'CONTRAOFERTA' },
          data: { amount: '1' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.offerEvent.deleteMany({
          where: { offerId, type: 'CONTRAOFERTA' },
        }),
      ).rejects.toThrow();
      // Tampoco cambian las condiciones de la oferta.
      await expect(
        prisma.offer.update({
          where: { id: offerId },
          data: { materialsIncluded: true },
        }),
      ).rejects.toThrow();
    });

    it('concurrencia: respuestas simultaneas generan una sola contraoferta por ronda', async () => {
      const { offerId } = await negotiation();

      const results = await Promise.all([
        counter(client, offerId, { amount: '100' }),
        counter(client, offerId, { amount: '101' }),
        counter(client, offerId, { amount: '102' }),
      ]);

      expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([
        200, 409, 409,
      ]);
      const events = await prisma.offerEvent.findMany({
        where: { offerId, type: 'CONTRAOFERTA' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].round).toBe(2);
      const row = await prisma.offer.findUniqueOrThrow({
        where: { id: offerId },
      });
      expect(row).toMatchObject({ round: 2, turn: 'TRABAJADOR' });
      expect(row.amount.toFixed(2)).toBe(events[0].amount!.toFixed(2));
    });

    it('concurrencia: cliente y trabajador a la vez, nunca dos eventos de la misma ronda', async () => {
      const { offerId } = await negotiation();

      const [byClient, byWorker] = await Promise.all([
        counter(client, offerId, { amount: '100' }),
        counter(worker, offerId, { amount: '130' }),
      ]);

      // Si el trabajador toma el bloqueo despues del cliente es su turno; si
      // lo toma antes, no lo es.
      expect(byClient.status).toBe(200);
      expect([200, 409]).toContain(byWorker.status);
      const rounds = (
        await prisma.offerEvent.findMany({
          where: { offerId, type: 'CONTRAOFERTA' },
          orderBy: { round: 'asc' },
        })
      ).map((event) => event.round);
      expect(rounds).toEqual(byWorker.status === 200 ? [2, 3] : [2]);
    });
  });

  describe('rechazo, retiro y estado del pedido (T6.4.1)', () => {
    const reject = (user: PublicUser, offerId: string) =>
      http()
        .post(`/api/offers/${offerId}/reject`)
        .set('Authorization', auth(user))
        .send({});
    const withdraw = (user: PublicUser, offerId: string) =>
      http()
        .post(`/api/offers/${offerId}/withdraw`)
        .set('Authorization', auth(user))
        .send({});
    const counterBy = (user: PublicUser, offerId: string, amount: string) =>
      http()
        .post(`/api/offers/${offerId}/counter`)
        .set('Authorization', auth(user))
        .send({ amount });
    const orderRow = (id: string) =>
      prisma.order.findUniqueOrThrow({
        where: { id },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
    /** Invariante: EN_NEGOCIACION si y solo si hay alguna oferta vigente. */
    const expectStatusMatchesOffers = async (orderId: string) => {
      const [order, open] = await Promise.all([
        prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
        prisma.offer.count({
          where: {
            orderId,
            status: OfferStatus.VIGENTE,
            expiresAt: { gt: new Date() },
          },
        }),
      ]);
      expect(order.status).toBe(
        open > 0 ? OrderStatus.EN_NEGOCIACION : OrderStatus.PUBLICADO,
      );
    };

    it('el cliente rechaza la unica oferta: RECHAZADA y el pedido vuelve a PUBLICADO sin tocar su plazo', async () => {
      const orderId = await newOrder();
      const { body: created } = await offer(worker, orderId).expect(201);
      const before = await orderRow(orderId);
      expect(before.status).toBe(OrderStatus.EN_NEGOCIACION);

      const res = await reject(client, created.id).expect(200);

      expect(res.body).toMatchObject({
        status: OfferStatus.RECHAZADA,
        worker: { id: worker.id },
      });
      expect(res.body.closedAt).not.toBeNull();
      expect(res.body.history.at(-1)).toMatchObject({
        type: 'RECHAZADA',
        round: 1,
        amount: null,
        changedById: client.id,
        actorRole: RoleName.CLIENTE,
      });
      const after = await orderRow(orderId);
      expect(after.status).toBe(OrderStatus.PUBLICADO);
      expect(after.publishedAt).toEqual(before.publishedAt);
      expect(after.expiresAt).toEqual(before.expiresAt);
      expect(after.statusHistory.at(-1)).toMatchObject({
        fromStatus: OrderStatus.EN_NEGOCIACION,
        toStatus: OrderStatus.PUBLICADO,
        changedById: client.id,
        actorRole: RoleName.CLIENTE,
      });

      // El rechazado no vuelve a ofertar; otro trabajador si, y reabre.
      await offer(worker, orderId).expect(409);
      await offer(worker2, orderId).expect(201);
      expect((await orderRow(orderId)).status).toBe(OrderStatus.EN_NEGOCIACION);
    });

    it('el trabajador retira su oferta en cualquier turno y no puede volver a ofertar', async () => {
      const orderId = await newOrder();
      const { body: created } = await offer(worker, orderId).expect(201);
      // Turno del trabajador despues de la contraoferta del cliente.
      await counterBy(client, created.id, '100').expect(200);

      const res = await withdraw(worker, created.id).expect(200);

      expect(res.body.status).toBe(OfferStatus.RETIRADA);
      expect(res.body.history.at(-1)).toMatchObject({
        type: 'RETIRADA',
        round: 2,
        changedById: worker.id,
        actorRole: RoleName.TRABAJADOR,
      });
      expect((await orderRow(orderId)).statusHistory.at(-1)).toMatchObject({
        toStatus: OrderStatus.PUBLICADO,
        changedById: worker.id,
        actorRole: RoleName.TRABAJADOR,
      });
      const again = await offer(worker, orderId).expect(409);
      expect(again.body.message).toContain('Retiró su oferta');
    });

    it('el retiro tambien vale en el turno del cliente', async () => {
      const orderId = await newOrder();
      const { body: created } = await offer(worker, orderId).expect(201);
      await withdraw(worker, created.id).expect(200);
    });

    it('el trabajador no puede rechazar y el cliente no puede retirar', async () => {
      const orderId = await newOrder();
      const { body: created } = await offer(worker, orderId).expect(201);
      // El trabajador tambien tiene el rol CLIENTE, pero no es el dueno.
      await reject(worker, created.id).expect(403);
      await withdraw(client, created.id).expect(403);
      // Ajenos: 404.
      await reject(client2, created.id).expect(404);
      await withdraw(worker2, created.id).expect(404);
      const row = await prisma.offer.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(OfferStatus.VIGENTE);
    });

    it('el cliente no rechaza fuera de su turno', async () => {
      const orderId = await newOrder();
      const { body: created } = await offer(worker, orderId).expect(201);
      await counterBy(client, created.id, '100').expect(200);

      const res = await reject(client, created.id).expect(409);
      expect(res.body.message).toContain('trabajador');
      // Cuando el trabajador contraoferta vuelve a ser su turno.
      await counterBy(worker, created.id, '110').expect(200);
      await reject(client, created.id).expect(200);
    });

    it('una oferta vencida o cerrada no se rechaza ni se retira', async () => {
      const orderId = await newOrder();
      const { body: expired } = await offer(worker, orderId).expect(201);
      await prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired.id}::uuid`;
      expect(
        (await reject(client, expired.id).expect(409)).body.message,
      ).toContain('venció');
      await withdraw(worker, expired.id).expect(409);

      const { body: closed } = await offer(worker2, orderId).expect(201);
      await withdraw(worker2, closed.id).expect(200);
      expect(
        (await reject(client, closed.id).expect(409)).body.message,
      ).toContain('cerrada');
      await withdraw(worker2, closed.id).expect(409);
    });

    it('con varias ofertas el pedido sigue EN_NEGOCIACION hasta cerrar la ultima', async () => {
      const orderId = await newOrder();
      const first = (await offer(worker, orderId).expect(201)).body.id;
      const second = (await offer(worker2, orderId).expect(201)).body.id;

      await reject(client, first).expect(200);
      expect((await orderRow(orderId)).status).toBe(OrderStatus.EN_NEGOCIACION);

      await withdraw(worker2, second).expect(200);
      const order = await orderRow(orderId);
      expect(order.status).toBe(OrderStatus.PUBLICADO);
      // Una sola entrada PUBLICADO -> EN_NEGOCIACION y otra de vuelta.
      expect(
        order.statusHistory.map((entry) => [entry.fromStatus, entry.toStatus]),
      ).toEqual([
        [null, OrderStatus.PUBLICADO],
        [OrderStatus.PUBLICADO, OrderStatus.EN_NEGOCIACION],
        [OrderStatus.EN_NEGOCIACION, OrderStatus.PUBLICADO],
      ]);
    });

    it('una oferta vencida sin marcar no cuenta como vigente', async () => {
      const orderId = await newOrder();
      const stale = (await offer(worker, orderId).expect(201)).body.id;
      const live = (await offer(worker2, orderId).expect(201)).body.id;
      await prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${stale}::uuid`;

      await reject(client, live).expect(200);

      expect((await orderRow(orderId)).status).toBe(OrderStatus.PUBLICADO);
    });

    it('un pedido cancelado o vencido no admite rechazo ni retiro y no cambia de estado', async () => {
      const cancelled = await newOrder();
      const a = (await offer(worker, cancelled).expect(201)).body.id;
      await http()
        .post(`/api/orders/me/${cancelled}/cancel`)
        .set('Authorization', auth(client))
        .send({})
        .expect(200);
      await reject(client, a).expect(409);
      await withdraw(worker, a).expect(409);
      expect((await orderRow(cancelled)).status).toBe(OrderStatus.CANCELADO);

      const expired = await newOrder();
      const b = (await offer(worker, expired).expect(201)).body.id;
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired}::uuid`;
      await reject(client, b).expect(409);
      await withdraw(worker, b).expect(409);
      expect((await orderRow(expired)).status).toBe(OrderStatus.EN_NEGOCIACION);
    });

    it('el cierre queda en el historial inmutable y la oferta no se reabre', async () => {
      const orderId = await newOrder();
      const id = (await offer(worker, orderId).expect(201)).body.id;
      await reject(client, id).expect(200);

      await expect(
        prisma.offerEvent.updateMany({
          where: { offerId: id, type: 'RECHAZADA' },
          data: { reason: 'cambio' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.offerEvent.deleteMany({ where: { offerId: id } }),
      ).rejects.toThrow();
      await expect(
        prisma.offer.update({
          where: { id },
          data: { status: OfferStatus.VIGENTE, closedAt: null },
        }),
      ).rejects.toThrow();
    });

    it('concurrencia: rechazo y retiro simultaneos cierran la oferta una sola vez', async () => {
      const orderId = await newOrder();
      const id = (await offer(worker, orderId).expect(201)).body.id;

      const results = await Promise.all([
        reject(client, id),
        withdraw(worker, id),
        withdraw(worker, id),
      ]);

      expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([
        200, 409, 409,
      ]);
      const closings = await prisma.offerEvent.findMany({
        where: { offerId: id, type: { in: ['RECHAZADA', 'RETIRADA'] } },
      });
      expect(closings).toHaveLength(1);
      const order = await orderRow(orderId);
      expect(order.status).toBe(OrderStatus.PUBLICADO);
      expect(
        order.statusHistory.filter(
          (entry) => entry.toStatus === OrderStatus.PUBLICADO,
        ),
      ).toHaveLength(2);
    });

    it('concurrencia: cerrar dos ofertas a la vez devuelve el pedido a PUBLICADO una sola vez', async () => {
      const orderId = await newOrder();
      const first = (await offer(worker, orderId).expect(201)).body.id;
      const second = (await offer(worker2, orderId).expect(201)).body.id;

      const results = await Promise.all([
        reject(client, first),
        withdraw(worker2, second),
      ]);

      expect(results.map((res) => res.status)).toEqual([200, 200]);
      const order = await orderRow(orderId);
      expect(order.status).toBe(OrderStatus.PUBLICADO);
      expect(
        order.statusHistory.filter(
          (entry) => entry.fromStatus === OrderStatus.EN_NEGOCIACION,
        ),
      ).toHaveLength(1);
    });

    it('concurrencia: retirar mientras llega otra oferta nunca deja el pedido PUBLICADO con ofertas vigentes', async () => {
      for (let i = 0; i < 3; i++) {
        const orderId = await newOrder();
        const id = (await offer(worker, orderId).expect(201)).body.id;

        const [closed, created] = await Promise.all([
          withdraw(worker, id),
          offer(worker2, orderId),
        ]);

        expect(closed.status).toBe(200);
        expect(created.status).toBe(201);
        await expectStatusMatchesOffers(orderId);
        expect((await orderRow(orderId)).status).toBe(
          OrderStatus.EN_NEGOCIACION,
        );
      }
    });
  });
});
