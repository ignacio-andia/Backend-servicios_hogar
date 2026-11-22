import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import {
  AuditAction,
  AuditEntityType,
  RoleName,
  UserStatus,
  WeekDay,
  WorkerProfileStatus,
  ZoneChangeRequestStatus,
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
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from '../src/modules/worker-profile/active-work.registry.js';
import { WorkerProfileService } from '../src/modules/worker-profile/worker-profile.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deleteWorkerData } from './utils/worker-profile-cleanup.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@worker-e2e.test';
const label = (text: string) => `${text} ${RUN_ID}`;
const BASE = '/api/worker-profile';

const PDF = Buffer.from('%PDF-1.7\n% documento de prueba e2e\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

describe('WorkerProfileModule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let catalogs: CatalogsService;
  let profiles: WorkerProfileService;
  let storageDir: string;

  let worker: PublicUser;
  let worker2: PublicUser;
  let client: PublicUser;
  let admin: PublicUser;
  let catA: CatalogItem;
  let catB: CatalogItem;
  let catOff: CatalogItem;
  let zoneA: CatalogItem;
  let zoneB: CatalogItem;
  let zoneC: CatalogItem;
  let zoneOff: CatalogItem;

  let profileId: string;
  let identityDocId: string;

  const http = () => request(app.getHttpServer());
  const auth = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const validProfile = () => ({
    yearsOfExperience: 7,
    description: 'Plomero con experiencia en instalaciones',
    zoneId: zoneA.id,
    categoryIds: [catA.id],
    schedules: [
      { dayOfWeek: 'LUNES', startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 'LUNES', startTime: '14:00', endTime: '18:00' },
    ],
  });
  const upload = (
    user: PublicUser,
    type: string,
    content: Buffer,
    name: string,
  ) =>
    http()
      .post(`${BASE}/me/documents`)
      .set('Authorization', auth(user))
      .field('type', type)
      .attach('file', content, { filename: name });

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'worker-docs-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    process.env.WORKER_DOCUMENT_MAX_MB = '1';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    catalogs = app.get(CatalogsService);
    profiles = app.get(WorkerProfileService);
    const users = app.get(UsersService);

    const newUser = (name: string, phone?: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}${EMAIL_DOMAIN}`,
        passwordHash: 'hash',
        phone,
      });
    worker = await newUser('worker', '70000000');
    worker2 = await newUser('worker2');
    client = await newUser('client');
    admin = await newUser('admin');
    await prisma.userRole.createMany({
      data: [
        // worker empieza solo como CLIENTE: recibe TRABAJADOR al crear su perfil.
        // worker2 ya tenia el rol (por ejemplo, asignado por un administrador).
        { userId: worker2.id, role: RoleName.TRABAJADOR },
        { userId: admin.id, role: RoleName.ADMINISTRADOR },
      ],
    });
    // Cuenta solo administradora: sin rol de cliente ni de trabajador.
    await prisma.userRole.delete({
      where: { userId_role: { userId: admin.id, role: RoleName.CLIENTE } },
    });
    admin = await users.findById(admin.id);

    const newCatalog = (kind: CatalogKind, name: string) =>
      catalogs.create(kind, admin.id, { name: label(name) });
    catA = await newCatalog(CatalogKind.CATEGORY, 'Categoria A');
    catB = await newCatalog(CatalogKind.CATEGORY, 'Categoria B');
    catOff = await newCatalog(CatalogKind.CATEGORY, 'Categoria Off');
    await catalogs.deactivate(CatalogKind.CATEGORY, admin.id, catOff.id);
    zoneA = await newCatalog(CatalogKind.ZONE, 'Zona A');
    zoneB = await newCatalog(CatalogKind.ZONE, 'Zona B');
    zoneC = await newCatalog(CatalogKind.ZONE, 'Zona C');
    zoneOff = await newCatalog(CatalogKind.ZONE, 'Zona Off');
    await catalogs.deactivate(CatalogKind.ZONE, admin.id, zoneOff.id);
  });

  afterAll(async () => {
    const userIds = [worker.id, worker2.id, client.id, admin.id];
    await deleteWorkerData(prisma, userIds);
    await prisma.serviceCategory.deleteMany({
      where: { name: { contains: RUN_ID } },
    });
    await prisma.zone.deleteMany({ where: { name: { contains: RUN_ID } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.FILE_STORAGE_DIR;
    delete process.env.WORKER_DOCUMENT_MAX_MB;
  });

  describe('acceso', () => {
    it('exige sesion (401)', () => http().get(`${BASE}/me`).expect(401));

    it('una cuenta sin rol de cliente ni de trabajador no crea perfil (403)', () =>
      http()
        .post(BASE)
        .set('Authorization', auth(admin))
        .send(validProfile())
        .expect(403));

    it('sin el rol TRABAJADOR no accede a las funciones del perfil (403)', () =>
      http().get(`${BASE}/me`).set('Authorization', auth(worker)).expect(403));

    it('responde 404 si aun no tiene perfil', () =>
      http().get(`${BASE}/me`).set('Authorization', auth(worker2)).expect(404));
  });

  describe('RF-06: creacion y validaciones', () => {
    it.each([
      ['sin zona', { zoneId: undefined }],
      ['sin especialidades', { categoryIds: [] }],
      ['anos de experiencia negativos', { yearsOfExperience: -1 }],
      ['especialidades repetidas', { categoryIds: ['dup', 'dup'] }],
      ['un estado', { status: 'APROBADO' }],
      [
        'hora con formato invalido',
        {
          schedules: [
            { dayOfWeek: 'LUNES', startTime: '8:00', endTime: '12:00' },
          ],
        },
      ],
      [
        'dia invalido',
        {
          schedules: [
            { dayOfWeek: 'FERIADO', startTime: '08:00', endTime: '12:00' },
          ],
        },
      ],
    ])('responde 400 %s', async (_label, override) => {
      await http()
        .post(BASE)
        .set('Authorization', auth(worker))
        .send({ ...validProfile(), ...override })
        .expect(400);
    });

    it('rechaza una categoria inactiva', async () => {
      const res = await http()
        .post(BASE)
        .set('Authorization', auth(worker))
        .send({ ...validProfile(), categoryIds: [catA.id, catOff.id] })
        .expect(400);

      expect(res.body.message).toEqual([
        `La categoría "${catOff.name}" no está activa`,
      ]);
    });

    it('rechaza una zona inactiva (400) o inexistente (404)', async () => {
      await http()
        .post(BASE)
        .set('Authorization', auth(worker))
        .send({ ...validProfile(), zoneId: zoneOff.id })
        .expect(400);
      await http()
        .post(BASE)
        .set('Authorization', auth(worker))
        .send({ ...validProfile(), zoneId: randomUUID() })
        .expect(404);
    });

    it.each([
      [
        'fin anterior al inicio',
        [{ dayOfWeek: 'MARTES', startTime: '12:00', endTime: '08:00' }],
      ],
      [
        'intervalos superpuestos',
        [
          { dayOfWeek: 'MARTES', startTime: '08:00', endTime: '12:00' },
          { dayOfWeek: 'MARTES', startTime: '11:30', endTime: '13:00' },
        ],
      ],
    ])('valida horarios: %s', async (_label, schedules) => {
      await http()
        .post(BASE)
        .set('Authorization', auth(worker))
        .send({ ...validProfile(), schedules })
        .expect(400);
    });

    it('los intentos rechazados no otorgan el rol TRABAJADOR', async () => {
      expect(
        await prisma.userRole.count({
          where: { userId: worker.id, role: RoleName.TRABAJADOR },
        }),
      ).toBe(0);
    });

    it('crea el perfil en BORRADOR sin duplicar datos de la cuenta', async () => {
      const res = await http()
        .post(BASE)
        .set('Authorization', auth(worker))
        .send(validProfile())
        .expect(201);

      expect(res.body).toMatchObject({
        userId: worker.id,
        status: WorkerProfileStatus.BORRADOR,
        yearsOfExperience: 7,
        zone: { id: zoneA.id, isActive: true },
        zoneRequiresChange: false,
        specialties: [{ id: catA.id }],
        schedules: [
          {
            dayOfWeek: 'LUNES',
            startTime: '08:00',
            endTime: '12:00',
            isActive: true,
          },
          {
            dayOfWeek: 'LUNES',
            startTime: '14:00',
            endTime: '18:00',
            isActive: true,
          },
        ],
        pendingRequirements: [],
        canSubmit: true,
      });
      expect(res.body).not.toHaveProperty('email');
      expect(res.body).not.toHaveProperty('phone');
      profileId = res.body.id;
    });

    it('al crear el perfil, la cuenta de cliente recibe el rol TRABAJADOR', async () => {
      const account = await http()
        .get('/api/auth/me')
        .set('Authorization', auth(worker))
        .expect(200);
      expect(account.body.roles).toEqual([
        RoleName.CLIENTE,
        RoleName.TRABAJADOR,
      ]);

      // El mismo token sirve: los roles se leen de la BD en cada peticion.
      await http()
        .get(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .expect(200);

      // El rol no implica aprobacion (RF-03).
      const eligibility = await http()
        .get(`${BASE}/me/eligibility`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(eligibility.body).toMatchObject({
        eligible: false,
        status: 'BORRADOR',
      });
    });

    it('impide un segundo perfil para la misma cuenta (409)', () =>
      http()
        .post(BASE)
        .set('Authorization', auth(worker))
        .send(validProfile())
        .expect(409));

    it('en BORRADOR permite elegir otra zona activa directamente', async () => {
      const res = await http()
        .patch(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .send({ zoneId: zoneB.id })
        .expect(200);

      expect(res.body.zone.id).toBe(zoneB.id);
    });

    it('gestiona especialidades solo con categorias activas', async () => {
      await http()
        .put(`${BASE}/me/specialties`)
        .set('Authorization', auth(worker))
        .send({ categoryIds: [catOff.id] })
        .expect(400);

      const res = await http()
        .put(`${BASE}/me/specialties`)
        .set('Authorization', auth(worker))
        .send({ categoryIds: [catA.id, catB.id] })
        .expect(200);

      expect(
        res.body.specialties.map((c: { id: string }) => c.id).sort(),
      ).toEqual([catA.id, catB.id].sort());
    });

    it('gestiona horarios y rechaza intervalos contradictorios', async () => {
      await http()
        .put(`${BASE}/me/schedules`)
        .set('Authorization', auth(worker))
        .send({
          schedules: [
            { dayOfWeek: 'MIERCOLES', startTime: '09:00', endTime: '13:00' },
            {
              dayOfWeek: 'MIERCOLES',
              startTime: '10:00',
              endTime: '11:00',
              isActive: false,
            },
          ],
        })
        .expect(400);

      const res = await http()
        .put(`${BASE}/me/schedules`)
        .set('Authorization', auth(worker))
        .send({
          schedules: [
            { dayOfWeek: 'MIERCOLES', startTime: '09:00', endTime: '13:00' },
            {
              dayOfWeek: 'SABADO',
              startTime: '08:00',
              endTime: '24:00',
              isActive: false,
            },
          ],
        })
        .expect(200);

      expect(res.body.schedules).toHaveLength(2);
    });
  });

  describe('RF-07: documentos privados', () => {
    it('adjunta un documento permitido sin exponer la ruta interna', async () => {
      const res = await upload(worker, 'IDENTIDAD', PDF, 'cedula.pdf').expect(
        201,
      );

      expect(res.body).toMatchObject({
        type: 'IDENTIDAD',
        originalName: 'cedula.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        replacedAt: null,
      });
      expect(res.body).not.toHaveProperty('storageKey');
      expect(JSON.stringify(res.body)).not.toContain(storageDir);
      identityDocId = res.body.id;

      const stored = await readdir(path.join(storageDir, 'worker-documents'));
      expect(stored).toHaveLength(1);
      expect(stored[0]).not.toContain('cedula');
    });

    it('acepta imagenes y ningun tipo es obligatorio', async () => {
      await upload(worker, 'CERTIFICADO', PNG, 'certificado.png').expect(201);
    });

    it('rechaza formatos no permitidos, aunque la extension diga PDF', async () => {
      const text = await upload(
        worker,
        'REFERENCIA',
        Buffer.from('hola'),
        'notas.txt',
      ).expect(400);
      const disguised = await upload(
        worker,
        'REFERENCIA',
        Buffer.from('MZ ejecutable'),
        'referencia.pdf',
      ).expect(400);

      expect(text.body.message).toContain('Formato de archivo no permitido');
      expect(disguised.body.message).toContain(
        'Formato de archivo no permitido',
      );
    });

    it('rechaza archivos que superan el tamano maximo con un mensaje claro', async () => {
      const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]);
      const res = await upload(
        worker,
        'ANTECEDENTES',
        big,
        'grande.pdf',
      ).expect(413);

      expect(res.body.message).toBe(
        'El archivo supera el tamaño máximo permitido de 1 MB',
      );
    });

    it('rechaza un tipo de documento desconocido o un envio sin archivo', async () => {
      await upload(worker, 'PASAPORTE', PDF, 'x.pdf').expect(400);
      await http()
        .post(`${BASE}/me/documents`)
        .set('Authorization', auth(worker))
        .field('type', 'IDENTIDAD')
        .expect(400);
    });

    it('descarga el documento propio como adjunto privado', async () => {
      const res = await http()
        .get(`${BASE}/me/documents/${identityDocId}/download`)
        .set('Authorization', auth(worker))
        .responseType('blob')
        .expect(200);

      expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('otro trabajador no puede ver ni reemplazar documentos ajenos (404)', async () => {
      await http()
        .post(BASE)
        .set('Authorization', auth(worker2))
        .send({ ...validProfile(), schedules: [] })
        .expect(201);

      await http()
        .get(`${BASE}/me/documents/${identityDocId}/download`)
        .set('Authorization', auth(worker2))
        .expect(404);
      await http()
        .post(`${BASE}/me/documents/${identityDocId}/replace`)
        .set('Authorization', auth(worker2))
        .attach('file', PDF, { filename: 'x.pdf' })
        .expect(404);
      const list = await http()
        .get(`${BASE}/me/documents`)
        .set('Authorization', auth(worker2))
        .expect(200);
      expect(list.body).toEqual([]);
    });

    it('clientes y visitantes no acceden a documentos', async () => {
      await http()
        .get(`${BASE}/me/documents/${identityDocId}/download`)
        .set('Authorization', auth(client))
        .expect(403);
      await http()
        .get(`${BASE}/me/documents/${identityDocId}/download`)
        .expect(401);
    });
  });

  describe('RF-06 y RF-08: envio a revision e historial', () => {
    it('indica que falta para poder enviar', async () => {
      const res = await http()
        .post(`${BASE}/me/submit`)
        .set('Authorization', auth(worker2))
        .expect(400);

      expect(res.body.message).toEqual([
        'Registre un teléfono de contacto en su cuenta',
        'Defina al menos un horario de atención activo',
      ]);
    });

    it('no existe forma de que el trabajador se asigne un estado', async () => {
      await http()
        .patch(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .send({ status: 'APROBADO' })
        .expect(400);
      await http()
        .patch(`${BASE}/me/status`)
        .set('Authorization', auth(worker))
        .send({ status: 'APROBADO' })
        .expect(404);
    });

    it('envia el perfil y queda PENDIENTE', async () => {
      const res = await http()
        .post(`${BASE}/me/submit`)
        .set('Authorization', auth(worker))
        .expect(200);

      expect(res.body).toMatchObject({
        status: WorkerProfileStatus.PENDIENTE,
        canEdit: false,
        canSubmit: false,
      });
      expect(res.body.submittedAt).toBeTruthy();
    });

    it('en revision no se editan datos ni documentos, pero si horarios', async () => {
      await http()
        .patch(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .send({ yearsOfExperience: 8 })
        .expect(409);
      await upload(worker, 'REFERENCIA', PDF, 'ref.pdf').expect(409);
      await http()
        .post(`${BASE}/me/submit`)
        .set('Authorization', auth(worker))
        .expect(409);
      await http()
        .put(`${BASE}/me/schedules`)
        .set('Authorization', auth(worker))
        .send({
          schedules: [
            { dayOfWeek: 'MIERCOLES', startTime: '09:00', endTime: '13:00' },
          ],
        })
        .expect(200);
    });

    it('un perfil no aprobado no es elegible para funciones de trabajador', async () => {
      const res = await http()
        .get(`${BASE}/me/eligibility`)
        .set('Authorization', auth(worker))
        .expect(200);

      expect(res.body).toMatchObject({
        eligible: false,
        status: WorkerProfileStatus.PENDIENTE,
      });
      await expect(
        profiles.assertWorkerApproved(worker.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        profiles.findApprovedWorkers({ categoryId: catA.id, zoneId: zoneB.id }),
      ).resolves.toEqual([]);
    });

    it('una observacion del administrador queda en historial y bitacora', async () => {
      await profiles.changeStatusByAdmin(admin.id, profileId, {
        status: WorkerProfileStatus.OBSERVADO,
        reason: 'La foto de la cédula no es legible',
      });

      const res = await http()
        .get(`${BASE}/me/status`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(res.body).toMatchObject({
        status: WorkerProfileStatus.OBSERVADO,
        statusReason: 'La foto de la cédula no es legible',
      });
      expect(
        res.body.history.map((h: { toStatus: string; changedBy: string }) => [
          h.toStatus,
          h.changedBy,
        ]),
      ).toEqual([
        ['OBSERVADO', 'ADMINISTRADOR'],
        ['PENDIENTE', 'TRABAJADOR'],
        ['BORRADOR', 'TRABAJADOR'],
      ]);
      expect(JSON.stringify(res.body)).not.toContain(admin.id);

      const log = await prisma.adminAuditLog.findFirst({
        where: { entityId: profileId, action: AuditAction.CAMBIO_ESTADO },
      });
      expect(log).toMatchObject({
        actorId: admin.id,
        entityType: AuditEntityType.PERFIL_TRABAJADOR,
      });
    });

    it('un perfil OBSERVADO se corrige y se reenvia a PENDIENTE', async () => {
      await http()
        .patch(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .send({ zoneId: zoneC.id })
        .expect(403);
      await http()
        .patch(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .send({ description: 'Descripción corregida' })
        .expect(200);

      const replaced = await http()
        .post(`${BASE}/me/documents/${identityDocId}/replace`)
        .set('Authorization', auth(worker))
        .attach('file', PNG, { filename: 'cedula-legible.png' })
        .expect(201);
      expect(replaced.body).toMatchObject({
        type: 'IDENTIDAD',
        mimeType: 'image/png',
      });

      const res = await http()
        .post(`${BASE}/me/submit`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(res.body.status).toBe(WorkerProfileStatus.PENDIENTE);
    });

    it('el reemplazo conserva el documento anterior en el historial', async () => {
      const res = await http()
        .get(`${BASE}/me/documents`)
        .set('Authorization', auth(worker))
        .expect(200);
      const identity = res.body.filter(
        (d: { type: string }) => d.type === 'IDENTIDAD',
      );

      expect(identity).toHaveLength(2);
      const old = identity.find((d: { id: string }) => d.id === identityDocId);
      const current = identity.find(
        (d: { id: string }) => d.id !== identityDocId,
      );
      expect(old).toMatchObject({ replacedById: current.id });
      expect(old.replacedAt).toBeTruthy();
      expect(current.replacedAt).toBeNull();

      await http()
        .get(`${BASE}/me/documents/${identityDocId}/download`)
        .set('Authorization', auth(worker))
        .expect(200);
    });

    it('el historial de estados no se puede modificar ni borrar', async () => {
      const entry = await prisma.workerProfileStatusHistory.findFirstOrThrow({
        where: { profileId },
      });

      await expect(
        prisma.workerProfileStatusHistory.update({
          where: { id: entry.id },
          data: { reason: 'alterado' },
        }),
      ).rejects.toThrow(/solo inserción/);
      await expect(
        prisma.workerProfileStatusHistory.deleteMany({ where: { profileId } }),
      ).rejects.toThrow(/solo inserción/);
    });

    it('no se aprueba un perfil PENDIENTE que dejo de cumplir los requisitos', async () => {
      await http()
        .patch(`/api/users/${worker.id}`)
        .set('Authorization', auth(worker))
        .send({ phone: null })
        .expect(200);

      await expect(
        profiles.changeStatusByAdmin(admin.id, profileId, {
          status: WorkerProfileStatus.APROBADO,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          message: [
            'El perfil no cumple los requisitos para ser aprobado. Obsérvelo para que el trabajador lo corrija.',
            'Registre un teléfono de contacto en su cuenta',
          ],
        },
      });
      const status = await http()
        .get(`${BASE}/me/status`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(status.body.status).toBe(WorkerProfileStatus.PENDIENTE);

      await http()
        .patch(`/api/users/${worker.id}`)
        .set('Authorization', auth(worker))
        .send({ phone: '70000000' })
        .expect(200);
    });

    it('un perfil APROBADO es elegible y aparece entre los habilitados', async () => {
      await profiles.changeStatusByAdmin(admin.id, profileId, {
        status: WorkerProfileStatus.APROBADO,
      });

      const res = await http()
        .get(`${BASE}/me/eligibility`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(res.body).toMatchObject({ eligible: true, status: 'APROBADO' });
      await expect(
        profiles.assertWorkerApproved(worker.id),
      ).resolves.toMatchObject({
        profileId,
        zoneId: zoneB.id,
      });
      const approved = await profiles.findApprovedWorkers({
        categoryId: catB.id,
        zoneId: zoneB.id,
      });
      expect(approved.map((w) => w.userId)).toEqual([worker.id]);
      await expect(
        profiles.findApprovedWorkers({ categoryId: catB.id, zoneId: zoneA.id }),
      ).resolves.toEqual([]);
    });
  });

  describe('RF-13: zona fija y solicitudes de cambio', () => {
    // OrdersModule ya registra la fuente PEDIDOS (pedidos asignados). El
    // modulo de ofertas todavia no existe: las pruebas que lo necesitan
    // registran una fuente de prueba; la aplicacion real no lo hace.
    let activeOffers = 0;
    let rejectedId: string;

    const requestChange = (toZoneId: string, reason = 'Me mudé de barrio') =>
      http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId, reason });
    const zoneStatus = () =>
      http()
        .get(`${BASE}/me/zone`)
        .set('Authorization', auth(worker))
        .expect(200);
    const decide = (requestId: string, body: object, user = admin) =>
      http()
        .patch(`${BASE}/admin/zone-change-requests/${requestId}`)
        .set('Authorization', auth(user))
        .send(body);

    it('impide cambiar la zona directamente', () =>
      http()
        .patch(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .send({ zoneId: zoneC.id })
        .expect(403));

    it('sin la verificacion de ofertas, bloquea la solicitud e informa el motivo', async () => {
      const status = await zoneStatus();
      expect(status.body).toMatchObject({
        currentZone: { id: zoneB.id },
        pendingRequest: null,
        canRequestChange: false,
        blockers: [{ code: 'VERIFICACION_NO_DISPONIBLE' }],
      });

      const res = await requestChange(zoneC.id).expect(409);
      expect(res.body.message[0]).toContain(
        'no se puede verificar si tiene ofertas activos',
      );
      expect(
        await prisma.zoneChangeRequest.count({ where: { profileId } }),
      ).toBe(0);
    });

    it('con pedidos u ofertas activos bloquea la solicitud e informa el motivo', async () => {
      const registry = app.get(WorkerActiveWorkRegistry);
      registry.register({
        kind: ActiveWorkKind.OFERTAS,
        countActive: () => Promise.resolve(activeOffers),
      });
      activeOffers = 1;

      const blocked = await zoneStatus();
      expect(blocked.body.blockers).toMatchObject([{ code: 'TRABAJO_ACTIVO' }]);
      const res = await requestChange(zoneC.id).expect(409);
      expect(res.body.message).toEqual([
        'No puede solicitar un cambio de zona mientras tenga trabajo activo (1 ofertas activos).',
      ]);

      activeOffers = 0;
      const allowed = await zoneStatus();
      expect(allowed.body).toMatchObject({
        canRequestChange: true,
        blockers: [],
      });
    });

    it('valida la zona solicitada', async () => {
      await requestChange(zoneOff.id).expect(400);
      await requestChange(zoneB.id).expect(400);
      await requestChange(randomUUID()).expect(404);
      await http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId: zoneC.id })
        .expect(400);
    });

    it('registra la solicitud sin cambiar la zona y no admite otra pendiente', async () => {
      const res = await requestChange(zoneC.id).expect(201);
      expect(res.body).toMatchObject({
        status: ZoneChangeRequestStatus.PENDIENTE,
        fromZone: { id: zoneB.id },
        toZone: { id: zoneC.id },
        decidedAt: null,
      });
      rejectedId = res.body.id;

      const status = await zoneStatus();
      expect(status.body).toMatchObject({
        currentZone: { id: zoneB.id },
        pendingRequest: { id: rejectedId },
        canRequestChange: false,
        blockers: [{ code: 'SOLICITUD_PENDIENTE' }],
      });
      const me = await http()
        .get(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(me.body.zone.id).toBe(zoneB.id);

      const duplicate = await requestChange(zoneA.id, 'Otra solicitud').expect(
        409,
      );
      expect(duplicate.body.message).toEqual([
        'Ya tiene una solicitud de cambio de zona pendiente',
      ]);
    });

    it('las operaciones administrativas exigen rol administrador', async () => {
      await http()
        .get(`${BASE}/admin/zone-change-requests`)
        .set('Authorization', auth(worker))
        .expect(403);
      await http().get(`${BASE}/admin/zone-change-requests`).expect(401);
      await decide(rejectedId, { decision: 'APROBADA' }, worker).expect(403);
      await decide(rejectedId, { decision: 'APROBADA' }, client).expect(403);
    });

    it('el administrador consulta las solicitudes con datos del trabajador y zonas', async () => {
      const list = await http()
        .get(`${BASE}/admin/zone-change-requests`)
        .query({ status: 'PENDIENTE', workerUserId: worker.id })
        .set('Authorization', auth(admin))
        .expect(200);
      expect(list.body.meta).toMatchObject({ total: 1 });
      expect(list.body.data[0]).toMatchObject({
        id: rejectedId,
        status: 'PENDIENTE',
        reason: 'Me mudé de barrio',
        fromZone: { id: zoneB.id, name: zoneB.name },
        toZone: { id: zoneC.id, name: zoneC.name },
        decidedBy: null,
        worker: {
          userId: worker.id,
          profileId,
          email: worker.email,
          phone: '70000000',
          profileStatus: WorkerProfileStatus.APROBADO,
          currentZone: { id: zoneB.id },
        },
      });

      const detail = await http()
        .get(`${BASE}/admin/zone-change-requests/${rejectedId}`)
        .set('Authorization', auth(admin))
        .expect(200);
      expect(detail.body.id).toBe(rejectedId);
      await http()
        .get(`${BASE}/admin/zone-change-requests/${randomUUID()}`)
        .set('Authorization', auth(admin))
        .expect(404);
      await http()
        .get(`${BASE}/admin/zone-change-requests/123`)
        .set('Authorization', auth(admin))
        .expect(400);
    });

    it('si se rechaza, el trabajador conserva su zona (motivo opcional)', async () => {
      await decide(rejectedId, { decision: 'PENDIENTE' }).expect(400);

      const res = await decide(rejectedId, { decision: 'RECHAZADA' }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        status: 'RECHAZADA',
        decisionComment: null,
        decidedBy: { id: admin.id },
      });
      expect(res.body.decidedAt).toBeTruthy();

      const me = await http()
        .get(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(me.body.zone.id).toBe(zoneB.id);
      const again = await decide(rejectedId, { decision: 'APROBADA' }).expect(
        409,
      );
      expect(again.body.message).toBe('La solicitud ya fue resuelta');
    });

    it('si se aprueba, la nueva zona reemplaza a la anterior', async () => {
      const created = await requestChange(zoneC.id, 'Nuevo domicilio').expect(
        201,
      );
      await decide(created.body.id, {
        decision: 'APROBADA',
        comment: 'Domicilio verificado',
      }).expect(200);

      const status = await zoneStatus();
      expect(status.body).toMatchObject({
        currentZone: { id: zoneC.id },
        pendingRequest: null,
        canRequestChange: true,
      });
    });

    it('conserva el historial de solicitudes y resoluciones', async () => {
      const own = await http()
        .get(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(
        own.body.map(
          (r: { status: string; decisionComment: string | null }) => [
            r.status,
            r.decisionComment,
          ],
        ),
      ).toEqual([
        ['APROBADA', 'Domicilio verificado'],
        ['RECHAZADA', null],
      ]);

      const resolved = await http()
        .get(`${BASE}/admin/zone-change-requests`)
        .query({ resolved: true, workerUserId: worker.id })
        .set('Authorization', auth(admin))
        .expect(200);
      expect(resolved.body.meta.total).toBe(2);
      expect(
        resolved.body.data.every(
          (r: { decidedBy: { id: string } }) => r.decidedBy.id === admin.id,
        ),
      ).toBe(true);

      const logs = await prisma.adminAuditLog.findMany({
        where: {
          entityType: AuditEntityType.SOLICITUD_CAMBIO_ZONA,
          actorId: admin.id,
        },
      });
      expect(logs.map((l) => l.action).sort()).toEqual([
        'APROBACION',
        'RECHAZO',
      ]);
    });

    it('la BD impide borrar o reescribir el historial', async () => {
      await expect(
        prisma.zoneChangeRequest.update({
          where: { id: rejectedId },
          data: { status: ZoneChangeRequestStatus.APROBADA },
        }),
      ).rejects.toThrow(/ya resuelta no se puede modificar/);
      await expect(
        prisma.zoneChangeRequest.deleteMany({ where: { profileId } }),
      ).rejects.toThrow(/no se pueden eliminar/);
      expect(
        await prisma.zoneChangeRequest.count({ where: { profileId } }),
      ).toBe(2);
    });

    it('no se aprueba hacia una zona desactivada, pero si se puede rechazar', async () => {
      const zoneD = await catalogs.create(CatalogKind.ZONE, admin.id, {
        name: label('Zona D'),
      });
      const created = await requestChange(zoneD.id, 'Zona nueva').expect(201);
      await catalogs.deactivate(CatalogKind.ZONE, admin.id, zoneD.id);

      const detail = await http()
        .get(`${BASE}/admin/zone-change-requests/${created.body.id}`)
        .set('Authorization', auth(admin))
        .expect(200);
      expect(detail.body.toZone).toMatchObject({
        id: zoneD.id,
        isActive: false,
      });

      const approve = await decide(created.body.id, {
        decision: 'APROBADA',
      }).expect(409);
      expect(approve.body.message).toBe(
        `No se puede aprobar: la zona solicitada "${zoneD.name}" fue desactivada. Rechace la solicitud para que el trabajador pueda pedir otra zona.`,
      );
      const pending = await zoneStatus();
      expect(pending.body).toMatchObject({
        currentZone: { id: zoneC.id },
        pendingRequest: { id: created.body.id },
      });

      await decide(created.body.id, { decision: 'RECHAZADA' }).expect(200);
      const after = await zoneStatus();
      expect(after.body).toMatchObject({
        currentZone: { id: zoneC.id },
        pendingRequest: null,
      });
    });

    it('de dos solicitudes simultaneas solo una queda pendiente', async () => {
      const responses = await Promise.all(
        [zoneA.id, zoneB.id].map((toZoneId) =>
          requestChange(toZoneId, 'Solicitud simultánea'),
        ),
      );

      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
    });

    it('los datos originales de una solicitud pendiente no se pueden reescribir', async () => {
      const pending = await prisma.zoneChangeRequest.findFirstOrThrow({
        where: { profileId, status: ZoneChangeRequestStatus.PENDIENTE },
      });

      await expect(
        prisma.zoneChangeRequest.update({
          where: { id: pending.id },
          data: { reason: 'Motivo alterado' },
        }),
      ).rejects.toThrow(/datos originales/);
    });
  });

  describe('RF-49: zona desactivada', () => {
    it('no cambia la zona del trabajador y lo marca como afectado', async () => {
      await catalogs.deactivate(CatalogKind.ZONE, admin.id, zoneC.id);

      const me = await http()
        .get(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(me.body).toMatchObject({
        zone: { id: zoneC.id, isActive: false },
        zoneRequiresChange: true,
      });
    });

    it('el administrador identifica los perfiles afectados', async () => {
      const res = await http()
        .get(`${BASE}/admin/inactive-zone-profiles`)
        .query({ zoneId: zoneC.id })
        .set('Authorization', auth(admin))
        .expect(200);

      expect(res.body).toEqual([
        {
          profileId,
          userId: worker.id,
          status: WorkerProfileStatus.APROBADO,
          zone: { id: zoneC.id, name: zoneC.name },
          hasPendingZoneChangeRequest: true,
        },
      ]);
    });

    it('la consulta de perfiles afectados es solo para administradores', async () => {
      await http()
        .get(`${BASE}/admin/inactive-zone-profiles`)
        .set('Authorization', auth(worker))
        .expect(403);
      await http().get(`${BASE}/admin/inactive-zone-profiles`).expect(401);
    });
  });

  describe('suspension', () => {
    it('un perfil suspendido deja de ser elegible e informa el motivo', async () => {
      await profiles.changeStatusByAdmin(admin.id, profileId, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Reclamos reiterados',
      });

      const res = await http()
        .get(`${BASE}/me/eligibility`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(res.body).toMatchObject({
        eligible: false,
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Reclamos reiterados',
      });
      await expect(profiles.assertWorkerApproved(worker.id)).rejects.toThrow(
        'Motivo: Reclamos reiterados',
      );
    });
  });

  describe('RF-10 y RF-47: verificación administrativa (PATCH /admin/profiles/:id/status)', () => {
    // Cuentas propias de este bloque: se crean y se borran aquí.
    const created: PublicUser[] = [];
    let adminWorker: PublicUser;
    let adminWorkerProfileId: string;

    const statusUrl = (id: string) => `${BASE}/admin/profiles/${id}/status`;
    const decide = (id: string, body: object, user: PublicUser = admin) =>
      http().patch(statusUrl(id)).set('Authorization', auth(user)).send(body);
    const statusOf = async (id: string) =>
      (await prisma.workerProfile.findUniqueOrThrow({ where: { id } })).status;

    /** Trabajador con perfil completo enviado a revisión (PENDIENTE). */
    const newCandidate = async (name: string) => {
      const user = await app.get(UsersService).create({
        firstName: name,
        lastName: 'E2E',
        email: `verif-${name}-${RUN_ID}${EMAIL_DOMAIN}`,
        passwordHash: 'hash',
        phone: '70000011',
      });
      created.push(user);
      const profile = await profiles.create(user.id, {
        ...validProfile(),
        schedules: [
          { dayOfWeek: WeekDay.LUNES, startTime: '08:00', endTime: '12:00' },
        ],
      });
      await profiles.submit(user.id);
      return {
        user: await app.get(UsersService).findById(user.id),
        profileId: profile.id,
      };
    };

    beforeAll(async () => {
      // Administrador que además es trabajador, con su perfil PENDIENTE.
      const candidate = await newCandidate('admin-trabajador');
      await prisma.userRole.create({
        data: { userId: candidate.user.id, role: RoleName.ADMINISTRADOR },
      });
      adminWorker = await app.get(UsersService).findById(candidate.user.id);
      adminWorkerProfileId = candidate.profileId;
    });

    afterAll(async () => {
      const ids = created.map((user) => user.id);
      await deleteWorkerData(prisma, ids);
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    });

    it('exige sesión (401)', async () => {
      const { profileId } = await newCandidate('sin-sesion');
      await http()
        .patch(statusUrl(profileId))
        .send({ status: WorkerProfileStatus.APROBADO })
        .expect(401);
      expect(await statusOf(profileId)).toBe(WorkerProfileStatus.PENDIENTE);
    });

    it('solo un administrador puede decidir (403 para cliente y trabajador)', async () => {
      const { user, profileId } = await newCandidate('no-admin');
      for (const intruder of [client, user]) {
        const res = await decide(
          profileId,
          { status: WorkerProfileStatus.RECHAZADO, reason: 'Intento' },
          intruder,
        ).expect(403);
        expect(JSON.stringify(res.body)).not.toContain('Intento');
      }
      expect(await statusOf(profileId)).toBe(WorkerProfileStatus.PENDIENTE);
    });

    it('aprueba un perfil válido, con historial y bitácora', async () => {
      const { user, profileId } = await newCandidate('aprobado');

      const res = await decide(profileId, {
        status: WorkerProfileStatus.APROBADO,
      }).expect(200);

      expect(res.body).toMatchObject({
        id: profileId,
        userId: user.id,
        status: WorkerProfileStatus.APROBADO,
        canEdit: false,
      });
      const eligibility = await http()
        .get(`${BASE}/me/eligibility`)
        .set('Authorization', auth(user))
        .expect(200);
      expect(eligibility.body).toMatchObject({ eligible: true });
      expect(
        await prisma.workerProfileStatusHistory.findFirst({
          where: { profileId, toStatus: WorkerProfileStatus.APROBADO },
        }),
      ).toMatchObject({
        fromStatus: WorkerProfileStatus.PENDIENTE,
        changedById: admin.id,
      });
      expect(
        await prisma.adminAuditLog.findFirst({
          where: { entityId: profileId, action: AuditAction.CAMBIO_ESTADO },
        }),
      ).toMatchObject({
        actorId: admin.id,
        entityType: AuditEntityType.PERFIL_TRABAJADOR,
        details: {
          from: WorkerProfileStatus.PENDIENTE,
          to: WorkerProfileStatus.APROBADO,
          reason: null,
        },
      });
    });

    it('observa un perfil con un motivo que solo ve el trabajador', async () => {
      const { user, profileId } = await newCandidate('observado');
      const reason = 'Suba una foto legible de su cédula';

      await decide(profileId, {
        status: WorkerProfileStatus.OBSERVADO,
        reason: `  ${reason}  `,
      }).expect(200);

      const status = await http()
        .get(`${BASE}/me/status`)
        .set('Authorization', auth(user))
        .expect(200);
      expect(status.body).toMatchObject({
        status: WorkerProfileStatus.OBSERVADO,
        statusReason: reason,
      });
    });

    it('rechaza con motivo sin tocar el rol CLIENTE ni el estado de la cuenta', async () => {
      const { user, profileId } = await newCandidate('rechazado');
      const reason = 'Los antecedentes no corresponden al titular';

      const res = await decide(profileId, {
        status: WorkerProfileStatus.RECHAZADO,
        reason,
      }).expect(200);
      expect(res.body.status).toBe(WorkerProfileStatus.RECHAZADO);

      const account = await app.get(UsersService).findById(user.id);
      expect(account.status).toBe(UserStatus.ACTIVO);
      expect(account.roles).toEqual(
        expect.arrayContaining([RoleName.CLIENTE, RoleName.TRABAJADOR]),
      );
      // La cuenta sigue operando como cliente.
      await http()
        .get('/api/auth/me')
        .set('Authorization', auth(user))
        .expect(200);
      const eligibility = await http()
        .get(`${BASE}/me/eligibility`)
        .set('Authorization', auth(user))
        .expect(200);
      expect(eligibility.body).toMatchObject({
        eligible: false,
        status: WorkerProfileStatus.RECHAZADO,
        reason,
      });
    });

    it('suspende un perfil aprobado con motivo, sin tocar la cuenta', async () => {
      const { user, profileId } = await newCandidate('suspendido');
      await decide(profileId, { status: WorkerProfileStatus.APROBADO }).expect(
        200,
      );

      await decide(profileId, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'Reclamos reiterados',
      }).expect(200);

      expect(await statusOf(profileId)).toBe(WorkerProfileStatus.SUSPENDIDO);
      const account = await app.get(UsersService).findById(user.id);
      expect(account.status).toBe(UserStatus.ACTIVO);
      expect(account.roles).toEqual(
        expect.arrayContaining([RoleName.CLIENTE, RoleName.TRABAJADOR]),
      );
    });

    it.each([
      ['rechazo sin motivo', { status: WorkerProfileStatus.RECHAZADO }],
      [
        'rechazo con motivo vacío',
        { status: WorkerProfileStatus.RECHAZADO, reason: '' },
      ],
      [
        'rechazo con solo espacios',
        { status: WorkerProfileStatus.RECHAZADO, reason: '   ' },
      ],
      ['observación sin motivo', { status: WorkerProfileStatus.OBSERVADO }],
      ['suspensión sin motivo', { status: WorkerProfileStatus.SUSPENDIDO }],
      ['estado no permitido', { status: WorkerProfileStatus.PENDIENTE }],
      [
        'adminId en el cuerpo',
        { status: WorkerProfileStatus.APROBADO, adminId: randomUUID() },
      ],
    ])('valida el cuerpo: %s (400)', async (_label, body) => {
      const { profileId } = await newCandidate(
        `val-${randomUUID().slice(0, 6)}`,
      );
      await decide(profileId, body).expect(400);
      expect(await statusOf(profileId)).toBe(WorkerProfileStatus.PENDIENTE);
    });

    it('rechaza transiciones inválidas (409)', async () => {
      const pendiente = await newCandidate('trans-pendiente');
      // PENDIENTE no se suspende.
      await decide(pendiente.profileId, {
        status: WorkerProfileStatus.SUSPENDIDO,
        reason: 'x',
      }).expect(409);

      const rechazado = await newCandidate('trans-rechazado');
      await decide(rechazado.profileId, {
        status: WorkerProfileStatus.RECHAZADO,
        reason: 'Motivo',
      }).expect(200);
      // RECHAZADO no se aprueba ni se rechaza otra vez por esta vía.
      await decide(rechazado.profileId, {
        status: WorkerProfileStatus.APROBADO,
      }).expect(409);
      await decide(rechazado.profileId, {
        status: WorkerProfileStatus.RECHAZADO,
        reason: 'Otra vez',
      }).expect(409);

      expect(await statusOf(pendiente.profileId)).toBe(
        WorkerProfileStatus.PENDIENTE,
      );
      expect(await statusOf(rechazado.profileId)).toBe(
        WorkerProfileStatus.RECHAZADO,
      );
    });

    it('no aprueba un perfil que dejó de cumplir los requisitos (409)', async () => {
      const { user, profileId } = await newCandidate('sin-telefono');
      await prisma.user.update({
        where: { id: user.id },
        data: { phone: null },
      });

      const res = await decide(profileId, {
        status: WorkerProfileStatus.APROBADO,
      }).expect(409);

      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('no cumple los requisitos'),
          'Registre un teléfono de contacto en su cuenta',
        ]),
      );
      expect(await statusOf(profileId)).toBe(WorkerProfileStatus.PENDIENTE);
    });

    it('un administrador no puede decidir sobre su propio perfil (403)', async () => {
      const res = await decide(
        adminWorkerProfileId,
        { status: WorkerProfileStatus.APROBADO },
        adminWorker,
      ).expect(403);

      expect(res.body.message).toBe(
        'No puede revisar ni decidir sobre su propio perfil de trabajador',
      );
      expect(await statusOf(adminWorkerProfileId)).toBe(
        WorkerProfileStatus.PENDIENTE,
      );
      // Otro administrador sí puede.
      await decide(adminWorkerProfileId, {
        status: WorkerProfileStatus.OBSERVADO,
        reason: 'Complete sus horarios',
      }).expect(200);
    });

    it('los motivos privados no se exponen a otros usuarios', async () => {
      const rechazado = await newCandidate('privado');
      const otro = await newCandidate('otro-trabajador');
      const reason = `Motivo privado ${RUN_ID}`;
      await decide(rechazado.profileId, {
        status: WorkerProfileStatus.RECHAZADO,
        reason,
      }).expect(200);

      // La respuesta de la decisión no incluye el motivo.
      const again = await decide(otro.profileId, {
        status: WorkerProfileStatus.APROBADO,
      }).expect(200);
      expect(JSON.stringify(again.body)).not.toContain(reason);

      // Otro trabajador solo ve lo suyo.
      for (const path of ['/me', '/me/status', '/me/eligibility']) {
        const res = await http()
          .get(`${BASE}${path}`)
          .set('Authorization', auth(otro.user))
          .expect(200);
        expect(JSON.stringify(res.body)).not.toContain(reason);
      }
      // Un cliente no accede a las rutas administrativas ni a la cuenta ajena.
      await http()
        .get(`${BASE}/admin/zone-change-requests`)
        .set('Authorization', auth(client))
        .expect(403);
      await http()
        .get(`/api/users/${rechazado.user.id}`)
        .set('Authorization', auth(client))
        .expect(403);
      // El afectado sí lo ve.
      const own = await http()
        .get(`${BASE}/me/status`)
        .set('Authorization', auth(rechazado.user))
        .expect(200);
      expect(own.body.statusReason).toBe(reason);
    });

    it('responde 404 si el perfil no existe y 400 si el id no es UUID', async () => {
      await decide(randomUUID(), {
        status: WorkerProfileStatus.APROBADO,
      }).expect(404);
      await decide('no-es-uuid', {
        status: WorkerProfileStatus.APROBADO,
      }).expect(400);
    });

    describe('listado y detalle para revisar (GET /admin/profiles)', () => {
      const list = (query: Record<string, string>, user: PublicUser = admin) =>
        http()
          .get(`${BASE}/admin/profiles`)
          .query(query)
          .set('Authorization', auth(user));
      const detail = (id: string, user: PublicUser = admin) =>
        http()
          .get(`${BASE}/admin/profiles/${id}`)
          .set('Authorization', auth(user));
      const ids = (body: { data: { id: string }[] }) =>
        body.data.map((item) => item.id);

      it('exige sesión (401) y rol administrador (403)', async () => {
        const { user, profileId } = await newCandidate('lista-permisos');
        await http().get(`${BASE}/admin/profiles`).expect(401);
        await http().get(`${BASE}/admin/profiles/${profileId}`).expect(401);
        for (const intruder of [client, user]) {
          await list({}, intruder).expect(403);
          await detail(profileId, intruder).expect(403);
        }
      });

      it('lista los perfiles pendientes con datos de la cuenta, sin el hash', async () => {
        const a = await newCandidate('cola-a');
        const b = await newCandidate('cola-b');

        const res = await list({
          status: WorkerProfileStatus.PENDIENTE,
          limit: '100',
        }).expect(200);

        expect(ids(res.body)).toEqual(
          expect.arrayContaining([a.profileId, b.profileId]),
        );
        expect(
          res.body.data.every(
            (item: { status: string }) =>
              item.status === WorkerProfileStatus.PENDIENTE,
          ),
        ).toBe(true);
        const row = res.body.data.find(
          (item: { id: string }) => item.id === a.profileId,
        );
        expect(row).toMatchObject({
          userId: a.user.id,
          account: {
            email: a.user.email,
            phone: '70000011',
            status: UserStatus.ACTIVO,
          },
          zone: { id: zoneA.id },
          specialties: [{ id: catA.id }],
        });
        expect(row.submittedAt).not.toBeNull();
        expect(JSON.stringify(res.body)).not.toMatch(/password/i);
      });

      it('filtra por zona y especialidad y pagina', async () => {
        const c = await newCandidate('filtro');

        const otherZone = await list({ zoneId: zoneB.id, limit: '100' }).expect(
          200,
        );
        expect(ids(otherZone.body)).not.toContain(c.profileId);
        const otherCategory = await list({
          categoryId: catB.id,
          limit: '100',
        }).expect(200);
        expect(ids(otherCategory.body)).not.toContain(c.profileId);
        const sameZone = await list({
          zoneId: zoneA.id,
          categoryId: catA.id,
          limit: '100',
        }).expect(200);
        expect(ids(sameZone.body)).toContain(c.profileId);

        const page = await list({ limit: '1' }).expect(200);
        expect(page.body.data).toHaveLength(1);
        expect(page.body.meta).toMatchObject({ page: 1, limit: 1 });
        expect(page.body.meta.totalPages).toBe(page.body.meta.total);
      });

      it.each([
        ['un estado desconocido', { status: 'CUALQUIERA' }],
        ['un límite mayor a 100', { limit: '101' }],
        ['una zona que no es UUID', { zoneId: 'x' }],
        ['un filtro no permitido', { userId: randomUUID() }],
      ])('valida la consulta: %s (400)', async (_label, query) => {
        await list(query).expect(400);
      });

      it('nunca incluye el perfil del propio administrador', async () => {
        const byOther = await list({ limit: '100' }).expect(200);
        expect(ids(byOther.body)).toContain(adminWorkerProfileId);

        const byOwner = await list({ limit: '100' }, adminWorker).expect(200);
        expect(ids(byOwner.body)).not.toContain(adminWorkerProfileId);
        await detail(adminWorkerProfileId, adminWorker).expect(403);
      });

      it('el detalle trae cuenta, motivo vigente, historial y decisiones posibles', async () => {
        const pending = await newCandidate('detalle-pendiente');
        const fresh = await detail(pending.profileId).expect(200);
        expect(fresh.body).toMatchObject({
          profile: {
            id: pending.profileId,
            status: WorkerProfileStatus.PENDIENTE,
            pendingRequirements: [],
          },
          account: {
            email: pending.user.email,
            roles: expect.arrayContaining([
              RoleName.CLIENTE,
              RoleName.TRABAJADOR,
            ]),
          },
          statusReason: null,
          allowedDecisions: [
            WorkerProfileStatus.APROBADO,
            WorkerProfileStatus.OBSERVADO,
            WorkerProfileStatus.RECHAZADO,
          ],
        });

        const reason = 'Falta el horario de los sábados';
        await decide(pending.profileId, {
          status: WorkerProfileStatus.OBSERVADO,
          reason,
        }).expect(200);
        const observed = await detail(pending.profileId).expect(200);

        expect(observed.body).toMatchObject({
          statusReason: reason,
          allowedDecisions: [],
          history: [
            {
              fromStatus: WorkerProfileStatus.PENDIENTE,
              toStatus: WorkerProfileStatus.OBSERVADO,
              reason,
              changedBy: 'ADMINISTRADOR',
              changedByUser: {
                id: admin.id,
                firstName: admin.firstName,
                lastName: admin.lastName,
              },
            },
            {
              fromStatus: WorkerProfileStatus.BORRADOR,
              toStatus: WorkerProfileStatus.PENDIENTE,
              changedBy: 'TRABAJADOR',
            },
            { fromStatus: null, toStatus: WorkerProfileStatus.BORRADOR },
          ],
        });
        expect(JSON.stringify(observed.body)).not.toMatch(/password/i);
      });

      it('responde 404 si el perfil no existe y 400 si el id no es UUID', async () => {
        await detail(randomUUID()).expect(404);
        await detail('no-es-uuid').expect(400);
      });
    });
  });
});
