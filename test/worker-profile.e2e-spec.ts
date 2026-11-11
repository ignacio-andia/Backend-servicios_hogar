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
    let rejectedId: string;

    it('impide cambiar la zona directamente', () =>
      http()
        .patch(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .send({ zoneId: zoneC.id })
        .expect(403));

    it('valida la zona solicitada', async () => {
      await http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId: zoneOff.id, reason: 'Me mudé de barrio' })
        .expect(400);
      await http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId: zoneB.id, reason: 'Me mudé de barrio' })
        .expect(400);
      await http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId: zoneC.id })
        .expect(400);
    });

    it('registra una solicitud pendiente y no admite otra', async () => {
      const res = await http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId: zoneC.id, reason: 'Me mudé de barrio' })
        .expect(201);
      expect(res.body).toMatchObject({
        status: ZoneChangeRequestStatus.PENDIENTE,
        fromZone: { id: zoneB.id },
        toZone: { id: zoneC.id },
      });
      rejectedId = res.body.id;

      await http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId: zoneA.id, reason: 'Otra solicitud' })
        .expect(409);
    });

    it('si se rechaza, el trabajador conserva su zona', async () => {
      await profiles.decideZoneChangeRequest(admin.id, rejectedId, {
        decision: 'RECHAZADA',
        comment: 'No hay demanda en esa zona',
      });

      const me = await http()
        .get(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(me.body.zone.id).toBe(zoneB.id);
    });

    it('si se aprueba, la nueva zona reemplaza a la anterior', async () => {
      const res = await http()
        .post(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .send({ toZoneId: zoneC.id, reason: 'Nuevo domicilio' })
        .expect(201);
      await profiles.decideZoneChangeRequest(admin.id, res.body.id, {
        decision: 'APROBADA',
      });

      const me = await http()
        .get(`${BASE}/me`)
        .set('Authorization', auth(worker))
        .expect(200);
      expect(me.body.zone.id).toBe(zoneC.id);
      await expect(
        profiles.decideZoneChangeRequest(admin.id, res.body.id, {
          decision: 'RECHAZADA',
          comment: 'tarde',
        }),
      ).rejects.toThrow('La solicitud ya fue resuelta');
    });

    it('conserva el historial de solicitudes y decisiones', async () => {
      const res = await http()
        .get(`${BASE}/me/zone-change-requests`)
        .set('Authorization', auth(worker))
        .expect(200);

      expect(
        res.body.map(
          (r: { status: string; decisionComment: string | null }) => [
            r.status,
            r.decisionComment,
          ],
        ),
      ).toEqual([
        ['APROBADA', null],
        ['RECHAZADA', 'No hay demanda en esa zona'],
      ]);
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

    it('de dos solicitudes simultaneas solo una queda pendiente', async () => {
      const responses = await Promise.all(
        [zoneA.id, zoneB.id].map((toZoneId) =>
          http()
            .post(`${BASE}/me/zone-change-requests`)
            .set('Authorization', auth(worker))
            .send({ toZoneId, reason: 'Solicitud simultánea' }),
        ),
      );

      expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
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
});
