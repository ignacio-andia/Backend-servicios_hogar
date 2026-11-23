import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
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
  OrderStatus,
  Prisma,
  RoleName,
  UserStatus,
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
import { OrderExpirationService } from '../src/modules/orders/order-expiration.service.js';
import { clientActor } from '../src/modules/orders/order-history.js';
import {
  OrderLifecycleEvent,
  OrderLifecycleRegistry,
} from '../src/modules/orders/order-lifecycle.registry.js';
import {
  OrderTransitionRequest,
  OrderTransitionUsageError,
} from '../src/modules/orders/order-transition.js';
import { OrderVisibilityService } from '../src/modules/orders/order-visibility.service.js';
import { OrdersConfig } from '../src/modules/orders/orders.config.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from '../src/modules/worker-profile/active-work.registry.js';
import { WorkerProfileService } from '../src/modules/worker-profile/worker-profile.service.js';
import { ZoneChangeRequestsService } from '../src/modules/worker-profile/zone-change-requests.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FileStorage } from '../src/storage/file-storage.js';
import { deleteOrderData } from './utils/orders-cleanup.js';
import { deleteWorkerData } from './utils/worker-profile-cleanup.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@orders-e2e.test';
const label = (text: string) => `${text} ${RUN_ID}`;
const BASE = '/api/orders';
const NAMESPACE = 'order-images';

const photo = (width = 800, height = 600, color = '#3366aa') =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .withExif({
      IFD0: { Artist: 'Cliente de prueba' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '17/1 23/1 0/1' },
    })
    .toBuffer();

describe('OrdersModule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let storageDir: string;
  let catalogs: CatalogsService;

  let client: PublicUser;
  let client2: PublicUser;
  let admin: PublicUser;
  let worker: PublicUser;
  let workerOtherZone: PublicUser;
  let workerOtherCategory: PublicUser;
  let workerPending: PublicUser;
  let catA: CatalogItem;
  let catB: CatalogItem;
  let catOff: CatalogItem;
  let zoneA: CatalogItem;
  let zoneB: CatalogItem;

  let jpeg: Buffer;
  let orderId: string;

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const orderFields = (overrides: Record<string, string | undefined> = {}) => ({
    categoryId: catA.id,
    zoneId: zoneA.id,
    description: 'Fuga de agua debajo del lavaplatos de la cocina',
    budgetAmount: '150.50',
    addressLine: 'Av. Siempre Viva 742',
    addressReference: 'Portón verde',
    ...overrides,
  });
  const createOrder = (
    user: PublicUser,
    fields: Record<string, string | undefined> = orderFields(),
    images: { content: Buffer; name: string }[] = [
      { content: jpeg, name: 'foto.jpg' },
    ],
  ) => {
    const req = http().post(BASE).set('Authorization', auth(user));
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) req.field(key, value);
    }
    for (const image of images) {
      req.attach('images', image.content, { filename: image.name });
    }
    return req;
  };
  const filesOnDisk = async () =>
    readdir(path.join(storageDir, NAMESPACE)).catch(() => [] as string[]);

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'orders-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    catalogs = app.get(CatalogsService);
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
    client = await newUser('client');
    client2 = await newUser('client2');
    admin = await newUser('admin');
    worker = await newUser('worker', '70000001');
    workerOtherZone = await newUser('worker-zona', '70000002');
    workerOtherCategory = await newUser('worker-cat', '70000003');
    workerPending = await newUser('worker-pend', '70000004');
    await prisma.userRole.create({
      data: { userId: admin.id, role: RoleName.ADMINISTRADOR },
    });
    // Cuenta solo administradora (sin rol CLIENTE).
    await prisma.userRole.delete({
      where: { userId_role: { userId: admin.id, role: RoleName.CLIENTE } },
    });

    const newCatalog = (kind: CatalogKind, name: string) =>
      catalogs.create(kind, admin.id, { name: label(name) });
    catA = await newCatalog(CatalogKind.CATEGORY, 'Plomeria');
    catB = await newCatalog(CatalogKind.CATEGORY, 'Electricidad');
    catOff = await newCatalog(CatalogKind.CATEGORY, 'Inactiva');
    await catalogs.deactivate(CatalogKind.CATEGORY, admin.id, catOff.id);
    zoneA = await newCatalog(CatalogKind.ZONE, 'Norte');
    zoneB = await newCatalog(CatalogKind.ZONE, 'Sur');

    // Trabajadores con perfil real: se registran, envian y (algunos) se aprueban.
    const newWorker = async (
      user: PublicUser,
      zoneId: string,
      categoryId: string,
      approve: boolean,
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
    await newWorker(worker, zoneA.id, catA.id, true);
    await newWorker(workerOtherZone, zoneB.id, catA.id, true);
    await newWorker(workerOtherCategory, zoneA.id, catB.id, true);
    await newWorker(workerPending, zoneA.id, catA.id, false);

    jpeg = await photo();
  });

  afterAll(async () => {
    const userIds = [
      client,
      client2,
      admin,
      worker,
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

  describe('RF-14: creacion', () => {
    it('crea el pedido PUBLICADO con fotos procesadas y vencimiento a los 7 días (T5.1)', async () => {
      const second = await photo(3000, 2000, '#aa3300');
      const res = await createOrder(client, orderFields(), [
        { content: jpeg, name: 'foto1.jpg' },
        { content: second, name: 'foto2.png' },
      ]).expect(201);

      const order = res.body.order;
      expect(order).toMatchObject({
        status: OrderStatus.PUBLICADO,
        category: { id: catA.id },
        zone: { id: zoneA.id },
        budgetAmount: '150.50',
        address: {
          addressLine: 'Av. Siempre Viva 742',
          reference: 'Portón verde',
        },
        revision: 1,
        canEdit: true,
        canCancel: true,
      });
      expect(order.images).toHaveLength(2);
      expect(order.images[1]).toMatchObject({ width: 1600, height: 1067 });
      expect(res.body.warnings).toEqual([]);
      // T5.1: vence exactamente 7 dias calendario despues de publicarse.
      expect(
        new Date(order.expiresAt).getTime() -
          new Date(order.publishedAt).getTime(),
      ).toBe(7 * 24 * 60 * 60 * 1000);
      orderId = order.id;

      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId },
      });
      expect(history).toMatchObject([
        {
          fromStatus: null,
          toStatus: OrderStatus.PUBLICADO,
          actorType: 'USUARIO',
          changedById: client.id,
          actorRole: RoleName.CLIENTE,
        },
      ]);
    });

    it('guarda solo WebP sin metadatos, con nombres aleatorios', async () => {
      const stored = await filesOnDisk();
      expect(stored).toHaveLength(4);
      const storage = app.get(FileStorage);
      const images = await prisma.orderImage.findMany({ where: { orderId } });
      for (const image of images) {
        const chunks: Buffer[] = [];
        for await (const chunk of await storage.read(image.storageKey)) {
          chunks.push(chunk as Buffer);
        }
        const meta = await sharp(Buffer.concat(chunks)).metadata();
        expect(meta).toMatchObject({ format: 'webp' });
        expect(meta.exif).toBeUndefined();
        expect(image.storageKey).not.toContain('foto');
      }
    });

    it.each([
      ['sin categoria', { categoryId: undefined }],
      ['sin zona', { zoneId: undefined }],
      ['sin direccion', { addressLine: undefined }],
      ['descripcion corta', { description: 'Fuga' }],
      ['descripcion larga', { description: 'x'.repeat(2001) }],
      ['monto cero', { budgetAmount: '0.00' }],
      ['monto con 3 decimales', { budgetAmount: '10.555' }],
      ['un estado', { status: 'ACORDADO' }],
    ])('responde 400 %s', async (_label, override) => {
      await createOrder(client, orderFields(override)).expect(400);
    });

    it('exige entre 1 y 3 fotografias', async () => {
      await createOrder(client, orderFields(), []).expect(400);
      const four = Array.from({ length: 4 }, (_, i) => ({
        content: jpeg,
        name: `f${i}.jpg`,
      }));
      const res = await createOrder(client, orderFields(), four).expect(400);
      expect(res.body.message).toBe(
        'Debe adjuntar entre 1 y 3 fotografías en el campo "images"',
      );
    });

    it('rechaza formatos no permitidos y extensiones falsas', async () => {
      const gif = await sharp({
        create: { width: 20, height: 20, channels: 3, background: '#000' },
      })
        .gif()
        .toBuffer();
      const notAnImage = Buffer.from('MZ esto no es una foto');

      const format = await createOrder(client, orderFields(), [
        { content: gif, name: 'foto.jpg' },
      ]).expect(400);
      expect(format.body.message).toContain('Formato de imagen no permitido');
      const fake = await createOrder(client, orderFields(), [
        { content: notAnImage, name: 'foto.jpg' },
      ]).expect(400);
      expect(fake.body.message).toBe(
        'El archivo no es una imagen válida o está dañado',
      );
    });

    it('rechaza fotos que superan el peso maximo (413)', async () => {
      const big = Buffer.concat([jpeg, Buffer.alloc(10 * 1024 * 1024)]);
      const res = await createOrder(client, orderFields(), [
        { content: big, name: 'grande.jpg' },
      ]).expect(413);
      expect(res.body.message).toBe(
        'Cada fotografía puede pesar como máximo 10 MB',
      );
    });

    it('rechaza una categoria inactiva', () =>
      createOrder(client, orderFields({ categoryId: catOff.id })).expect(400));

    it('un intento rechazado no deja archivos guardados', async () => {
      expect(await filesOnDisk()).toHaveLength(4);
    });

    it('solo un cliente crea pedidos', () => createOrder(admin).expect(403));
  });

  describe('RF-14 y RF-15: consulta propia, duplicados y datos personales', () => {
    it('el dueno ve su pedido con la direccion; otro cliente recibe 404', async () => {
      const own = await http()
        .get(`${BASE}/me/${orderId}`)
        .set('Authorization', auth(client))
        .expect(200);
      expect(own.body.address.addressLine).toBe('Av. Siempre Viva 742');

      await http()
        .get(`${BASE}/me/${orderId}`)
        .set('Authorization', auth(client2))
        .expect(404);
      await http().get(`${BASE}/me/${orderId}`).expect(401);
    });

    it('lista los pedidos propios con paginacion y filtro por estado', async () => {
      const res = await http()
        .get(`${BASE}/me`)
        .query({ status: OrderStatus.PUBLICADO, limit: 10 })
        .set('Authorization', auth(client))
        .expect(200);
      expect(res.body.data.map((o: { id: string }) => o.id)).toContain(orderId);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 10 });

      const other = await http()
        .get(`${BASE}/me`)
        .set('Authorization', auth(client2))
        .expect(200);
      expect(other.body.data).toEqual([]);
    });

    it('permite pedidos de la misma categoria y avisa posibles duplicados sin bloquear', async () => {
      const res = await createOrder(
        client,
        orderFields({
          description: 'fuga de agua debajo del lavaplatos de la cocina!!',
        }),
      ).expect(201);

      expect(res.body.warnings).toEqual([
        expect.objectContaining({
          code: 'POSIBLE_DUPLICADO',
          orderIds: [orderId],
        }),
      ]);
    });

    it('un trabajo distinto de la misma categoria no se marca como duplicado', async () => {
      const res = await createOrder(
        client,
        orderFields({
          description: 'Instalar una ducha eléctrica nueva en el segundo baño',
        }),
      ).expect(201);
      expect(res.body.warnings).toEqual([]);
    });

    it('dos pedidos simultaneos de la misma categoria se crean ambos', async () => {
      const responses = await Promise.all([
        createOrder(
          client2,
          orderFields({ description: 'Cambiar la cañería del patio trasero' }),
        ),
        createOrder(
          client2,
          orderFields({ description: 'Destapar el desagüe de la ducha' }),
        ),
      ]);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
    });

    it('la consulta previa de duplicados no crea nada', async () => {
      const before = await prisma.order.count({
        where: { clientId: client.id },
      });
      const res = await http()
        .post(`${BASE}/duplicate-check`)
        .set('Authorization', auth(client))
        .send({
          categoryId: catA.id,
          zoneId: zoneA.id,
          description: 'Fuga de agua debajo del lavaplatos de la cocina',
        })
        .expect(200);
      expect(res.body.warnings[0]).toMatchObject({ code: 'POSIBLE_DUPLICADO' });
      expect(await prisma.order.count({ where: { clientId: client.id } })).toBe(
        before,
      );
    });

    it('advierte si la descripcion parece incluir datos personales, sin bloquear', async () => {
      const res = await createOrder(
        client2,
        orderFields({
          categoryId: catB.id,
          description: 'Revisar el tablero eléctrico, llamar al 71234567',
        }),
      ).expect(201);
      expect(res.body.warnings).toEqual([
        expect.objectContaining({ code: 'POSIBLE_DATO_PERSONAL' }),
      ]);
    });

    it('el dueno descarga sus fotos (completa y miniatura) sin metadatos', async () => {
      const own = await http()
        .get(`${BASE}/me/${orderId}`)
        .set('Authorization', auth(client))
        .expect(200);
      const imageId = own.body.images[0].id;

      for (const variant of ['full', 'thumb']) {
        const res = await http()
          .get(`${BASE}/me/${orderId}/images/${imageId}`)
          .query({ variant })
          .set('Authorization', auth(client))
          .responseType('blob')
          .expect(200);
        expect(res.headers['content-type']).toBe('image/webp');
        expect(res.headers['cache-control']).toBe('private, no-store');
        const meta = await sharp(res.body as Buffer).metadata();
        expect(meta.exif).toBeUndefined();
      }
      await http()
        .get(`${BASE}/me/${orderId}/images/${imageId}`)
        .set('Authorization', auth(client2))
        .expect(404);
    });
  });

  describe('RF-17: visibilidad para trabajadores', () => {
    const available = (user: PublicUser, query: Record<string, string> = {}) =>
      http()
        .get(`${BASE}/available`)
        .query(query)
        .set('Authorization', auth(user));
    const detail = (user: PublicUser, id: string) =>
      http().get(`${BASE}/available/${id}`).set('Authorization', auth(user));

    it('un trabajador aprobado de la zona y especialidad ve el pedido, sin direccion ni datos del cliente', async () => {
      const list = await available(worker).expect(200);
      expect(list.body.data.map((o: { id: string }) => o.id)).toContain(
        orderId,
      );

      const res = await detail(worker, orderId).expect(200);
      expect(res.body).toMatchObject({
        id: orderId,
        status: OrderStatus.PUBLICADO,
        category: { id: catA.id },
        zone: { id: zoneA.id },
        budgetAmount: '150.50',
      });
      expect(res.body).not.toHaveProperty('address');
      expect(res.body).not.toHaveProperty('clientId');
      const body = JSON.stringify(res.body) + JSON.stringify(list.body);
      for (const secret of [
        'Siempre Viva',
        'Portón verde',
        client.id,
        client.email,
        client.firstName,
      ]) {
        expect(body).not.toContain(secret);
      }
    });

    it('el trabajador habilitado descarga las fotos del pedido', async () => {
      const res = await detail(worker, orderId).expect(200);
      await http()
        .get(`${BASE}/available/${orderId}/images/${res.body.images[0].id}`)
        .query({ variant: 'thumb' })
        .set('Authorization', auth(worker))
        .expect(200)
        .expect('content-type', 'image/webp');
    });

    it('un trabajador de otra zona no ve el pedido ni sus fotos (404)', async () => {
      const own = await http()
        .get(`${BASE}/me/${orderId}`)
        .set('Authorization', auth(client))
        .expect(200);
      const list = await available(workerOtherZone).expect(200);
      expect(list.body.data.map((o: { id: string }) => o.id)).not.toContain(
        orderId,
      );
      await detail(workerOtherZone, orderId).expect(404);
      await http()
        .get(`${BASE}/available/${orderId}/images/${own.body.images[0].id}`)
        .set('Authorization', auth(workerOtherZone))
        .expect(404);
    });

    it('un trabajador sin la especialidad no ve el pedido (404)', async () => {
      await detail(workerOtherCategory, orderId).expect(404);
      const list = await available(workerOtherCategory).expect(200);
      expect(
        list.body.data.every(
          (o: { category: { id: string } }) => o.category.id === catB.id,
        ),
      ).toBe(true);
    });

    it('un trabajador no aprobado no recibe pedidos (403)', async () => {
      const res = await available(workerPending).expect(403);
      expect(res.body.message).toContain('pendiente de revisión');
      await detail(workerPending, orderId).expect(403);
    });

    it('un cliente sin rol de trabajador no accede, y sin sesion tampoco', async () => {
      await available(client).expect(403);
      await http().get(`${BASE}/available`).expect(401);
    });

    it('un trabajador no ve sus propios pedidos como cliente (RN-14)', async () => {
      const own = await createOrder(
        worker,
        orderFields({ description: 'Arreglar la llave de paso de mi casa' }),
      ).expect(201);

      const list = await available(worker).expect(200);
      expect(list.body.data.map((o: { id: string }) => o.id)).not.toContain(
        own.body.order.id,
      );
      await detail(worker, own.body.order.id).expect(404);
    });

    it('un pedido vencido deja de ser visible aunque la tarea no haya corrido', async () => {
      const res = await createOrder(
        client2,
        orderFields({ description: 'Reparar la fuga del calefón a gas' }),
      ).expect(201);
      const id = res.body.order.id;
      await detail(worker, id).expect(200);

      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 minute' WHERE "id" = ${id}::uuid`;

      await detail(worker, id).expect(404);
      const own = await http()
        .get(`${BASE}/me/${id}`)
        .set('Authorization', auth(client2))
        .expect(200);
      expect(own.body).toMatchObject({
        status: OrderStatus.VENCIDO,
        canEdit: false,
      });
    });

    it('filtra por una de sus especialidades', async () => {
      const filtered = await available(worker, { categoryId: catB.id }).expect(
        200,
      );
      expect(filtered.body.data).toEqual([]);
    });
  });

  describe('RF-18: edicion de datos y fotos', () => {
    const patch = (user: PublicUser, id: string, body: object) =>
      http()
        .patch(`${BASE}/me/${id}`)
        .set('Authorization', auth(user))
        .send(body);
    const addImage = (user: PublicUser, id: string, content = jpeg) =>
      http()
        .post(`${BASE}/me/${id}/images`)
        .set('Authorization', auth(user))
        .attach('image', content, { filename: 'nueva.jpg' });
    const replaceImage = (
      user: PublicUser,
      id: string,
      imageId: string,
      content = jpeg,
    ) =>
      http()
        .put(`${BASE}/me/${id}/images/${imageId}`)
        .set('Authorization', auth(user))
        .attach('image', content, { filename: 'reemplazo.jpg' });
    const deleteImage = (user: PublicUser, id: string, imageId: string) =>
      http()
        .delete(`${BASE}/me/${id}/images/${imageId}`)
        .set('Authorization', auth(user));
    const keysExist = async (keys: string[]) =>
      Promise.all(
        keys.map((key) =>
          access(path.join(storageDir, key)).then(
            () => true,
            () => false,
          ),
        ),
      );
    /** Lleva el vencimiento al pasado cercano/futuro con el reloj de la BD. */
    const setExpiresIn = (id: string, minutes: number) =>
      prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() + make_interval(mins => ${minutes}::int) WHERE "id" = ${id}::uuid`;
    /** Fechas de publicacion y de vencimiento guardadas. */
    const datesOf = (id: string) =>
      prisma.order.findUniqueOrThrow({
        where: { id },
        select: { publishedAt: true, expiresAt: true },
      });
    /** Horas que faltan para vencer, medidas con el reloj de la BD. */
    const hoursLeft = async (id: string) => {
      const [row] = await prisma.$queryRaw<{ hours: number }[]>`
        SELECT EXTRACT(EPOCH FROM ("expires_at" - now())) / 3600 AS "hours"
        FROM "orders" WHERE "id" = ${id}::uuid`;
      return Number(row.hours);
    };
    const newOrder = async (description: string, images = 1) => {
      const files = Array.from({ length: images }, (_, i) => ({
        content: jpeg,
        name: `foto${i}.jpg`,
      }));
      const res = await createOrder(
        client2,
        orderFields({ description }),
        files,
      ).expect(201);
      return res.body.order as {
        id: string;
        images: { id: string; position: number }[];
      };
    };

    it('una edicion efectiva sube la revision y no cambia la publicacion ni el vencimiento (T5.1)', async () => {
      const order = await newOrder('Cambiar el grifo del baño principal');
      const before = await datesOf(order.id);

      const res = await patch(client2, order.id, {
        description: 'Cambiar el grifo y la ducha del baño principal',
        budgetAmount: '200',
        addressReference: null,
      }).expect(200);

      expect(res.body.order).toMatchObject({
        revision: 2,
        description: 'Cambiar el grifo y la ducha del baño principal',
        budgetAmount: '200.00',
        address: { addressLine: 'Av. Siempre Viva 742', reference: null },
        expiresAt: before.expiresAt.toISOString(),
        publishedAt: before.publishedAt.toISOString(),
      });
      expect(res.body.order.lastEditedAt).not.toBeNull();
      expect(await datesOf(order.id)).toEqual(before);
      // Editar no es un cambio de estado: el historial no crece.
      expect(
        await prisma.orderStatusHistory.count({ where: { orderId: order.id } }),
      ).toBe(1);
    });

    it('una edicion sin cambios reales no sube la revision ni cambia el vencimiento', async () => {
      const order = await newOrder('Revisar el tanque de agua de la terraza');
      await setExpiresIn(order.id, 60);

      const res = await patch(client2, order.id, {
        description: '  Revisar el tanque de agua de la terraza ',
        budgetAmount: '150.5',
        addressReference: 'Portón verde',
      }).expect(200);

      expect(res.body.order).toMatchObject({ revision: 1, lastEditedAt: null });
      expect(res.body.warnings).toEqual([]);
      expect(await hoursLeft(order.id)).toBeLessThan(1.1);
    });

    it('valida los datos y exige al menos un campo', async () => {
      await patch(client2, orderId, {}).expect(400);
      await patch(client, orderId, { description: 'corta' }).expect(400);
      await patch(client, orderId, { budgetAmount: '0' }).expect(400);
      await patch(client, orderId, { addressLine: '   ' }).expect(400);
      // Categoria y zona no son editables (pendiente con el docente).
      await patch(client, orderId, { zoneId: zoneB.id }).expect(400);
    });

    it('avisa de datos personales en la nueva descripcion sin bloquear', async () => {
      const order = await newOrder('Pintar la fachada de la casa');
      const res = await patch(client2, order.id, {
        description: 'Pintar la fachada, llamar al 70712345 por la tarde',
      }).expect(200);
      expect(res.body.warnings).toEqual([
        expect.objectContaining({ code: 'POSIBLE_DATO_PERSONAL' }),
      ]);
    });

    it('un pedido ajeno responde 404 en todas las rutas de edicion', async () => {
      const own = await http()
        .get(`${BASE}/me/${orderId}`)
        .set('Authorization', auth(client))
        .expect(200);
      const imageId = own.body.images[0].id;
      await patch(client2, orderId, {
        description: 'Intento de editar un pedido ajeno',
      }).expect(404);
      await addImage(client2, orderId).expect(404);
      await replaceImage(client2, orderId, imageId).expect(404);
      await deleteImage(client2, orderId, imageId).expect(404);
      await patch(worker, orderId, { budgetAmount: '10' }).expect(404);
    });

    it('un pedido vencido no se modifica aunque la tarea no haya corrido (409)', async () => {
      const order = await newOrder('Arreglar el portón eléctrico del garaje');
      await setExpiresIn(order.id, -1);

      const res = await patch(client2, order.id, { budgetAmount: '99' }).expect(
        409,
      );
      expect(res.body.message).toContain('venció');
      // Tampoco una edicion sin cambios: el pedido ya no es editable.
      await patch(client2, order.id, { budgetAmount: '150.50' }).expect(409);
      const before = await filesOnDisk();
      await addImage(client2, order.id).expect(409);
      expect(await filesOnDisk()).toEqual(before);
    });

    it('con acuerdo indica usar Cancelar trabajo (RF-34); otros estados, 409', async () => {
      const order = await newOrder('Instalar un tomacorriente en la sala');
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.ACORDADO },
      });
      const agreed = await patch(client2, order.id, {
        budgetAmount: '300',
      }).expect(409);
      expect(agreed.body.message).toContain('RF-34');

      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELADO },
      });
      const cancelled = await deleteImage(
        client2,
        order.id,
        order.images[0].id,
      ).expect(409);
      expect(cancelled.body.message).toContain('CANCELADO');
    });

    it('agregar una foto la guarda en la siguiente posicion y cuenta como edicion, sin cambiar el vencimiento', async () => {
      const order = await newOrder('Cambiar las tejas rotas del techo');
      await setExpiresIn(order.id, 60);

      const res = await addImage(client2, order.id).expect(201);
      expect(res.body).toMatchObject({ revision: 2 });
      expect(
        res.body.images.map((i: { position: number }) => i.position),
      ).toEqual([1, 2]);
      // T5.1: sigue venciendo en la misma fecha (aqui, en una hora).
      expect(await hoursLeft(order.id)).toBeGreaterThan(0.9);
      expect(await hoursLeft(order.id)).toBeLessThan(1.1);
    });

    it('no supera el maximo de fotos y no deja archivos huerfanos', async () => {
      const order = await newOrder('Reparar tres ventanas rotas del cuarto', 3);
      const before = await filesOnDisk();

      const res = await addImage(client2, order.id).expect(409);
      expect(res.body.message).toContain('máximo de 3');
      expect(await filesOnDisk()).toEqual(before);
      await addImage(client2, order.id, Buffer.from('no es imagen')).expect(
        400,
      );
      expect(await filesOnDisk()).toEqual(before);
    });

    it('reemplazar conserva la posicion y borra fisicamente la foto anterior', async () => {
      const order = await newOrder('Limpiar la canaleta del techo trasero', 2);
      const previous = await prisma.orderImage.findFirstOrThrow({
        where: { orderId: order.id, position: 2 },
      });
      const oldKeys = [previous.storageKey, previous.thumbnailKey];

      const res = await replaceImage(
        client2,
        order.id,
        previous.id,
        await photo(640, 480, '#00aa55'),
      ).expect(200);

      expect(res.body.revision).toBe(2);
      const replaced = res.body.images.find(
        (i: { position: number }) => i.position === 2,
      );
      expect(replaced.id).not.toBe(previous.id);
      expect(replaced).toMatchObject({ width: 640, height: 480 });
      expect(await keysExist(oldKeys)).toEqual([false, false]);
      expect(
        await prisma.pendingFileDeletion.count({
          where: { storageKey: { in: oldKeys } },
        }),
      ).toBe(0);
      await replaceImage(client2, order.id, previous.id).expect(404);
    });

    it('eliminar borra la foto del disco y respeta el minimo', async () => {
      const order = await newOrder('Destapar el desagüe del patio', 2);
      const [first, second] = await prisma.orderImage.findMany({
        where: { orderId: order.id },
        orderBy: { position: 'asc' },
      });

      const res = await deleteImage(client2, order.id, first.id).expect(200);
      expect(res.body).toMatchObject({ revision: 2 });
      expect(res.body.images.map((i: { id: string }) => i.id)).toEqual([
        second.id,
      ]);
      expect(await keysExist([first.storageKey, first.thumbnailKey])).toEqual([
        false,
        false,
      ]);

      const last = await deleteImage(client2, order.id, second.id).expect(409);
      expect(last.body.message).toContain('reemplazar');
      expect(await keysExist([second.storageKey, second.thumbnailKey])).toEqual(
        [true, true],
      );

      // La posicion liberada se reutiliza al agregar.
      const added = await addImage(client2, order.id).expect(201);
      expect(
        added.body.images.map((i: { position: number }) => i.position),
      ).toEqual([1, 2]);
    });

    it('el trabajador ve los datos editados y sigue sin ver la direccion', async () => {
      const order = await newOrder('Reparar la bomba de agua del edificio');
      await patch(client2, order.id, {
        description: 'Reparar y revisar la bomba de agua del edificio',
        addressLine: 'Calle Nueva 123',
      }).expect(200);

      const res = await http()
        .get(`${BASE}/available/${order.id}`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(res.body).toMatchObject({
        description: 'Reparar y revisar la bomba de agua del edificio',
        revision: 2,
      });
      expect(JSON.stringify(res.body)).not.toContain('Calle Nueva');
    });

    it('dos ediciones concurrentes se serializan sin perder revisiones', async () => {
      const order = await newOrder('Cambiar el cerrojo de la puerta');
      await Promise.all([
        patch(client2, order.id, { budgetAmount: '170' }).expect(200),
        patch(client2, order.id, { addressLine: 'Calle Ancha 9' }).expect(200),
      ]);
      const stored = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { address: true },
      });
      expect(stored.revision).toBe(3);
      expect(stored.budgetAmount.toFixed(2)).toBe('170.00');
      expect(stored.address?.addressLine).toBe('Calle Ancha 9');
    });
  });

  describe('RF-18: cancelacion y transiciones', () => {
    const cancel = (user: PublicUser, id: string, body: object = {}) =>
      http()
        .post(`${BASE}/me/${id}/cancel`)
        .set('Authorization', auth(user))
        .send(body);
    const keysExist = async (keys: string[]) =>
      Promise.all(
        keys.map((key) =>
          access(path.join(storageDir, key)).then(
            () => true,
            () => false,
          ),
        ),
      );
    const newOrder = async (description: string, images = 1) => {
      const files = Array.from({ length: images }, (_, i) => ({
        content: jpeg,
        name: `foto${i}.jpg`,
      }));
      const res = await createOrder(
        client2,
        orderFields({ description }),
        files,
      ).expect(201);
      return res.body.order.id as string;
    };
    const setStatus = (id: string, status: OrderStatus) =>
      prisma.order.update({ where: { id }, data: { status } });

    // Hook de prueba: registra eventos y puede forzar un fallo en la transaccion.
    const seen: { phase: string; type: string; orderId: string }[] = [];
    let failInTransaction = false;
    beforeAll(() => {
      app.get(OrderLifecycleRegistry).register({
        name: 'orders-e2e',
        inTransaction: async (event) => {
          if (failInTransaction) throw new Error('fallo de prueba');
          seen.push({ phase: 'tx', type: event.type, orderId: event.orderId });
        },
        afterCommit: async (event) => {
          seen.push({
            phase: 'after',
            type: event.type,
            orderId: event.orderId,
          });
        },
      });
    });

    it('cancela, borra las fotos del disco y conserva el pedido y su historial', async () => {
      const id = await newOrder('Reparar el calefón que no enciende', 2);
      const images = await prisma.orderImage.findMany({
        where: { orderId: id },
      });
      const keys = images.flatMap((i) => [i.storageKey, i.thumbnailKey]);
      expect(await keysExist(keys)).toEqual([true, true, true, true]);

      const res = await cancel(client2, id, {
        reason: '  Ya lo arreglé por mi cuenta ',
      }).expect(200);

      expect(res.body).toMatchObject({
        id,
        status: OrderStatus.CANCELADO,
        images: [],
        canEdit: false,
        canCancel: false,
      });
      expect(res.body.cancelledAt).not.toBeNull();
      expect(await keysExist(keys)).toEqual([false, false, false, false]);
      expect(
        await prisma.pendingFileDeletion.count({
          where: { storageKey: { in: keys } },
        }),
      ).toBe(0);
      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history[1]).toMatchObject({
        fromStatus: OrderStatus.PUBLICADO,
        toStatus: OrderStatus.CANCELADO,
        actorType: 'USUARIO',
        changedById: client2.id,
        actorRole: RoleName.CLIENTE,
        reason: 'Ya lo arreglé por mi cuenta',
      });
      expect(seen).toEqual(
        expect.arrayContaining([
          { phase: 'tx', type: 'CANCELADO', orderId: id },
          { phase: 'after', type: 'CANCELADO', orderId: id },
        ]),
      );

      // Sigue en la consulta propia; el trabajador ya no lo ve.
      await http()
        .get(`${BASE}/me/${id}`)
        .set('Authorization', auth(client2))
        .expect(200);
      await http()
        .get(`${BASE}/available/${id}`)
        .set('Authorization', auth(worker))
        .expect(404);
      // Un pedido cancelado no se vuelve a cancelar ni se edita.
      const again = await cancel(client2, id).expect(409);
      expect(again.body.message).toContain('CANCELADO');
    });

    it('cancela un pedido EN_NEGOCIACION y el motivo es opcional', async () => {
      const id = await newOrder('Cambiar el medidor de luz del patio');
      await setStatus(id, OrderStatus.EN_NEGOCIACION);
      await cancel(client2, id).expect(200);
      const last = await prisma.orderStatusHistory.findFirstOrThrow({
        where: { orderId: id, toStatus: OrderStatus.CANCELADO },
      });
      expect(last).toMatchObject({
        fromStatus: OrderStatus.EN_NEGOCIACION,
        reason: null,
      });
    });

    it('con acuerdo indica Cancelar trabajo (RF-34); vencido o ajeno, no', async () => {
      const agreed = await newOrder('Instalar la ducha eléctrica nueva');
      await setStatus(agreed, OrderStatus.EN_EJECUCION);
      const res = await cancel(client2, agreed).expect(409);
      expect(res.body.message).toContain('RF-34');

      const expired = await newOrder('Pintar la reja del frente de casa');
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 second' WHERE "id" = ${expired}::uuid`;
      const late = await cancel(client2, expired).expect(409);
      expect(late.body.message).toContain('venció');

      await cancel(client, expired).expect(404);
      await cancel(worker, expired).expect(404);
      await cancel(admin, expired).expect(403);
      await cancel(client2, expired, { reason: 'x'.repeat(501) }).expect(400);
    });

    it('si un hook falla dentro de la transaccion, no se cancela ni se borran fotos', async () => {
      const id = await newOrder('Revisar el cableado del dormitorio');
      const images = await prisma.orderImage.findMany({
        where: { orderId: id },
      });
      const keys = images.flatMap((i) => [i.storageKey, i.thumbnailKey]);

      failInTransaction = true;
      try {
        await cancel(client2, id).expect(500);
      } finally {
        failInTransaction = false;
      }

      const order = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(order.status).toBe(OrderStatus.PUBLICADO);
      expect(order.cancelledAt).toBeNull();
      expect(await prisma.orderImage.count({ where: { orderId: id } })).toBe(1);
      expect(await keysExist(keys)).toEqual([true, true]);
      expect(
        await prisma.pendingFileDeletion.count({
          where: { storageKey: { in: keys } },
        }),
      ).toBe(0);
    });

    it('cancelaciones concurrentes: solo una gana y el historial no se duplica', async () => {
      const id = await newOrder('Cambiar la chapa de la puerta trasera');
      const results = await Promise.all([
        cancel(client2, id),
        cancel(client2, id),
        http()
          .patch(`${BASE}/me/${id}`)
          .set('Authorization', auth(client2))
          .send({ budgetAmount: '321' }),
      ]);
      const cancels = results
        .slice(0, 2)
        .map((r) => r.status)
        .sort((a, b) => a - b);
      expect(cancels).toEqual([200, 409]);
      expect([200, 409]).toContain(results[2].status);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId: id, toStatus: OrderStatus.CANCELADO },
        }),
      ).toBe(1);
    });

    it('transition() valida contra ORDER_TRANSITIONS y no alcanza estados internos', async () => {
      const service = app.get(OrdersService);
      const id = await newOrder('Arreglar la persiana de la sala');
      const actor = { type: 'SISTEMA' as const, process: 'E2E' };

      // CANCELADO no compila como destino publico; con una conversion de
      // tipo, el servicio lo rechaza como error de uso interno.
      const cancelar = {
        orderId: id,
        to: OrderStatus.CANCELADO,
        actor,
      } as unknown as OrderTransitionRequest;
      await expect(
        prisma.$transaction((tx) => service.transition(tx, cancelar)),
      ).rejects.toThrow(OrderTransitionUsageError);
      await expect(
        prisma.$transaction((tx) =>
          service.transition(tx, {
            orderId: id,
            to: OrderStatus.ACORDADO,
            actor,
            assignWorkerId: worker.id,
          }),
        ),
      ).rejects.toThrow(
        'No se permite pasar un pedido de PUBLICADO a ACORDADO',
      );
      await expect(
        prisma.$transaction((tx) =>
          service.transition(tx, {
            orderId: id,
            from: OrderStatus.EN_NEGOCIACION,
            to: OrderStatus.ACORDADO,
            actor,
            assignWorkerId: worker.id,
          }),
        ),
      ).rejects.toThrow('cambió de estado');
      expect(
        await prisma.orderStatusHistory.count({ where: { orderId: id } }),
      ).toBe(1);
    });

    it('assertOpenForOffers relee al trabajador en la transaccion y aplica la misma regla', async () => {
      const visibility = app.get(OrderVisibilityService);
      const id = await newOrder('Instalar un lavamanos en el baño');
      const open = (userId: string) =>
        prisma.$transaction((tx) =>
          visibility.assertOpenForOffers(tx, userId, id),
        );

      await expect(open(worker.id)).resolves.toMatchObject({
        worker: { userId: worker.id, zoneId: zoneA.id },
        order: { status: OrderStatus.PUBLICADO, revision: 1 },
      });
      await expect(open(workerOtherZone.id)).rejects.toThrow(NotFoundException);
      await expect(open(workerPending.id)).rejects.toThrow(ForbiddenException);

      // I-6: lo que vio el guard antes no sirve; se decide con el perfil
      // bloqueado y releido dentro de la transaccion.
      await prisma.workerProfile.update({
        where: { userId: worker.id },
        data: { status: WorkerProfileStatus.SUSPENDIDO },
      });
      try {
        await expect(open(worker.id)).rejects.toThrow('suspendido');
      } finally {
        await prisma.workerProfile.update({
          where: { userId: worker.id },
          data: { status: WorkerProfileStatus.APROBADO },
        });
      }

      await cancel(client2, id).expect(200);
      await expect(open(worker.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('Transiciones de ofertas y asignacion del trabajador', () => {
    let service: OrdersService;
    const workerActor = (userId: string) => ({
      type: 'USUARIO' as const,
      userId,
      role: RoleName.TRABAJADOR,
    });
    beforeAll(() => {
      service = app.get(OrdersService);
    });
    /** Pedido de catB (especialidad de workerOtherCategory) del cliente 2. */
    const newOrder = async (description: string) => {
      const res = await createOrder(
        client2,
        orderFields({ description, categoryId: catB.id }),
      ).expect(201);
      return res.body.order.id as string;
    };
    const stored = (id: string) =>
      prisma.order.findUniqueOrThrow({ where: { id } });
    const toNegotiation = (id: string) =>
      prisma.$transaction((tx) =>
        service.transition(tx, {
          orderId: id,
          from: OrderStatus.PUBLICADO,
          to: OrderStatus.EN_NEGOCIACION,
          actor: workerActor(workerOtherCategory.id),
        }),
      );

    it('PUBLICADO -> EN_NEGOCIACION deja el historial con el actor', async () => {
      const id = await newOrder('Revisar el tablero eléctrico principal');
      const before = await stored(id);

      await expect(toNegotiation(id)).resolves.toEqual({
        fromStatus: OrderStatus.PUBLICADO,
        toStatus: OrderStatus.EN_NEGOCIACION,
        assignedWorkerId: null,
      });

      const after = await stored(id);
      expect(after.status).toBe(OrderStatus.EN_NEGOCIACION);
      expect(after.expiresAt).toEqual(before.expiresAt);
      const history = await prisma.orderStatusHistory.findFirstOrThrow({
        where: { orderId: id, toStatus: OrderStatus.EN_NEGOCIACION },
      });
      expect(history).toMatchObject({
        fromStatus: OrderStatus.PUBLICADO,
        actorType: 'USUARIO',
        changedById: workerOtherCategory.id,
        actorRole: RoleName.TRABAJADOR,
      });
    });

    it('EN_NEGOCIACION -> ACORDADO exige asignar un trabajador aprobado y distinto del cliente', async () => {
      const id = await newOrder('Cambiar los tomacorrientes de la cocina');
      await toNegotiation(id);
      const agree = (assignWorkerId: string) =>
        prisma.$transaction((tx) =>
          service.transition(tx, {
            orderId: id,
            to: OrderStatus.ACORDADO,
            actor: clientActor(client2.id),
            assignWorkerId,
          }),
        );
      // Usos invalidos que no compilan: con conversion de tipo son errores
      // de uso interno (500), no errores HTTP de negocio.
      const misuse = (request: object) =>
        prisma.$transaction((tx) =>
          service.transition(tx, request as OrderTransitionRequest),
        );

      await expect(
        misuse({
          orderId: id,
          to: OrderStatus.ACORDADO,
          actor: clientActor(client2.id),
        }),
      ).rejects.toThrow(OrderTransitionUsageError);
      await expect(agree(workerPending.id)).rejects.toThrow(ForbiddenException);
      await expect(
        misuse({
          orderId: id,
          to: OrderStatus.PUBLICADO,
          actor: clientActor(client2.id),
          assignWorkerId: workerOtherCategory.id,
        }),
      ).rejects.toThrow('Solo se asigna un trabajador');

      // RN-14: un trabajador no toma su propio pedido.
      const own = await createOrder(
        workerOtherCategory,
        orderFields({
          description: 'Pedido propio del trabajador de prueba',
          categoryId: catB.id,
        }),
      ).expect(201);
      await prisma.order.update({
        where: { id: own.body.order.id },
        data: { status: OrderStatus.EN_NEGOCIACION },
      });
      await expect(
        prisma.$transaction((tx) =>
          service.transition(tx, {
            orderId: own.body.order.id,
            to: OrderStatus.ACORDADO,
            actor: clientActor(workerOtherCategory.id),
            assignWorkerId: workerOtherCategory.id,
          }),
        ),
      ).rejects.toThrow('RN-14');

      expect(await stored(id)).toMatchObject({
        status: OrderStatus.EN_NEGOCIACION,
        assignedWorkerId: null,
      });
    });

    it('estado, asignacion e historial son atomicos con la transaccion del llamador', async () => {
      const id = await newOrder('Instalar luminarias en el pasillo');
      await toNegotiation(id);
      const historyCount = () =>
        prisma.orderStatusHistory.count({ where: { orderId: id } });
      const before = await historyCount();
      const registry = app.get(WorkerActiveWorkRegistry);
      const activeOrders = async () => {
        const result = await prisma.$transaction((tx) =>
          registry.check(workerOtherCategory.id, [ActiveWorkKind.PEDIDOS], tx),
        );
        return result.verifiable ? result.counts.PEDIDOS : -1;
      };
      const agree = (tx: Prisma.TransactionClient) =>
        service.transition(tx, {
          orderId: id,
          from: OrderStatus.EN_NEGOCIACION,
          to: OrderStatus.ACORDADO,
          actor: clientActor(client2.id),
          reason: 'Oferta aceptada',
          assignWorkerId: workerOtherCategory.id,
        });

      // Si el llamador falla despues, no queda nada.
      await expect(
        prisma.$transaction(async (tx) => {
          await agree(tx);
          throw new Error('falla el modulo de ofertas');
        }),
      ).rejects.toThrow('falla el modulo de ofertas');
      expect(await stored(id)).toMatchObject({
        status: OrderStatus.EN_NEGOCIACION,
        assignedWorkerId: null,
      });
      expect(await historyCount()).toBe(before);
      const activeBefore = await activeOrders();

      await expect(prisma.$transaction(agree)).resolves.toEqual({
        fromStatus: OrderStatus.EN_NEGOCIACION,
        toStatus: OrderStatus.ACORDADO,
        assignedWorkerId: workerOtherCategory.id,
      });
      expect(await stored(id)).toMatchObject({
        status: OrderStatus.ACORDADO,
        assignedWorkerId: workerOtherCategory.id,
      });
      expect(await historyCount()).toBe(before + 1);
      // La fuente PEDIDOS (RF-13) ya cuenta el trabajo asignado.
      expect(await activeOrders()).toBe(activeBefore + 1);

      // Sin salida desde ACORDADO (pendiente con el docente, RF-34).
      await expect(
        prisma.$transaction((tx) =>
          service.transition(tx, {
            orderId: id,
            to: OrderStatus.PUBLICADO,
            actor: clientActor(client2.id),
            releaseWorker: true,
          }),
        ),
      ).rejects.toThrow(
        'No se permite pasar un pedido de ACORDADO a PUBLICADO',
      );

      // Limpieza: no dejar trabajo activo para otras pruebas.
      await prisma.order.update({
        where: { id },
        data: { status: OrderStatus.CERRADO },
      });
    });

    it('EN_NEGOCIACION -> PUBLICADO conserva el vencimiento original y puede liberar la asignacion (T5.1)', async () => {
      const id = await newOrder('Reparar la bomba de la cisterna');
      const original = await stored(id);
      await toNegotiation(id);
      // Cambiar de estado no toca el plazo.
      expect((await stored(id)).expiresAt).toEqual(original.expiresAt);
      await prisma.$executeRaw`UPDATE "orders" SET "assigned_worker_id" = ${workerOtherCategory.id}::uuid WHERE "id" = ${id}::uuid`;

      await prisma.$transaction((tx) =>
        service.transition(tx, {
          orderId: id,
          from: OrderStatus.EN_NEGOCIACION,
          to: OrderStatus.PUBLICADO,
          actor: workerActor(workerOtherCategory.id),
          releaseWorker: true,
        }),
      );

      expect(await stored(id)).toMatchObject({
        status: OrderStatus.PUBLICADO,
        assignedWorkerId: null,
        publishedAt: original.publishedAt,
        expiresAt: original.expiresAt,
      });
    });

    it('bloquea primero al trabajador y despues el pedido', async () => {
      const id = await newOrder('Colocar un interruptor doble');
      await toNegotiation(id);

      // Otra transaccion retiene la fila del trabajador.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await app
            .get(WorkerActiveWorkRegistry)
            .lockWorker(tx, workerOtherCategory.id);
          markLocked();
          await held;
        },
        { timeout: 15_000 },
      );
      await locked;

      const agreement = prisma.$transaction(
        (tx) =>
          service.transition(tx, {
            orderId: id,
            to: OrderStatus.ACORDADO,
            actor: clientActor(client2.id),
            assignWorkerId: workerOtherCategory.id,
          }),
        { timeout: 15_000 },
      );
      try {
        // Mientras espera al trabajador, todavia no tomo el pedido.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rows = await prisma.$transaction(
          (tx) =>
            tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "orders" WHERE "id" = ${id}::uuid FOR UPDATE NOWAIT`,
        );
        expect(rows).toHaveLength(1);
      } finally {
        release();
        await holder;
      }
      await agreement;
      expect(await stored(id)).toMatchObject({
        status: OrderStatus.ACORDADO,
        assignedWorkerId: workerOtherCategory.id,
      });
      await prisma.order.update({
        where: { id },
        data: { status: OrderStatus.CERRADO },
      });
    });

    it('con un cambio de zona pendiente no recibe asignaciones ni oferta; conserva sus trabajos acordados (T4.3)', async () => {
      const visibility = app.get(OrderVisibilityService);
      const assign = (orderId: string) =>
        prisma.$transaction((tx) =>
          service.transition(tx, {
            orderId,
            to: OrderStatus.ACORDADO,
            actor: clientActor(client2.id),
            assignWorkerId: workerOtherCategory.id,
          }),
        );
      const offer = (orderId: string) =>
        prisma.$transaction((tx) =>
          visibility.assertOpenForOffers(tx, workerOtherCategory.id, orderId),
        );
      // Trabajo acordado antes de la solicitud, y un pedido en negociacion.
      const agreedId = await newOrder('Instalar un calefón a gas nuevo');
      await toNegotiation(agreedId);
      await assign(agreedId);
      const newId = await newOrder('Reparar la ducha eléctrica del baño');
      await toNegotiation(newId);
      const openId = await newOrder('Cambiar la grifería del lavamanos');

      // Solicitud pendiente como dato de prueba: este archivo no registra la
      // fuente OFERTAS y, con un trabajo acordado, la solicitud por HTTP se
      // bloquearia por TRABAJO_ACTIVO.
      const profile = await prisma.workerProfile.findUniqueOrThrow({
        where: { userId: workerOtherCategory.id },
      });
      const pending = await prisma.zoneChangeRequest.create({
        data: {
          profileId: profile.id,
          fromZoneId: profile.zoneId,
          toZoneId: zoneB.id,
          reason: 'Solicitud de prueba T4.3',
        },
      });
      const blocked = new ConflictException(
        'Tiene una solicitud de cambio de zona pendiente: no puede ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire.',
      );

      await expect(assign(newId)).rejects.toThrow(blocked);
      await expect(offer(openId)).rejects.toThrow(blocked);
      expect(await stored(newId)).toMatchObject({
        status: OrderStatus.EN_NEGOCIACION,
        assignedWorkerId: null,
      });
      // El trabajo ya acordado sigue igual: no se cancela ni se libera.
      expect(await stored(agreedId)).toMatchObject({
        status: OrderStatus.ACORDADO,
        assignedWorkerId: workerOtherCategory.id,
      });

      // Al retirar la solicitud vuelve a participar.
      await app
        .get(ZoneChangeRequestsService)
        .withdraw(workerOtherCategory.id, pending.id);
      await expect(offer(openId)).resolves.toMatchObject({
        order: { status: OrderStatus.PUBLICADO },
      });
      await assign(newId);
      expect(await stored(newId)).toMatchObject({
        status: OrderStatus.ACORDADO,
        assignedWorkerId: workerOtherCategory.id,
      });
      expect(await stored(agreedId)).toMatchObject({
        status: OrderStatus.ACORDADO,
        assignedWorkerId: workerOtherCategory.id,
      });

      // Igual que las demas pruebas: no dejar trabajo activo al trabajador.
      await prisma.order.updateMany({
        where: { id: { in: [agreedId, newId] } },
        data: { status: OrderStatus.CERRADO },
      });
    });
  });

  describe('Vencimiento automatico (§5.5)', () => {
    let expiration: OrderExpirationService;
    const vencidos: string[] = [];
    const vencidosEventos: OrderLifecycleEvent[] = [];
    beforeAll(() => {
      expiration = app.get(OrderExpirationService);
      app.get(OrderLifecycleRegistry).register({
        name: 'orders-e2e-vencimiento',
        afterCommit: async (event) => {
          if (event.type === 'VENCIDO') {
            vencidos.push(event.orderId);
            vencidosEventos.push(event);
          }
        },
      });
    });
    const newOrder = async (description: string) => {
      const res = await createOrder(
        client2,
        orderFields({ description }),
      ).expect(201);
      return res.body.order.id as string;
    };
    const makeDue = (ids: string[]) =>
      prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 second' WHERE "id" = ANY(${ids}::uuid[])`;
    const statusOf = async (id: string) =>
      (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
    const expirationHistory = (id: string) =>
      prisma.orderStatusHistory.findMany({
        where: { orderId: id, toStatus: OrderStatus.VENCIDO },
      });

    it('vence los pedidos atrasados con actor SISTEMA y conserva sus fotos', async () => {
      const due = await newOrder('Cambiar el foco de la escalera');
      const fresh = await newOrder('Revisar la conexión de gas');
      await makeDue([due]);
      const image = await prisma.orderImage.findFirstOrThrow({
        where: { orderId: due },
      });

      expect(await expiration.expireDue()).toBeGreaterThanOrEqual(1);

      expect(await statusOf(due)).toBe(OrderStatus.VENCIDO);
      expect(await statusOf(fresh)).toBe(OrderStatus.PUBLICADO);
      expect(await expirationHistory(due)).toMatchObject([
        {
          fromStatus: OrderStatus.PUBLICADO,
          actorType: 'SISTEMA',
          changedById: null,
          actorRole: null,
          systemProcess: 'VENCIMIENTO',
        },
      ]);
      expect(vencidos).toContain(due);
      // Fotos de pedidos vencidos: por ahora se conservan (su borrado es una
      // tarea aparte de T5.1).
      await access(path.join(storageDir, image.storageKey));
      const own = await http()
        .get(`${BASE}/me/${due}`)
        .set('Authorization', auth(client2))
        .expect(200);
      expect(own.body).toMatchObject({
        status: OrderStatus.VENCIDO,
        canEdit: false,
        canCancel: false,
      });
      expect(own.body.images).toHaveLength(1);

      // Una segunda pasada no lo vuelve a vencer.
      await expiration.expireDue();
      expect(await expirationHistory(due)).toHaveLength(1);
    });

    it('vence tambien los pedidos EN_NEGOCIACION y avisa el estado de origen (T5.1)', async () => {
      const id = await newOrder('Instalar el calefón en la lavandería');
      await prisma.order.update({
        where: { id },
        data: { status: OrderStatus.EN_NEGOCIACION },
      });
      await makeDue([id]);

      await expiration.expireDue();

      expect(await statusOf(id)).toBe(OrderStatus.VENCIDO);
      expect(await expirationHistory(id)).toMatchObject([
        {
          fromStatus: OrderStatus.EN_NEGOCIACION,
          actorType: 'SISTEMA',
          systemProcess: 'VENCIMIENTO',
        },
      ]);
      expect(vencidosEventos.find((event) => event.orderId === id)).toEqual({
        type: 'VENCIDO',
        orderId: id,
        fromStatus: OrderStatus.EN_NEGOCIACION,
      });
    });

    it('procesa por lotes hasta terminar', async () => {
      const ids = [
        await newOrder('Pintar la puerta del garaje'),
        await newOrder('Cambiar el vidrio de la ventana'),
        await newOrder('Arreglar la gotera del techo'),
      ];
      await makeDue(ids);
      expect(await expiration.expireDue(1)).toBeGreaterThanOrEqual(3);
      for (const id of ids) {
        expect(await statusOf(id)).toBe(OrderStatus.VENCIDO);
      }
    });

    it('ejecuciones concurrentes no vencen dos veces el mismo pedido', async () => {
      const ids = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          newOrder(`Pedido concurrente de prueba número ${i}`),
        ),
      );
      // La mitad en negociacion: tambien vencen (T5.1).
      await prisma.order.updateMany({
        where: { id: { in: ids.slice(0, 3) } },
        data: { status: OrderStatus.EN_NEGOCIACION },
      });
      await makeDue(ids);

      await Promise.all([
        expiration.expireDue(2),
        expiration.expireDue(2),
        expiration.expireDue(2),
      ]);

      for (const [index, id] of ids.entries()) {
        expect(await statusOf(id)).toBe(OrderStatus.VENCIDO);
        expect(await expirationHistory(id)).toMatchObject([
          {
            fromStatus:
              index < 3 ? OrderStatus.EN_NEGOCIACION : OrderStatus.PUBLICADO,
          },
        ]);
      }
    });

    it('salta un pedido bloqueado por una edicion y lo vence en la siguiente pasada', async () => {
      const id = await newOrder('Reparar el timbre de la entrada');
      await makeDue([id]);

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));
      const lockTx = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${id}::uuid FOR UPDATE`;
          markLocked();
          await held;
        },
        { timeout: 15_000 },
      );
      await locked;
      try {
        await expiration.expireDue();
        expect(await statusOf(id)).toBe(OrderStatus.PUBLICADO);
      } finally {
        release();
        await lockTx;
      }

      // Entretanto ya se trata como vencido: no se puede editar.
      await http()
        .patch(`${BASE}/me/${id}`)
        .set('Authorization', auth(client2))
        .send({ budgetAmount: '80' })
        .expect(409);
      await expiration.expireDue();
      expect(await statusOf(id)).toBe(OrderStatus.VENCIDO);
    });

    describe('T5.1: plazo de 7 días desde la publicación', () => {
      const SEVEN_DAYS_S = 7 * 24 * 60 * 60;
      const service = () => app.get(OrdersService);
      const datesOf = (id: string) =>
        prisma.order.findUniqueOrThrow({
          where: { id },
          select: { publishedAt: true, expiresAt: true },
        });
      /**
       * Simula el paso del tiempo: el pedido se publico hace `seconds`
       * segundos y vence 7 dias despues de esa publicacion (la regla se
       * conserva: expires_at = published_at + 7 dias).
       */
      const publishedSecondsAgo = (id: string, seconds: number) =>
        prisma.$executeRaw`
          UPDATE "orders"
          SET "published_at" = now() - make_interval(secs => ${seconds}::int),
              "expires_at" = now() - make_interval(secs => ${seconds}::int) + interval '7 days'
          WHERE "id" = ${id}::uuid`;
      const toNegotiation = (id: string) =>
        prisma.$transaction((tx) =>
          service().transition(tx, {
            orderId: id,
            from: OrderStatus.PUBLICADO,
            to: OrderStatus.EN_NEGOCIACION,
            actor: {
              type: 'USUARIO',
              userId: workerOtherCategory.id,
              role: RoleName.TRABAJADOR,
            },
          }),
        );
      const history = (id: string) =>
        prisma.orderStatusHistory.findMany({
          where: { orderId: id },
          orderBy: { createdAt: 'asc' },
        });
      const ownView = (id: string) =>
        http()
          .get(`${BASE}/me/${id}`)
          .set('Authorization', auth(client2))
          .expect(200);

      it('vence al cumplirse 7 días desde la publicación; un minuto antes, no', async () => {
        const due = await newOrder('Cambiar el cerrojo de la puerta principal');
        const notYet = await newOrder(
          'Revisar el calentador del baño de visitas',
        );
        await publishedSecondsAgo(due, SEVEN_DAYS_S + 1);
        await publishedSecondsAgo(notYet, SEVEN_DAYS_S - 60);

        await expiration.expireDue();

        expect(await statusOf(due)).toBe(OrderStatus.VENCIDO);
        expect(await statusOf(notYet)).toBe(OrderStatus.PUBLICADO);
        expect((await ownView(notYet)).body).toMatchObject({
          status: OrderStatus.PUBLICADO,
          canEdit: true,
        });
      });

      it('un pedido en negociación (con ofertas) vence igual y ninguna transición lo prolonga', async () => {
        const id = await newOrder('Reparar la instalación de la cocina');
        const original = await datesOf(id);

        // La primera oferta lo pasa a EN_NEGOCIACION: el plazo no cambia.
        await toNegotiation(id);
        expect(await datesOf(id)).toEqual(original);

        // Se cumplen los 7 dias mientras negocia.
        await publishedSecondsAgo(id, SEVEN_DAYS_S + 1);
        const due = await datesOf(id);

        // Antes de que corra la tarea ya se trata como vencido.
        expect((await ownView(id)).body).toMatchObject({
          status: OrderStatus.VENCIDO,
          canEdit: false,
          canCancel: false,
        });
        await http()
          .get(`${BASE}/available/${id}`)
          .set('Authorization', auth(worker))
          .expect(404);
        // Ni aceptar una oferta ni volver a PUBLICADO lo reviven.
        for (const change of [
          {
            to: OrderStatus.ACORDADO,
            assignWorkerId: workerOtherCategory.id,
          } as const,
          { to: OrderStatus.PUBLICADO } as const,
        ]) {
          await expect(
            prisma.$transaction((tx) =>
              service().transition(tx, {
                orderId: id,
                from: OrderStatus.EN_NEGOCIACION,
                actor: clientActor(client2.id),
                ...change,
              }),
            ),
          ).rejects.toThrow('El pedido venció y ya no se puede modificar.');
        }

        await expiration.expireDue();

        expect(
          await prisma.order.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          status: OrderStatus.VENCIDO,
          assignedWorkerId: null,
          expiresAt: due.expiresAt,
        });
        expect(
          (await history(id)).map((row) => [
            row.fromStatus,
            row.toStatus,
            row.actorType,
          ]),
        ).toEqual([
          [null, OrderStatus.PUBLICADO, 'USUARIO'],
          [OrderStatus.PUBLICADO, OrderStatus.EN_NEGOCIACION, 'USUARIO'],
          [OrderStatus.EN_NEGOCIACION, OrderStatus.VENCIDO, 'SISTEMA'],
        ]);
        expect(vencidosEventos.find((event) => event.orderId === id)).toEqual({
          type: 'VENCIDO',
          orderId: id,
          fromStatus: OrderStatus.EN_NEGOCIACION,
        });
      });

      it('si la tarea corre con días de atraso, vence igual y antes ya nadie podía modificarlo', async () => {
        const id = await newOrder('Cambiar las bisagras del ropero grande');
        await publishedSecondsAgo(id, SEVEN_DAYS_S + 3 * 24 * 60 * 60);

        expect((await ownView(id)).body.status).toBe(OrderStatus.VENCIDO);
        const edit = await http()
          .patch(`${BASE}/me/${id}`)
          .set('Authorization', auth(client2))
          .send({ budgetAmount: '99' })
          .expect(409);
        expect(edit.body.message).toBe(
          'El pedido venció y ya no se puede modificar.',
        );
        await http()
          .post(`${BASE}/me/${id}/cancel`)
          .set('Authorization', auth(client2))
          .send({})
          .expect(409);

        await expiration.expireDue();

        expect(await statusOf(id)).toBe(OrderStatus.VENCIDO);
        expect(await expirationHistory(id)).toHaveLength(1);
        expect(
          await prisma.order.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({ revision: 1, lastEditedAt: null });
      });

      it('tras un reinicio, la primera pasada vence lo que caducó con el servidor detenido', async () => {
        const id = await newOrder('Revisar la bomba de agua del edificio');
        await publishedSecondsAgo(id, SEVEN_DAYS_S + 60 * 60);

        // Una instancia nueva del servicio, como al arrancar el servidor, con
        // las tareas programadas activas (las pruebas e2e las desactivan).
        const previous = process.env.SCHEDULED_JOBS_ENABLED;
        process.env.SCHEDULED_JOBS_ENABLED = 'true';
        const restarted = new OrderExpirationService(
          prisma,
          app.get(OrdersConfig),
          app.get(OrderLifecycleRegistry),
          new ConfigService(),
          new SchedulerRegistry(),
        );
        try {
          restarted.onApplicationBootstrap();
          // No espera al intervalo (15 minutos): la pasada inicial lo vence.
          await vi.waitFor(
            async () => expect(await statusOf(id)).toBe(OrderStatus.VENCIDO),
            { timeout: 10_000, interval: 100 },
          );
          await vi.waitFor(
            () =>
              expect(
                (restarted as unknown as { running: boolean }).running,
              ).toBe(false),
            { timeout: 10_000, interval: 50 },
          );
        } finally {
          restarted.onModuleDestroy();
          process.env.SCHEDULED_JOBS_ENABLED = previous;
        }
        expect(await expirationHistory(id)).toHaveLength(1);
      });

      it('vencimiento y edición a la vez: un pedido vencido no se edita; uno vigente se edita sin cambiar el plazo', async () => {
        const expired = await newOrder('Arreglar la cerradura del portón');
        const active = await newOrder('Pintar el pasillo del segundo piso');
        await publishedSecondsAgo(expired, SEVEN_DAYS_S + 1);
        const activeDates = await datesOf(active);
        const edit = (id: string) =>
          http()
            .patch(`${BASE}/me/${id}`)
            .set('Authorization', auth(client2))
            .send({ budgetAmount: '321' });

        const [, expiredEdit, activeEdit] = await Promise.all([
          expiration.expireDue(),
          edit(expired),
          edit(active),
        ]);

        expect(expiredEdit.status).toBe(409);
        expect(activeEdit.status).toBe(200);
        // Si la tarea lo encontro bloqueado por la edicion, lo vence ahora.
        await expiration.expireDue();
        expect(
          await prisma.order.findUniqueOrThrow({ where: { id: expired } }),
        ).toMatchObject({ status: OrderStatus.VENCIDO, revision: 1 });
        expect(await expirationHistory(expired)).toHaveLength(1);
        expect(
          await prisma.order.findUniqueOrThrow({ where: { id: active } }),
        ).toMatchObject({
          status: OrderStatus.PUBLICADO,
          revision: 2,
          expiresAt: activeDates.expiresAt,
          publishedAt: activeDates.publishedAt,
        });
      });

      it('vencimiento y cambio de estado a la vez: el pedido vencido no avanza; el vigente avanza sin cambiar el plazo', async () => {
        const expired = await newOrder('Reparar el cielo raso del comedor');
        const active = await newOrder('Instalar dos tomacorrientes nuevos');
        await publishedSecondsAgo(expired, SEVEN_DAYS_S + 1);
        const activeDates = await datesOf(active);

        const [, expiredMove, activeMove] = await Promise.allSettled([
          expiration.expireDue(),
          toNegotiation(expired),
          toNegotiation(active),
        ]);

        expect(expiredMove.status).toBe('rejected');
        expect(activeMove.status).toBe('fulfilled');
        await expiration.expireDue();
        expect((await history(expired)).map((row) => row.toStatus)).toEqual([
          OrderStatus.PUBLICADO,
          OrderStatus.VENCIDO,
        ]);
        expect(
          await prisma.order.findUniqueOrThrow({ where: { id: active } }),
        ).toMatchObject({
          status: OrderStatus.EN_NEGOCIACION,
          expiresAt: activeDates.expiresAt,
        });
      });
    });
  });

  describe('Integracion con WorkerProfileModule (RF-13)', () => {
    it('cuenta como trabajo activo los pedidos asignados en estados activos', async () => {
      const registry = app.get(WorkerActiveWorkRegistry);
      const count = async () => {
        const result = await prisma.$transaction((tx) =>
          registry.check(worker.id, [ActiveWorkKind.PEDIDOS], tx),
        );
        expect(result.verifiable).toBe(true);
        return result.verifiable ? result.counts.PEDIDOS : -1;
      };
      expect(await count()).toBe(0);

      const res = await createOrder(
        client2,
        orderFields({ description: 'Trabajo asignado para la prueba' }),
      ).expect(201);
      const id = res.body.order.id;
      // La asignacion la hara el modulo de ofertas; aqui se simula.
      await prisma.order.update({
        where: { id },
        data: { assignedWorkerId: worker.id, status: OrderStatus.ACORDADO },
      });
      expect(await count()).toBe(1);

      await prisma.order.update({
        where: { id },
        data: { status: OrderStatus.CERRADO },
      });
      expect(await count()).toBe(0);
    });
  });

  describe('Vencimiento aislado por pedido (SAVEPOINT)', () => {
    const failures = new Map<string, 'js' | 'db'>();
    beforeAll(() => {
      app.get(OrderLifecycleRegistry).register({
        name: 'orders-e2e-fallos-vencimiento',
        inTransaction: async (event, tx) => {
          if (event.type !== 'VENCIDO') return;
          const mode = failures.get(event.orderId);
          if (mode === 'js') throw new Error('fallo js de prueba');
          // Error real de PostgreSQL: deja la transaccion abortada hasta
          // volver al SAVEPOINT.
          if (mode === 'db') await tx.$executeRaw`SELECT 1 / 0`;
        },
      });
    });

    it('un hook que falla (error JS o de BD) no detiene el vencimiento de los demas', async () => {
      const expiration = app.get(OrderExpirationService);
      const ids: string[] = [];
      for (const text of ['uno', 'dos', 'tres']) {
        const res = await createOrder(
          client2,
          orderFields({ description: `Pedido de vencimiento aislado ${text}` }),
        ).expect(201);
        ids.push(res.body.order.id);
      }
      const [dbFail, jsFail, ok] = ids;
      await prisma.$executeRaw`UPDATE "orders" SET "expires_at" = now() - interval '1 second' WHERE "id" = ANY(${ids}::uuid[])`;
      failures.set(dbFail, 'db');
      failures.set(jsFail, 'js');
      const statusOf = async (id: string) =>
        (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
      const expirations = (id: string) =>
        prisma.orderStatusHistory.count({
          where: { orderId: id, toStatus: OrderStatus.VENCIDO },
        });

      try {
        await expiration.expireDue(2);
        expect(await statusOf(ok)).toBe(OrderStatus.VENCIDO);
        for (const id of [dbFail, jsFail]) {
          expect(await statusOf(id)).toBe(OrderStatus.PUBLICADO);
          expect(await expirations(id)).toBe(0);
        }
      } finally {
        failures.clear();
      }

      // En la siguiente pasada se vencen, una sola vez cada uno.
      await expiration.expireDue();
      for (const id of ids) {
        expect(await statusOf(id)).toBe(OrderStatus.VENCIDO);
        expect(await expirations(id)).toBe(1);
      }
    });
  });

  describe('Visibilidad con catalogos o cliente inactivos (M-8)', () => {
    const detail = (id: string) =>
      http().get(`${BASE}/available/${id}`).set('Authorization', auth(worker));
    const listed = async (id: string) => {
      const res = await http()
        .get(`${BASE}/available`)
        .query({ limit: 50 })
        .set('Authorization', auth(worker))
        .expect(200);
      return res.body.data.some((o: { id: string }) => o.id === id);
    };
    const openForOffers = (id: string) =>
      prisma.$transaction((tx) =>
        app.get(OrderVisibilityService).assertOpenForOffers(tx, worker.id, id),
      );
    let id: string;
    beforeAll(async () => {
      const res = await createOrder(
        client2,
        orderFields({ description: 'Pedido para probar la visibilidad M-8' }),
      ).expect(201);
      id = res.body.order.id;
    });

    const expectHidden = async () => {
      await detail(id).expect(404);
      expect(await listed(id)).toBe(false);
      await expect(openForOffers(id)).rejects.toThrow(NotFoundException);
      // El cliente dueno lo sigue viendo.
      await expect(
        app.get(OrdersService).getOwn(client2.id, id),
      ).resolves.toMatchObject({ id });
    };

    it('es visible mientras todo esta activo', async () => {
      await detail(id).expect(200);
      expect(await listed(id)).toBe(true);
    });

    it.each([UserStatus.SUSPENDIDO, UserStatus.INACTIVO])(
      'se oculta si la cuenta del cliente esta %s',
      async (status) => {
        await prisma.user.update({
          where: { id: client2.id },
          data: { status },
        });
        try {
          await expectHidden();
        } finally {
          await prisma.user.update({
            where: { id: client2.id },
            data: { status: UserStatus.ACTIVO },
          });
        }
        await detail(id).expect(200);
      },
    );

    it('se oculta si la categoria o la zona se desactivan', async () => {
      for (const table of ['category', 'zone'] as const) {
        const setActive = (isActive: boolean) =>
          table === 'category'
            ? prisma.serviceCategory.update({
                where: { id: catA.id },
                data: { isActive },
              })
            : prisma.zone.update({
                where: { id: zoneA.id },
                data: { isActive },
              });
        await setActive(false);
        try {
          await expectHidden();
        } finally {
          await setActive(true);
        }
        await detail(id).expect(200);
      }
    });
  });

  describe('Revision final: catalogos FOR SHARE y ediciones dentro del bloqueo', () => {
    /** Retiene una transaccion abierta hasta llamar a release(). */
    const holdTransaction = async (
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => (markReady = resolve));
      const done = prisma.$transaction(
        async (tx) => {
          await work(tx);
          markReady();
          await held;
        },
        { timeout: 15_000 },
      );
      await ready;
      return { release, done };
    };
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it('assertOpenForOffers bloquea la zona: una desactivacion espera a la oferta', async () => {
      const res = await createOrder(
        client2,
        orderFields({ description: 'Pedido para el bloqueo de catalogos' }),
      ).expect(201);
      const id = res.body.order.id;
      const offer = await holdTransaction((tx) =>
        app.get(OrderVisibilityService).assertOpenForOffers(tx, worker.id, id),
      );

      let deactivated = false;
      const deactivation =
        prisma.$executeRaw`UPDATE "zones" SET "is_active" = false WHERE "id" = ${zoneA.id}::uuid`.then(
          () => {
            deactivated = true;
          },
        );
      try {
        await pause(300);
        expect(deactivated).toBe(false);
      } finally {
        offer.release();
        await offer.done;
        await deactivation;
        await prisma.zone.update({
          where: { id: zoneA.id },
          data: { isActive: true },
        });
      }
      expect(deactivated).toBe(true);
    });

    it('create() vuelve a validar la zona dentro de su transaccion y compensa las fotos', async () => {
      const before = await filesOnDisk();
      // Desactivacion en curso: el pedido pasa la comprobacion previa (aun
      // activa), procesa las fotos y espera la fila con FOR SHARE.
      const adminTx = await holdTransaction(
        (tx) =>
          tx.$executeRaw`UPDATE "zones" SET "is_active" = false WHERE "id" = ${zoneA.id}::uuid`,
      );
      const request = createOrder(
        client2,
        orderFields({ description: 'Pedido creado durante la desactivacion' }),
      ).then((res) => res);
      try {
        await pause(500);
      } finally {
        adminTx.release();
        await adminTx.done;
      }
      try {
        const res = await request;
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('no está activa');
        expect(await filesOnDisk()).toEqual(before);
      } finally {
        await prisma.zone.update({
          where: { id: zoneA.id },
          data: { isActive: true },
        });
      }
    });

    it('M-5: los cambios se calculan con el pedido bloqueado, no contra datos viejos', async () => {
      const original = 'Descripcion original del pedido de prueba';
      const res = await createOrder(
        client2,
        orderFields({ description: original }),
      ).expect(201);
      const id = res.body.order.id;
      // Otra edicion (A) toma el pedido y cambia la descripcion.
      const other = await holdTransaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${id}::uuid FOR UPDATE`;
        await tx.order.update({
          where: { id },
          data: { description: 'Descripcion cambiada por otra edicion' },
        });
      });
      // La edicion B pide el texto original mientras A sigue abierta.
      const edit = http()
        .patch(`${BASE}/me/${id}`)
        .set('Authorization', auth(client2))
        .send({ description: original })
        .then((r) => r);
      try {
        await pause(300);
      } finally {
        other.release();
        await other.done;
      }
      const result = await edit;
      // B compara contra lo que dejo A: hay cambio real y se aplica.
      expect(result.status).toBe(200);
      expect(result.body.order).toMatchObject({
        description: original,
        revision: 2,
      });
    });
  });
});
