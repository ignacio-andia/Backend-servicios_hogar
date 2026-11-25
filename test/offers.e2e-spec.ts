import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SchedulerRegistry } from '@nestjs/schedule';
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
import { OrderExpirationService } from '../src/modules/orders/order-expiration.service.js';
import { OfferExpirationService } from '../src/modules/offers/offer-expiration.service.js';
import { OffersService } from '../src/modules/offers/offers.service.js';
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

  describe('POST /api/offers/:offerId/accept (T6.4.2)', () => {
    // Cada trabajo aceptado queda activo el resto de la suite: cada prueba usa
    // su propia semana para no cruzarse con otra salvo a proposito.
    let week = 10;
    const slot = () => ({
      proposedStartAt: new Date(
        nextMondayAt(10).getTime() + week++ * 7 * DAY,
      ).toISOString(),
      estimatedDurationMinutes: 120,
    });
    const accept = (user: PublicUser, offerId: string) =>
      http()
        .post(`/api/offers/${offerId}/accept`)
        .set('Authorization', auth(user))
        .send({});
    const rejectBy = (user: PublicUser, offerId: string) =>
      http()
        .post(`/api/offers/${offerId}/reject`)
        .set('Authorization', auth(user))
        .send({});
    const withdrawBy = (user: PublicUser, offerId: string) =>
      http()
        .post(`/api/offers/${offerId}/withdraw`)
        .set('Authorization', auth(user))
        .send({});
    const counterBy = (user: PublicUser, offerId: string, amount: string) =>
      http()
        .post(`/api/offers/${offerId}/counter`)
        .set('Authorization', auth(user))
        .send({ amount });
    const offerAt = async (
      user: PublicUser,
      orderId: string,
      at: Record<string, unknown> = slot(),
    ) =>
      (await offer(user, orderId, offerBody(at)).expect(201)).body.id as string;
    const orderRow = (id: string) =>
      prisma.order.findUniqueOrThrow({
        where: { id },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
    /** Invariantes: a lo sumo una ACEPTADA y, si hay, es la del asignado. */
    const expectConsistent = async (orderId: string) => {
      const [order, accepted] = await Promise.all([
        prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
        prisma.offer.findMany({
          where: { orderId, status: OfferStatus.ACEPTADA },
        }),
      ]);
      expect(accepted.length).toBeLessThanOrEqual(1);
      if (order.status === OrderStatus.ACORDADO) {
        expect(accepted).toHaveLength(1);
        expect(order.assignedWorkerId).toBe(accepted[0].workerId);
      } else {
        expect(accepted).toHaveLength(0);
        expect(order.assignedWorkerId).toBeNull();
      }
    };

    it('acepta: pedido ACORDADO con el trabajador asignado, oferta ACEPTADA y las demas SIN_EFECTO', async () => {
      const orderId = await newOrder();
      const chosen = await offerAt(worker, orderId);
      const other = await offerAt(worker2, orderId);
      // Otra oferta del mismo trabajador en otro pedido no se toca.
      const elsewhereOrder = await newOrder(client2);
      const elsewhere = await offerAt(worker2, elsewhereOrder);
      const before = await orderRow(orderId);

      const res = await accept(client, chosen).expect(200);

      expect(res.body).toMatchObject({
        id: chosen,
        status: OfferStatus.ACEPTADA,
        worker: { id: worker.id },
      });
      expect(res.body.history.at(-1)).toMatchObject({
        type: 'ACEPTADA',
        round: 1,
        actorRole: RoleName.CLIENTE,
      });
      const order = await orderRow(orderId);
      expect(order).toMatchObject({
        status: OrderStatus.ACORDADO,
        assignedWorkerId: worker.id,
      });
      expect(order.publishedAt).toEqual(before.publishedAt);
      expect(order.expiresAt).toEqual(before.expiresAt);
      expect(order.statusHistory.at(-1)).toMatchObject({
        fromStatus: OrderStatus.EN_NEGOCIACION,
        toStatus: OrderStatus.ACORDADO,
        changedById: client.id,
        actorRole: RoleName.CLIENTE,
      });

      const loser = await prisma.offer.findUniqueOrThrow({
        where: { id: other },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });
      expect(loser.status).toBe(OfferStatus.SIN_EFECTO);
      expect(loser.closedAt).not.toBeNull();
      expect(loser.events.at(-1)).toMatchObject({
        type: 'SIN_EFECTO',
        actorType: 'SISTEMA',
        systemProcess: 'ACEPTACION_OFERTA',
        reason: 'El cliente aceptó otra oferta para este pedido.',
        changedById: null,
      });
      expect(
        (await prisma.offer.findUniqueOrThrow({ where: { id: elsewhere } }))
          .status,
      ).toBe(OfferStatus.VIGENTE);
      await expectConsistent(orderId);

      // El pedido acordado ya no admite operaciones de ofertas.
      await accept(client, chosen).expect(409);
      await rejectBy(client, other).expect(409);
      await offer(workerOtherCategory, orderId).expect(404);
    });

    it('acepta una oferta despues de contraofertar, en el turno del cliente', async () => {
      const orderId = await newOrder();
      const id = await offerAt(worker, orderId);
      await counterBy(client, id, '100').expect(200);
      await accept(client, id).expect(409);
      await counterBy(worker, id, '110').expect(200);

      const res = await accept(client, id).expect(200);
      expect(res.body).toMatchObject({ amount: '110.00', round: 3 });
      expect(res.body.history.at(-1)).toMatchObject({
        type: 'ACEPTADA',
        round: 3,
      });
    });

    it('solo el cliente dueno acepta', async () => {
      const orderId = await newOrder();
      const id = await offerAt(worker, orderId);
      await accept(worker, id).expect(403);
      await accept(client2, id).expect(404);
      await accept(worker2, id).expect(404);
      expect((await orderRow(orderId)).status).toBe(OrderStatus.EN_NEGOCIACION);
    });

    it('una oferta vencida o cerrada no se acepta', async () => {
      const orderId = await newOrder();
      const expired = await offerAt(worker, orderId);
      await prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired}::uuid`;
      expect(
        (await accept(client, expired).expect(409)).body.message,
      ).toContain('venció');

      const closed = await offerAt(worker2, orderId);
      await withdrawBy(worker2, closed).expect(200);
      await accept(client, closed).expect(409);
      expect((await orderRow(orderId)).assignedWorkerId).toBeNull();
    });

    it('un pedido cancelado o vencido no admite aceptar', async () => {
      const cancelled = await newOrder();
      const a = await offerAt(worker, cancelled);
      await http()
        .post(`/api/orders/me/${cancelled}/cancel`)
        .set('Authorization', auth(client))
        .send({})
        .expect(200);
      await accept(client, a).expect(409);

      const expired = await newOrder();
      const b = await offerAt(worker, expired);
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expired}::uuid`;
      expect((await accept(client, b).expect(409)).body.message).toContain(
        'VENCIDO',
      );
      expect((await orderRow(expired)).assignedWorkerId).toBeNull();
    });

    it('con la categoria o la zona inactiva no se acepta; al reactivarla si', async () => {
      const orderId = await newOrder();
      const id = await offerAt(worker, orderId);
      await prisma.serviceCategory.update({
        where: { id: catA.id },
        data: { isActive: false },
      });
      try {
        await accept(client, id).expect(409);
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
        await accept(client, id).expect(409);
      } finally {
        await prisma.zone.update({
          where: { id: zoneA.id },
          data: { isActive: true },
        });
      }
      await accept(client, id).expect(200);
    });

    it('un trabajador suspendido no puede ser asignado', async () => {
      const profiles = app.get(WorkerProfileService);
      const orderId = await newOrder();
      const id = await offerAt(worker2, orderId);
      const profile = await prisma.workerProfile.findUniqueOrThrow({
        where: { userId: worker2.id },
      });
      await profiles.changeStatusByAdmin(admin.id, profile.id, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Prueba de suspension',
      });
      try {
        await accept(client, id).expect(403);
        expect((await orderRow(orderId)).assignedWorkerId).toBeNull();
      } finally {
        await profiles.changeStatusByAdmin(admin.id, profile.id, {
          status: WorkerProfileStatus.APROBADO,
        });
      }
    });

    it('tras cambiar la categoria se acepta aunque el trabajador no tenga la nueva especialidad', async () => {
      const orderId = await newOrder();
      const id = await offerAt(worker, orderId);
      await http()
        .patch(`/api/orders/me/${orderId}`)
        .set('Authorization', auth(client))
        .send({ categoryId: catB.id })
        .expect(200);

      await accept(client, id).expect(200);
      const order = await orderRow(orderId);
      expect(order).toMatchObject({
        categoryId: catB.id,
        status: OrderStatus.ACORDADO,
        assignedWorkerId: worker.id,
      });
    });

    it('RF-30: no se asigna un trabajo que se cruza con otro acordado del trabajador', async () => {
      const at = slot();
      const firstOrder = await newOrder();
      await accept(client, await offerAt(worker, firstOrder, at)).expect(200);

      // Mismo horario en otro pedido.
      const secondOrder = await newOrder(client2);
      const clash = await offerAt(worker, secondOrder, {
        proposedStartAt: new Date(
          Date.parse(at.proposedStartAt) + 60 * 60_000,
        ).toISOString(),
        estimatedDurationMinutes: 30,
      });
      const res = await accept(client2, clash).expect(409);
      expect(res.body.message).toContain('ya tiene un trabajo acordado');
      expect(res.body.message).toContain(firstOrder);
      expect((await orderRow(secondOrder)).assignedWorkerId).toBeNull();

      // Justo despues de terminar el otro trabajo: no hay cruce.
      const thirdOrder = await newOrder(client2);
      const next = await offerAt(worker, thirdOrder, {
        proposedStartAt: new Date(
          Date.parse(at.proposedStartAt) + 120 * 60_000,
        ).toISOString(),
        estimatedDurationMinutes: 60,
      });
      await accept(client2, next).expect(200);
    });

    it('el historial de la aceptacion es inmutable', async () => {
      const orderId = await newOrder();
      const id = await offerAt(worker, orderId);
      const other = await offerAt(worker2, orderId);
      await accept(client, id).expect(200);

      await expect(
        prisma.offerEvent.updateMany({
          where: { offerId: { in: [id, other] } },
          data: { reason: 'cambio' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.offerEvent.deleteMany({ where: { offerId: id } }),
      ).rejects.toThrow();
      await expect(
        prisma.offer.update({
          where: { id: other },
          data: { status: OfferStatus.VIGENTE, closedAt: null },
        }),
      ).rejects.toThrow();
    });

    describe('concurrencia', () => {
      it('dos ofertas distintas del mismo pedido: solo una se acepta', async () => {
        const orderId = await newOrder();
        const a = await offerAt(worker, orderId);
        const b = await offerAt(worker2, orderId);

        const results = await Promise.all([
          accept(client, a),
          accept(client, b),
        ]);

        expect(results.map((res) => res.status).sort((x, y) => x - y)).toEqual([
          200, 409,
        ]);
        await expectConsistent(orderId);
        const statuses = (
          await prisma.offer.findMany({ where: { orderId } })
        ).map((row) => row.status);
        expect(statuses.sort()).toEqual([
          OfferStatus.ACEPTADA,
          OfferStatus.SIN_EFECTO,
        ]);
      });

      it('la misma oferta aceptada dos veces a la vez se acepta una sola vez', async () => {
        const orderId = await newOrder();
        const id = await offerAt(worker, orderId);

        const results = await Promise.all([
          accept(client, id),
          accept(client, id),
        ]);

        expect(results.map((res) => res.status).sort((x, y) => x - y)).toEqual([
          200, 409,
        ]);
        expect(
          await prisma.offerEvent.count({
            where: { offerId: id, type: 'ACEPTADA' },
          }),
        ).toBe(1);
        await expectConsistent(orderId);
      });

      it.each([
        ['rechazo', (id: string) => rejectBy(client, id)],
        ['retiro', (id: string) => withdrawBy(worker, id)],
        ['contraoferta', (id: string) => counterBy(client, id, '99')],
      ])(
        'aceptacion y %s simultaneos: gana una sola operacion',
        async (_case, other) => {
          const orderId = await newOrder();
          const id = await offerAt(worker, orderId);

          const [accepted, competing] = await Promise.all([
            accept(client, id),
            other(id),
          ]);

          expect(
            [accepted.status, competing.status].filter((code) => code === 200),
          ).toHaveLength(1);
          expect(
            [accepted.status, competing.status].filter((code) => code === 409),
          ).toHaveLength(1);
          await expectConsistent(orderId);
          const row = await prisma.offer.findUniqueOrThrow({
            where: { id },
          });
          const order = await orderRow(orderId);
          if (accepted.status === 200) {
            expect(row.status).toBe(OfferStatus.ACEPTADA);
            expect(order.status).toBe(OrderStatus.ACORDADO);
          } else {
            expect(row.status).not.toBe(OfferStatus.ACEPTADA);
            expect(order.status).not.toBe(OrderStatus.ACORDADO);
          }
        },
      );

      it('el mismo trabajador en dos pedidos con horarios cruzados: solo una asignacion', async () => {
        const at = slot();
        const first = await newOrder(client);
        const second = await newOrder(client2);
        const a = await offerAt(worker2, first, at);
        const b = await offerAt(worker2, second, at);

        const results = await Promise.all([
          accept(client, a),
          accept(client2, b),
        ]);

        expect(results.map((res) => res.status).sort((x, y) => x - y)).toEqual([
          200, 409,
        ]);
        const assigned = await prisma.order.count({
          where: { id: { in: [first, second] }, assignedWorkerId: worker2.id },
        });
        expect(assigned).toBe(1);
        await expectConsistent(first);
        await expectConsistent(second);
      });
    });
  });

  describe('vencimiento automatico de ofertas (T6.5.1)', () => {
    let week = 60;
    const slot = () =>
      offerBody({
        proposedStartAt: new Date(
          nextMondayAt(10).getTime() + week++ * 7 * DAY,
        ).toISOString(),
      });
    const offerId = async (user: PublicUser, orderId: string) =>
      (await offer(user, orderId, slot()).expect(201)).body.id as string;
    const expireNow = (id: string) =>
      prisma.$executeRaw`UPDATE "offers" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${id}::uuid`;
    const run = () => app.get(OfferExpirationService).expireDue();
    const row = (id: string) =>
      prisma.offer.findUniqueOrThrow({
        where: { id },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });
    const orderRow = (id: string) =>
      prisma.order.findUniqueOrThrow({
        where: { id },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
    const post = (path: string, user: PublicUser, body: object = {}) =>
      http().post(path).set('Authorization', auth(user)).send(body);
    /** Cada oferta tiene a lo sumo un cierre y el estado del pedido es coherente. */
    const expectConsistent = async (orderId: string) => {
      const offers = await prisma.offer.findMany({
        where: { orderId },
        include: { events: true },
      });
      for (const item of offers) {
        const closings = item.events.filter(
          (event) => !['PROPUESTA', 'CONTRAOFERTA'].includes(event.type),
        );
        expect(closings).toHaveLength(item.status === 'VIGENTE' ? 0 : 1);
      }
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      const open = offers.filter(
        (item) => item.status === 'VIGENTE' && item.expiresAt > new Date(),
      ).length;
      if (order.status === OrderStatus.PUBLICADO) {
        expect(open).toBe(0);
      }
      if (order.status === OrderStatus.ACORDADO) {
        expect(
          offers.filter((item) => item.status === 'ACEPTADA'),
        ).toHaveLength(1);
      }
    };

    it('vence la oferta con su evento del sistema y devuelve el pedido a PUBLICADO sin tocar su plazo', async () => {
      const orderId = await newOrder();
      const id = await offerId(worker, orderId);
      const before = await orderRow(orderId);
      await expireNow(id);

      expect(await run()).toBeGreaterThanOrEqual(1);

      const expired = await row(id);
      expect(expired.status).toBe(OfferStatus.VENCIDA);
      expect(expired.closedAt).toBeInstanceOf(Date);
      expect(expired.events.map((event) => event.type)).toEqual([
        'PROPUESTA',
        'VENCIDA',
      ]);
      expect(expired.events[1]).toMatchObject({
        round: 1,
        amount: null,
        actorType: 'SISTEMA',
        systemProcess: 'VENCIMIENTO_OFERTA',
        changedById: null,
      });
      const order = await orderRow(orderId);
      expect(order.status).toBe(OrderStatus.PUBLICADO);
      expect(order.publishedAt).toEqual(before.publishedAt);
      expect(order.expiresAt).toEqual(before.expiresAt);
      expect(order.statusHistory.at(-1)).toMatchObject({
        fromStatus: OrderStatus.EN_NEGOCIACION,
        toStatus: OrderStatus.PUBLICADO,
        actorType: 'SISTEMA',
        systemProcess: 'VENCIMIENTO_OFERTA',
      });
      // VENCIDA permite volver a ofertar.
      await offer(worker, orderId, slot()).expect(201);
    });

    it('no toca ofertas vigentes; con varias, el pedido sigue EN_NEGOCIACION hasta que vence la ultima', async () => {
      const orderId = await newOrder();
      const a = await offerId(worker, orderId);
      const b = await offerId(worker2, orderId);
      await expireNow(a);

      await run();

      expect((await row(a)).status).toBe(OfferStatus.VENCIDA);
      expect((await row(b)).status).toBe(OfferStatus.VIGENTE);
      expect((await orderRow(orderId)).status).toBe(OrderStatus.EN_NEGOCIACION);

      await expireNow(b);
      await run();
      expect((await row(b)).status).toBe(OfferStatus.VENCIDA);
      const order = await orderRow(orderId);
      expect(order.status).toBe(OrderStatus.PUBLICADO);
      expect(
        order.statusHistory.filter(
          (entry) => entry.toStatus === OrderStatus.PUBLICADO,
        ),
      ).toHaveLength(2);
    });

    it('varias ofertas del mismo pedido vencen en una sola pasada y el pedido vuelve una sola vez', async () => {
      const orderId = await newOrder();
      const a = await offerId(worker, orderId);
      const b = await offerId(worker2, orderId);
      await expireNow(a);
      await expireNow(b);

      await run();

      expect((await row(a)).status).toBe(OfferStatus.VENCIDA);
      expect((await row(b)).status).toBe(OfferStatus.VENCIDA);
      const order = await orderRow(orderId);
      expect(order.status).toBe(OrderStatus.PUBLICADO);
      expect(
        order.statusHistory.filter(
          (entry) => entry.fromStatus === OrderStatus.EN_NEGOCIACION,
        ),
      ).toHaveLength(1);
    });

    it('en un pedido cancelado o vencido cierra las ofertas sin cambiar el estado del pedido', async () => {
      const cancelled = await newOrder();
      const a = await offerId(worker, cancelled);
      await expireNow(a);
      await post(`/api/orders/me/${cancelled}/cancel`, client).expect(200);

      const expiredOrder = await newOrder();
      const b = await offerId(worker, expiredOrder);
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${expiredOrder}::uuid`;
      await expireNow(b);

      await run();

      // T6.5.2: la cancelacion ya la cerro como SIN_EFECTO; el vencimiento no
      // la vuelve a tocar.
      expect((await row(a)).status).toBe(OfferStatus.SIN_EFECTO);
      expect((await row(a)).events.at(-1)).toMatchObject({
        type: 'SIN_EFECTO',
        reason: 'PEDIDO_CANCELADO',
      });
      expect((await row(b)).status).toBe(OfferStatus.VENCIDA);
      expect((await orderRow(cancelled)).status).toBe(OrderStatus.CANCELADO);
      // Lo marca VENCIDO el vencimiento de pedidos, nunca PUBLICADO.
      expect((await orderRow(expiredOrder)).status).toBe(
        OrderStatus.EN_NEGOCIACION,
      );
    });

    it('ejecutarla otra vez no duplica eventos ni transiciones', async () => {
      const orderId = await newOrder();
      const id = await offerId(worker, orderId);
      await expireNow(id);
      await run();
      const events = await prisma.offerEvent.count({ where: { orderId } });
      const history = await prisma.orderStatusHistory.count({
        where: { orderId },
      });

      await run();
      await Promise.all([run(), run()]);

      expect(await prisma.offerEvent.count({ where: { orderId } })).toBe(
        events,
      );
      expect(
        await prisma.orderStatusHistory.count({ where: { orderId } }),
      ).toBe(history);
    });

    it('el evento de vencimiento es inmutable y la oferta no se reabre', async () => {
      const orderId = await newOrder();
      const id = await offerId(worker, orderId);
      await expireNow(id);
      await run();

      await expect(
        prisma.offerEvent.updateMany({
          where: { offerId: id, type: 'VENCIDA' },
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

    it('recupera al arrancar las ofertas que vencieron con el servidor detenido', async () => {
      const orderId = await newOrder();
      const id = await offerId(worker, orderId);
      await expireNow(id);

      // Instancia nueva, como tras un reinicio, con las tareas activas.
      const restarted = new OfferExpirationService(
        prisma,
        app.get(OffersService),
        new ConfigService({ SCHEDULED_JOBS_ENABLED: 'true' }),
        new SchedulerRegistry(),
      );
      restarted.onApplicationBootstrap();
      try {
        await vi.waitFor(
          async () => expect((await row(id)).status).toBe(OfferStatus.VENCIDA),
          { timeout: 10_000, interval: 100 },
        );
      } finally {
        restarted.onModuleDestroy();
      }
      expect((await orderRow(orderId)).status).toBe(OrderStatus.PUBLICADO);
    });

    describe('concurrencia', () => {
      it.each([
        ['aceptacion', (b: string) => post(`/api/offers/${b}/accept`, client)],
        ['rechazo', (b: string) => post(`/api/offers/${b}/reject`, client)],
        ['retiro', (b: string) => post(`/api/offers/${b}/withdraw`, worker2)],
        [
          'contraoferta',
          (b: string) =>
            post(`/api/offers/${b}/counter`, client, { amount: '99' }),
        ],
      ])(
        'vencimiento y %s de otra oferta del pedido: cada oferta se cierra una sola vez',
        async (_case, operation) => {
          const orderId = await newOrder();
          const a = await offerId(worker, orderId);
          const b = await offerId(worker2, orderId);
          await expireNow(a);

          const [, res] = await Promise.all([run(), operation(b)]);

          expect(res.status).toBe(200);
          await expectConsistent(orderId);
          expect((await row(a)).status).not.toBe(OfferStatus.VIGENTE);
        },
      );

      it.each([
        ['aceptar', (a: string) => post(`/api/offers/${a}/accept`, client)],
        ['rechazar', (a: string) => post(`/api/offers/${a}/reject`, client)],
        ['retirar', (a: string) => post(`/api/offers/${a}/withdraw`, worker)],
        [
          'contraofertar',
          (a: string) =>
            post(`/api/offers/${a}/counter`, client, { amount: '99' }),
        ],
      ])(
        'una oferta vencida no se puede %s mientras corre el vencimiento',
        async (_case, operation) => {
          const orderId = await newOrder();
          const a = await offerId(worker, orderId);
          await expireNow(a);

          const [, res] = await Promise.all([run(), operation(a)]);

          expect(res.status).toBe(409);
          const expired = await row(a);
          expect(expired.status).toBe(OfferStatus.VENCIDA);
          expect(
            expired.events.filter((event) => event.type === 'VENCIDA'),
          ).toHaveLength(1);
          expect((await orderRow(orderId)).status).toBe(OrderStatus.PUBLICADO);
        },
      );

      it('vencimiento mientras llega una oferta nueva: el pedido nunca queda PUBLICADO con ofertas vigentes', async () => {
        for (let i = 0; i < 3; i++) {
          const orderId = await newOrder();
          const a = await offerId(worker, orderId);
          await expireNow(a);

          const [, created] = await Promise.all([
            run(),
            offer(worker2, orderId, slot()),
          ]);

          expect(created.status).toBe(201);
          await expectConsistent(orderId);
          expect((await orderRow(orderId)).status).toBe(
            OrderStatus.EN_NEGOCIACION,
          );
        }
      });
    });
  });

  describe('cierres por cambios externos (T6.5.2)', () => {
    let week = 120;
    const slot = () =>
      offerBody({
        proposedStartAt: new Date(
          nextMondayAt(10).getTime() + week++ * 7 * DAY,
        ).toISOString(),
      });
    const offerId = async (user: PublicUser, orderId: string) =>
      (await offer(user, orderId, slot()).expect(201)).body.id as string;
    const post = (path: string, user: PublicUser, body: object = {}) =>
      http().post(path).set('Authorization', auth(user)).send(body);
    const setAccount = (user: PublicUser, status: 'SUSPENDIDO' | 'ACTIVO') =>
      http()
        .patch(`/api/users/${user.id}/status`)
        .set('Authorization', auth(admin))
        .send({ status });
    const setProfile = async (
      user: PublicUser,
      status: 'SUSPENDIDO' | 'APROBADO',
    ) => {
      const profile = await prisma.workerProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      await app.get(WorkerProfileService).changeStatusByAdmin(
        admin.id,
        profile.id,
        status === 'SUSPENDIDO'
          ? {
              status: WorkerProfileStatus.SUSPENDIDO,
              reason: 'Prueba T6.5.2',
            }
          : { status: WorkerProfileStatus.APROBADO },
      );
    };
    const row = (id: string) =>
      prisma.offer.findUniqueOrThrow({
        where: { id },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });
    const orderRow = (id: string) =>
      prisma.order.findUniqueOrThrow({
        where: { id },
        include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
      });
    const expectClosed = async (
      id: string,
      status: OfferStatus,
      reason: string,
    ) => {
      const closed = await row(id);
      expect(closed.status).toBe(status);
      expect(closed.closedAt).toBeInstanceOf(Date);
      const closings = closed.events.filter(
        (event) => !['PROPUESTA', 'CONTRAOFERTA'].includes(event.type),
      );
      expect(closings).toHaveLength(1);
      expect(closings[0]).toMatchObject({
        type: status,
        actorType: 'SISTEMA',
        systemProcess: 'CIERRE_OFERTAS',
        reason,
        changedById: null,
      });
    };
    /** Ninguna operacion de usuario vale sobre una oferta cerrada. */
    const expectFrozen = async (
      id: string,
      owner: PublicUser,
      from: PublicUser,
    ) => {
      await post(`/api/offers/${id}/accept`, owner).expect((res) =>
        expect([403, 404, 409]).toContain(res.status),
      );
      await post(`/api/offers/${id}/counter`, owner, { amount: '99' }).expect(
        (res) => expect([403, 404, 409]).toContain(res.status),
      );
      await post(`/api/offers/${id}/reject`, owner).expect((res) =>
        expect([403, 404, 409]).toContain(res.status),
      );
      await post(`/api/offers/${id}/withdraw`, from).expect((res) =>
        expect([403, 404, 409]).toContain(res.status),
      );
    };

    it('cancelar el pedido deja SIN_EFECTO todas sus ofertas vigentes, sin tocar las ya cerradas', async () => {
      const single = await newOrder();
      const only = await offerId(worker, single);
      await post(`/api/orders/me/${single}/cancel`, client).expect(200);
      await expectClosed(only, OfferStatus.SIN_EFECTO, 'PEDIDO_CANCELADO');

      const multi = await newOrder();
      const a = await offerId(worker, multi);
      const b = await offerId(worker2, multi);
      const withdrawn = await offerId(workerOtherCategory, multi).catch(
        () => null,
      );
      expect(withdrawn).toBeNull(); // otra especialidad: no ve el pedido
      await post(`/api/offers/${b}/withdraw`, worker2).expect(200);
      const withdrawnBefore = await row(b);
      const before = await orderRow(multi);

      await post(`/api/orders/me/${multi}/cancel`, client).expect(200);

      await expectClosed(a, OfferStatus.SIN_EFECTO, 'PEDIDO_CANCELADO');
      const untouched = await row(b);
      expect(untouched.status).toBe(OfferStatus.RETIRADA);
      expect(untouched.events).toHaveLength(withdrawnBefore.events.length);
      expect(untouched.closedAt).toEqual(withdrawnBefore.closedAt);
      const order = await orderRow(multi);
      expect(order.status).toBe(OrderStatus.CANCELADO);
      expect(order.publishedAt).toEqual(before.publishedAt);
      expect(order.expiresAt).toEqual(before.expiresAt);
      // Solo la transicion de la cancelacion.
      expect(order.statusHistory.length).toBe(before.statusHistory.length + 1);
      await expectFrozen(a, client, worker);
    });

    it('al vencer el pedido sus ofertas vigentes quedan VENCIDA con motivo PEDIDO_VENCIDO', async () => {
      const single = await newOrder();
      const only = await offerId(worker, single);
      const multi = await newOrder();
      const a = await offerId(worker, multi);
      const b = await offerId(worker2, multi);
      await post(`/api/offers/${b}/withdraw`, worker2).expect(200);
      const bBefore = await row(b);
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" IN (${single}::uuid, ${multi}::uuid)`;
      const before = await orderRow(multi);

      await app.get(OrderExpirationService).expireDue();

      await expectClosed(only, OfferStatus.VENCIDA, 'PEDIDO_VENCIDO');
      await expectClosed(a, OfferStatus.VENCIDA, 'PEDIDO_VENCIDO');
      expect((await row(b)).events).toHaveLength(bBefore.events.length);
      const order = await orderRow(multi);
      expect(order.status).toBe(OrderStatus.VENCIDO);
      expect(order.expiresAt).toEqual(before.expiresAt);
      expect(order.statusHistory.at(-1)).toMatchObject({
        fromStatus: OrderStatus.EN_NEGOCIACION,
        toStatus: OrderStatus.VENCIDO,
      });
      expect(
        order.statusHistory.filter(
          (entry) => entry.toStatus === OrderStatus.PUBLICADO,
        ),
      ).toHaveLength(1); // solo la creacion
      await expectFrozen(a, client, worker);
    });

    it('suspender al cliente deja SIN_EFECTO las ofertas de todos sus pedidos y no toca las de otros clientes', async () => {
      const first = await newOrder(client2);
      const second = await newOrder(client2);
      const a = await offerId(worker, first);
      const b = await offerId(worker2, first);
      const c = await offerId(worker, second);
      const otherClientOrder = await newOrder(client);
      const other = await offerId(worker, otherClientOrder);

      await setAccount(client2, 'SUSPENDIDO').expect(200);
      try {
        for (const id of [a, b, c]) {
          await expectClosed(id, OfferStatus.SIN_EFECTO, 'CLIENTE_SUSPENDIDO');
        }
        expect((await row(other)).status).toBe(OfferStatus.VIGENTE);
        expect((await orderRow(first)).status).toBe(OrderStatus.PUBLICADO);
        expect((await orderRow(second)).status).toBe(OrderStatus.PUBLICADO);
        expect((await orderRow(first)).statusHistory.at(-1)).toMatchObject({
          toStatus: OrderStatus.PUBLICADO,
          actorType: 'SISTEMA',
          systemProcess: 'CIERRE_OFERTAS',
        });

        // Repetir la suspension no duplica cierres ni historial.
        const events = await prisma.offerEvent.count({
          where: { orderId: { in: [first, second] } },
        });
        await setAccount(client2, 'SUSPENDIDO').expect(200);
        await prisma.$transaction((tx) =>
          app.get(OffersService).closeOffersOfSuspendedAccount(tx, client2.id),
        );
        expect(
          await prisma.offerEvent.count({
            where: { orderId: { in: [first, second] } },
          }),
        ).toBe(events);
      } finally {
        await setAccount(client2, 'ACTIVO').expect(200);
      }
      // Reactivar no reabre las ofertas.
      expect((await row(a)).status).toBe(OfferStatus.SIN_EFECTO);
    });

    it('suspender la cuenta del trabajador cierra solo sus ofertas, en distintos pedidos', async () => {
      const shared = await newOrder(client);
      const alone = await newOrder(client2);
      const mine = await offerId(worker2, shared);
      const theirs = await offerId(worker, shared);
      const mineAlone = await offerId(worker2, alone);

      await setAccount(worker2, 'SUSPENDIDO').expect(200);
      try {
        await expectClosed(
          mine,
          OfferStatus.SIN_EFECTO,
          'TRABAJADOR_SUSPENDIDO',
        );
        await expectClosed(
          mineAlone,
          OfferStatus.SIN_EFECTO,
          'TRABAJADOR_SUSPENDIDO',
        );
        expect((await row(theirs)).status).toBe(OfferStatus.VIGENTE);
        expect((await orderRow(shared)).status).toBe(
          OrderStatus.EN_NEGOCIACION,
        );
        expect((await orderRow(alone)).status).toBe(OrderStatus.PUBLICADO);
      } finally {
        await setAccount(worker2, 'ACTIVO').expect(200);
      }
      await expectFrozen(mine, client, worker2);
    });

    it('suspender el perfil del trabajador deja SIN_EFECTO sus ofertas con motivo PERFIL_SUSPENDIDO', async () => {
      const first = await newOrder(client);
      const second = await newOrder(client2);
      const a = await offerId(worker2, first);
      const b = await offerId(worker2, second);
      const theirs = await offerId(worker, first);

      await setProfile(worker2, 'SUSPENDIDO');
      try {
        await expectClosed(a, OfferStatus.SIN_EFECTO, 'PERFIL_SUSPENDIDO');
        await expectClosed(b, OfferStatus.SIN_EFECTO, 'PERFIL_SUSPENDIDO');
        expect((await row(theirs)).status).toBe(OfferStatus.VIGENTE);
        expect((await orderRow(first)).status).toBe(OrderStatus.EN_NEGOCIACION);
        expect((await orderRow(second)).status).toBe(OrderStatus.PUBLICADO);
      } finally {
        await setProfile(worker2, 'APROBADO');
      }
      expect((await row(a)).status).toBe(OfferStatus.SIN_EFECTO);
    });

    it('el historial de los cierres sigue protegido', async () => {
      const orderId = await newOrder();
      const id = await offerId(worker, orderId);
      await post(`/api/orders/me/${orderId}/cancel`, client).expect(200);

      await expect(
        prisma.offerEvent.updateMany({
          where: { offerId: id, type: 'SIN_EFECTO' },
          data: { reason: 'otro' },
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

    describe('concurrencia con la suspension del trabajador', () => {
      it.each([
        [
          'aceptacion',
          (id: string) => post(`/api/offers/${id}/accept`, client),
        ],
        [
          'contraoferta',
          (id: string) =>
            post(`/api/offers/${id}/counter`, client, { amount: '99' }),
        ],
        ['rechazo', (id: string) => post(`/api/offers/${id}/reject`, client)],
        ['retiro', (id: string) => post(`/api/offers/${id}/withdraw`, worker2)],
      ])(
        'suspension y %s simultaneos: un solo cierre y estado coherente',
        async (_case, operation) => {
          const orderId = await newOrder();
          const id = await offerId(worker2, orderId);
          try {
            const [suspended, res] = await Promise.all([
              setAccount(worker2, 'SUSPENDIDO'),
              operation(id),
            ]);
            expect(suspended.status).toBe(200);
            expect([200, 401, 403, 409]).toContain(res.status);

            const offerRow = await row(id);
            const closings = offerRow.events.filter(
              (event) => !['PROPUESTA', 'CONTRAOFERTA'].includes(event.type),
            );
            expect(closings.length).toBeLessThanOrEqual(1);
            const order = await orderRow(orderId);
            if (offerRow.status === OfferStatus.ACEPTADA) {
              // La aceptacion se confirmo antes de la suspension.
              expect(order.status).toBe(OrderStatus.ACORDADO);
              expect(order.assignedWorkerId).toBe(worker2.id);
            } else {
              expect(offerRow.status).not.toBe(OfferStatus.VIGENTE);
              expect(order.assignedWorkerId).toBeNull();
              expect(order.status).toBe(OrderStatus.PUBLICADO);
            }
          } finally {
            await setAccount(worker2, 'ACTIVO').expect(200);
          }
        },
      );
    });
  });

  describe('contacto por WhatsApp (T6.6)', () => {
    let week = 180;
    const slot = () =>
      offerBody({
        proposedStartAt: new Date(
          nextMondayAt(10).getTime() + week++ * 7 * DAY,
        ).toISOString(),
      });
    const ref = (orderId: string) =>
      orderId.replace(/-/g, '').slice(0, 8).toUpperCase();
    const asClient = (user: PublicUser, offerId: string) =>
      http()
        .get(`/api/offers/received/${offerId}/whatsapp`)
        .set('Authorization', auth(user));
    const asWorker = (user: PublicUser, offerId: string) =>
      http()
        .get(`/api/offers/me/${offerId}/whatsapp`)
        .set('Authorization', auth(user));
    const setPhone = (user: PublicUser, phone: string | null) =>
      prisma.user.update({ where: { id: user.id }, data: { phone } });
    let orderId: string;
    let offerId: string;

    beforeAll(async () => {
      orderId = await newOrder();
      offerId = (await offer(worker, orderId, slot()).expect(201)).body.id;
    });

    it('el cliente del pedido obtiene el enlace para escribir al trabajador', async () => {
      const res = await asClient(client, offerId).expect(200);

      expect(res.body).toEqual({
        available: true,
        channel: 'WHATSAPP',
        contactRole: 'TRABAJADOR',
        url: `https://wa.me/59171000001?text=${encodeURIComponent(
          `Hola, te escribo por tu oferta para mi pedido ${ref(orderId)} en ArreglaloYA.`,
        )}`,
      });
      const url = new URL(res.body.url);
      expect(url.pathname).toMatch(/^\/\d+$/);
    });

    it('el trabajador de la oferta obtiene el enlace del cliente, con el numero normalizado', async () => {
      // Numero local guardado sin codigo de pais: se agrega 591.
      await setPhone(client, '71234567');
      try {
        const res = await asWorker(worker, offerId).expect(200);
        expect(res.body).toMatchObject({
          available: true,
          contactRole: 'CLIENTE',
        });
        expect(res.body.url).toBe(
          `https://wa.me/59171234567?text=${encodeURIComponent(
            `Hola, te escribo por mi oferta para tu pedido ${ref(orderId)} en ArreglaloYA.`,
          )}`,
        );
      } finally {
        await setPhone(client, null);
      }
    });

    it('sin telefono o con uno invalido no hay enlace: resultado controlado', async () => {
      const missing = await asWorker(worker, offerId).expect(200);
      expect(missing.body).toEqual({
        available: false,
        channel: 'WHATSAPP',
        contactRole: 'CLIENTE',
        url: null,
        reason: 'TELEFONO_NO_REGISTRADO',
      });

      // Fijo de 7 digitos: valido para el registro, no para WhatsApp.
      await setPhone(client, '4123456');
      try {
        const invalid = await asWorker(worker, offerId).expect(200);
        expect(invalid.body).toMatchObject({
          available: false,
          url: null,
          reason: 'TELEFONO_INVALIDO',
        });
      } finally {
        await setPhone(client, null);
      }
    });

    it('usuarios ajenos no obtienen contactos (404) y los roles se respetan (403)', async () => {
      await asClient(client2, offerId).expect(404);
      await asWorker(worker2, offerId).expect(404);
      // El cliente no tiene el rol de trabajador.
      await asWorker(client, offerId).expect(403);
      // El trabajador tiene rol CLIENTE pero no es el dueno del pedido.
      await asClient(worker, offerId).expect(404);
    });

    it('un visitante no puede obtener contactos (401)', async () => {
      await http().get(`/api/offers/received/${offerId}/whatsapp`).expect(401);
      await http().get(`/api/offers/me/${offerId}/whatsapp`).expect(401);
    });

    it('una oferta de otro pedido no da acceso al contacto', async () => {
      const foreignOrder = await newOrder(client2);
      const foreign = (await offer(worker2, foreignOrder, slot()).expect(201))
        .body.id;
      await asClient(client, foreign).expect(404);
      await asWorker(worker, foreign).expect(404);
      await asClient(client2, foreign).expect(200);
    });

    it('los listados y detalles de ofertas no exponen telefonos', async () => {
      await setPhone(client, '+59176543210');
      try {
        const responses = await Promise.all([
          http()
            .get('/api/offers/received')
            .query({ orderId })
            .set('Authorization', auth(client)),
          http()
            .get(`/api/offers/received/${offerId}`)
            .set('Authorization', auth(client)),
          http()
            .get('/api/offers/me')
            .query({ limit: 50 })
            .set('Authorization', auth(worker)),
          http()
            .get(`/api/offers/me/${offerId}`)
            .set('Authorization', auth(worker)),
          http()
            .get(`/api/orders/available/${orderId}`)
            .set('Authorization', auth(worker2)),
        ]);
        for (const res of responses) {
          expect(res.status).toBe(200);
          const json = JSON.stringify(res.body);
          expect(json).not.toMatch(/phone|wa\.me|71000001|76543210/i);
        }
      } finally {
        await setPhone(client, null);
      }
    });

    it('consultar el contacto no cambia la oferta; una oferta cerrada ya no entrega el contacto ni admite negociacion', async () => {
      const closedOrder = await newOrder();
      const closed = (await offer(worker, closedOrder, slot()).expect(201)).body
        .id;
      const before = await prisma.offer.findUniqueOrThrow({
        where: { id: closed },
        include: { events: true },
      });

      await asClient(client, closed).expect(200);
      const after = await prisma.offer.findUniqueOrThrow({
        where: { id: closed },
        include: { events: true },
      });
      expect(after.status).toBe(before.status);
      expect(after.events).toHaveLength(before.events.length);
      expect(after.updatedAt).toEqual(before.updatedAt);

      await http()
        .post(`/api/offers/${closed}/withdraw`)
        .set('Authorization', auth(worker))
        .send({})
        .expect(200);
      // El detalle sigue disponible, pero ya no se entrega el telefono.
      await http()
        .get(`/api/offers/received/${closed}`)
        .set('Authorization', auth(client))
        .expect(200);
      const denied = await asClient(client, closed).expect(409);
      expect(JSON.stringify(denied.body)).not.toContain('wa.me');
      await asWorker(worker, closed).expect(409);
      await http()
        .post(`/api/offers/${closed}/accept`)
        .set('Authorization', auth(client))
        .send({})
        .expect(409);
      await http()
        .post(`/api/offers/${closed}/counter`)
        .set('Authorization', auth(client))
        .send({ amount: '90' })
        .expect(409);
    });
  });

  describe('ajustes previos a Angular: G1, G2 y G4 (T6.7)', () => {
    let week = 240;
    const startAt = () =>
      new Date(nextMondayAt(10).getTime() + week++ * 7 * DAY);
    /** Misma hora en La Paz (UTC-4) con offset explicito. */
    const laPaz = (date: Date) =>
      new Date(date.getTime() - 4 * 60 * 60_000).toISOString().slice(0, 19) +
      '-04:00';
    const get = (path: string, user?: PublicUser) => {
      const req = http().get(path);
      return user ? req.set('Authorization', auth(user)) : req;
    };

    describe('G1: proposedStartAt exige zona horaria', () => {
      it.each([
        ['sin zona', (d: Date) => d.toISOString().slice(0, 19)],
        ['solo la fecha', (d: Date) => d.toISOString().slice(0, 10)],
        ['separador con espacio', (d: Date) => laPaz(d).replace('T', ' ')],
      ])('rechaza una fecha %s (400)', async (_case, format) => {
        const orderId = await newOrder();
        const res = await offer(
          worker,
          orderId,
          offerBody({ proposedStartAt: format(startAt()) }),
        ).expect(400);
        expect(JSON.stringify(res.body.message)).toContain(
          'proposedStartAt debe incluir fecha, hora y zona horaria',
        );
        expect(await prisma.offer.count({ where: { orderId } })).toBe(0);
      });

      it('acepta -04:00 y Z, y ambas representan el mismo instante', async () => {
        const at = startAt();
        const first = await newOrder();
        const withOffset = await offer(
          worker,
          first,
          offerBody({ proposedStartAt: laPaz(at) }),
        ).expect(201);
        const second = await newOrder();
        const withZ = await offer(
          worker,
          second,
          offerBody({ proposedStartAt: at.toISOString() }),
        ).expect(201);
        expect(withOffset.body.proposedStartAt).toBe(at.toISOString());
        expect(withZ.body.proposedStartAt).toBe(at.toISOString());
      });
    });

    describe('G2: pedido acordado para el trabajador asignado', () => {
      let orderId: string;
      let otherOfferId: string;

      beforeAll(async () => {
        orderId = await newOrder();
        const chosen = (
          await offer(
            worker,
            orderId,
            offerBody({ proposedStartAt: startAt().toISOString() }),
          ).expect(201)
        ).body.id;
        otherOfferId = (
          await offer(
            worker2,
            orderId,
            offerBody({ proposedStartAt: startAt().toISOString() }),
          ).expect(201)
        ).body.id;
        // Antes de aceptar, el pedido no es "asignado" para nadie.
        await get(`/api/orders/assigned/${orderId}`, worker).expect(404);
        await http()
          .post(`/api/offers/${chosen}/accept`)
          .set('Authorization', auth(client))
          .send({})
          .expect(200);
      });

      it('el trabajador asignado ve descripcion, fotos, direccion y nombre del cliente', async () => {
        const res = await get(`/api/orders/assigned/${orderId}`, worker).expect(
          200,
        );

        expect(res.body).toMatchObject({
          id: orderId,
          status: OrderStatus.ACORDADO,
          category: { id: catA.id },
          zone: { id: zoneA.id },
          description: 'Fuga de agua debajo del lavaplatos de la cocina',
          budgetAmount: '150.00',
          address: { addressLine: 'Av. Siempre Viva 742', reference: null },
          client: { firstName: 'client', lastName: 'E2E' },
        });
        expect(res.body.images).toHaveLength(1);
        // Sin datos de contacto ni campos internos.
        expect(JSON.stringify(res.body)).not.toMatch(
          /email|phone|clientId|assignedWorkerId|passwordHash/,
        );

        const image = await get(
          `/api/orders/assigned/${orderId}/images/${res.body.images[0].id}?variant=thumb`,
          worker,
        ).expect(200);
        expect(image.headers['content-type']).toBe('image/webp');
        expect(image.headers['cache-control']).toBe('private, no-store');
      });

      it('el cliente dueno conserva su acceso con la direccion', async () => {
        const res = await get(`/api/orders/me/${orderId}`, client).expect(200);
        expect(res.body).toMatchObject({
          status: OrderStatus.ACORDADO,
          address: { addressLine: 'Av. Siempre Viva 742' },
        });
      });

      it('otros trabajadores reciben 404, tambien en las fotos', async () => {
        const res = await get(`/api/orders/assigned/${orderId}`, worker).expect(
          200,
        );
        const imageId = res.body.images[0].id;
        for (const other of [worker2, workerOtherCategory, workerPending]) {
          await get(`/api/orders/assigned/${orderId}`, other).expect(404);
          await get(
            `/api/orders/assigned/${orderId}/images/${imageId}`,
            other,
          ).expect(404);
        }
        // La oferta del otro trabajador quedo SIN_EFECTO y no da acceso.
        expect(
          (
            await prisma.offer.findUniqueOrThrow({
              where: { id: otherOfferId },
            })
          ).status,
        ).toBe(OfferStatus.SIN_EFECTO);
      });

      it('visitantes (401) y cuentas sin rol de trabajador (403) no acceden', async () => {
        await get(`/api/orders/assigned/${orderId}`).expect(401);
        await get(
          `/api/orders/assigned/${orderId}/images/${randomUUID()}`,
        ).expect(401);
        await get(`/api/orders/assigned/${orderId}`, client).expect(403);
      });

      it('una foto de otro pedido no se abre aunque el pedido sea del asignado', async () => {
        const foreign = await newOrder(client2);
        const foreignImage = (
          await get(`/api/orders/me/${foreign}`, client2).expect(200)
        ).body.images[0].id;
        await get(
          `/api/orders/assigned/${orderId}/images/${foreignImage}`,
          worker,
        ).expect(404);
      });

      it('las reglas de pedidos disponibles no cambian y los listados no exponen la direccion', async () => {
        // Con acuerdo, el pedido ya no esta disponible para nadie.
        await get(`/api/orders/available/${orderId}`, worker).expect(404);
        const list = await get('/api/orders/available?limit=50', worker).expect(
          200,
        );
        expect(JSON.stringify(list.body)).not.toMatch(/address|Siempre Viva/i);
        const offers = await get('/api/offers/me?limit=50', worker).expect(200);
        expect(JSON.stringify(offers.body)).not.toMatch(
          /address|Siempre Viva/i,
        );
      });
    });

    describe('G4: historial sin changedById', () => {
      it('el historial publico no expone changedById; la BD lo conserva', async () => {
        const orderId = await newOrder();
        const created = await offer(
          worker,
          orderId,
          offerBody({ proposedStartAt: startAt().toISOString() }),
        ).expect(201);
        await http()
          .post(`/api/offers/${created.body.id}/counter`)
          .set('Authorization', auth(client))
          .send({ amount: '100' })
          .expect(200);

        const responses = await Promise.all([
          get(`/api/offers/me/${created.body.id}`, worker),
          get(`/api/offers/received/${created.body.id}`, client),
        ]);
        for (const res of responses) {
          expect(res.status).toBe(200);
          expect(res.body.history).toHaveLength(2);
          for (const event of res.body.history) {
            expect(Object.keys(event).sort()).toEqual([
              'actorRole',
              'actorType',
              'amount',
              'createdAt',
              'reason',
              'round',
              'systemProcess',
              'type',
            ]);
          }
          expect(
            res.body.history.map(
              (event: { actorRole: string }) => event.actorRole,
            ),
          ).toEqual([RoleName.TRABAJADOR, RoleName.CLIENTE]);
        }
        const stored = await prisma.offerEvent.findMany({
          where: { offerId: created.body.id },
          orderBy: { round: 'asc' },
        });
        expect(stored.map((event) => event.changedById)).toEqual([
          worker.id,
          client.id,
        ]);
      });
    });
  });
});
