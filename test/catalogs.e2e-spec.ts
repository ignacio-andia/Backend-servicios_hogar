import { randomUUID } from 'node:crypto';
import { BadRequestException, INestApplication } from '@nestjs/common';
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
} from '../src/generated/prisma/client.js';
import {
  CatalogKind,
  CatalogsService,
} from '../src/modules/catalogs/catalogs.service.js';
import {
  PublicUser,
  UsersService,
} from '../src/modules/users/users.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deleteAuditLogs } from './utils/audit-maintenance.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@catalogs-e2e.test';
const label = (text: string) => `${text} ${RUN_ID}`;

/** Nombres del Anexo B (Decisiones confirmadas) del documento de requerimientos. */
const INITIAL_CATEGORIES = [
  'Albañilería',
  'Electricidad',
  'Electrodomésticos',
  'Plomería',
];

describe('CatalogsModule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let catalogs: CatalogsService;
  let jwt: JwtService;
  let admin: PublicUser;
  let worker: PublicUser;

  const http = () => request(app.getHttpServer());
  const bearer = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const auditTrail = (entityId: string) =>
    prisma.adminAuditLog.findMany({
      where: { entityId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    catalogs = app.get(CatalogsService);
    jwt = app.get(JwtService);
    const users = app.get(UsersService);

    const newUser = (name: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}${EMAIL_DOMAIN}`,
        passwordHash: 'hash',
      });
    admin = await newUser('admin');
    worker = await newUser('worker');
    await prisma.userRole.createMany({
      data: [
        { userId: admin.id, role: RoleName.ADMINISTRADOR },
        { userId: worker.id, role: RoleName.TRABAJADOR },
      ],
    });
  });

  afterAll(async () => {
    const ids = [admin.id, worker.id];
    await deleteAuditLogs(prisma, { actorId: { in: ids } });
    await prisma.serviceCategory.deleteMany({
      where: { name: { contains: RUN_ID } },
    });
    await prisma.zone.deleteMany({ where: { name: { contains: RUN_ID } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  describe('datos iniciales', () => {
    it('la migración carga las cuatro categorías iniciales activas', async () => {
      const res = await http().get('/api/catalogs/categories').expect(200);
      const names = res.body.map((c: { name: string }) => c.name);

      expect(names).toEqual(expect.arrayContaining(INITIAL_CATEGORIES));
      expect(names).not.toContain('Técnicos en electrodomésticos');
    });
  });

  describe.each([
    {
      kind: CatalogKind.CATEGORY,
      path: 'categories',
      noun: 'categoría',
      entityType: AuditEntityType.CATEGORIA_SERVICIO,
    },
    {
      kind: CatalogKind.ZONE,
      path: 'zones',
      noun: 'zona',
      entityType: AuditEntityType.ZONA,
    },
  ])('$path', ({ kind, path, noun, entityType }) => {
    const publicUrl = `/api/catalogs/${path}`;
    const adminUrl = `/api/catalogs/admin/${path}`;
    let itemId: string;
    let createdAt: string;

    describe('permisos', () => {
      it('crear exige sesión (401)', () =>
        http()
          .post(publicUrl)
          .send({ name: label('Sin sesión') })
          .expect(401));

      it('crear exige rol administrador (403)', () =>
        http()
          .post(publicUrl)
          .set('Authorization', bearer(worker))
          .send({ name: label('Sin permiso') })
          .expect(403));

      it('la consulta administrativa exige rol administrador', async () => {
        await http().get(adminUrl).expect(401);
        await http()
          .get(adminUrl)
          .set('Authorization', bearer(worker))
          .expect(403);
      });

      it('la consulta pública no exige sesión', () =>
        http().get(publicUrl).expect(200));
    });

    describe('crear', () => {
      it('crea el registro activo, con UUID y fechas, y lo registra en la bitácora', async () => {
        const res = await http()
          .post(publicUrl)
          .set('Authorization', bearer(admin))
          .send({ name: `  ${label('Nueva')}  `, description: 'Descripción' })
          .expect(201);

        expect(res.body).toMatchObject({
          name: label('Nueva'),
          description: 'Descripción',
          isActive: true,
        });
        expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
        itemId = res.body.id;
        createdAt = res.body.createdAt;

        const [log] = await auditTrail(itemId);
        expect(log).toMatchObject({
          actorId: admin.id,
          action: AuditAction.CREACION,
          entityType,
          entityId: itemId,
        });
        expect(log.createdAt).toBeInstanceOf(Date);
      });

      it('queda disponible en la consulta pública de activos', async () => {
        const res = await http().get(publicUrl).expect(200);

        expect(res.body).toContainEqual({
          id: itemId,
          name: label('Nueva'),
          description: 'Descripción',
        });
        await http().get(`${publicUrl}/${itemId}`).expect(200);
      });

      it('rechaza nombres duplicados aunque cambien mayúsculas o espacios', async () => {
        const res = await http()
          .post(publicUrl)
          .set('Authorization', bearer(admin))
          .send({ name: label('NUEVA').replace(' ', '   ') })
          .expect(409);

        expect(res.body.message).toBe(`Ya existe una ${noun} con ese nombre`);
      });

      it.each([
        ['sin nombre', { description: 'x' }],
        ['nombre vacío', { name: '   ' }],
        ['nombre de un carácter', { name: 'A' }],
        ['nombre demasiado largo', { name: 'x'.repeat(101) }],
        [
          'descripción demasiado larga',
          { name: 'Válido', description: 'x'.repeat(501) },
        ],
        ['un estado', { name: label('Con estado'), isActive: false }],
      ])('responde 400 con %s', async (_label, body) => {
        await http()
          .post(publicUrl)
          .set('Authorization', bearer(admin))
          .send(body)
          .expect(400);
      });
    });

    describe('consultar', () => {
      it('el administrador consulta por ID', async () => {
        const res = await http()
          .get(`${adminUrl}/${itemId}`)
          .set('Authorization', bearer(admin))
          .expect(200);

        expect(res.body).toMatchObject({ id: itemId, isActive: true });
      });

      it('responde 404 si el ID no existe y 400 si no es UUID', async () => {
        await http()
          .get(`${adminUrl}/${randomUUID()}`)
          .set('Authorization', bearer(admin))
          .expect(404);
        await http()
          .get(`${adminUrl}/123`)
          .set('Authorization', bearer(admin))
          .expect(400);
      });

      it('valida el filtro de estado', () =>
        http()
          .get(`${adminUrl}?isActive=quizas`)
          .set('Authorization', bearer(admin))
          .expect(400));
    });

    describe('editar', () => {
      it('modifica nombre y descripción conservando la identidad', async () => {
        const res = await http()
          .patch(`${publicUrl}/${itemId}`)
          .set('Authorization', bearer(admin))
          .send({ name: label('Editada'), description: null })
          .expect(200);

        expect(res.body).toMatchObject({
          id: itemId,
          name: label('Editada'),
          description: null,
          createdAt,
        });

        const logs = await auditTrail(itemId);
        expect(logs[1]).toMatchObject({
          action: AuditAction.EDICION,
          details: {
            before: { name: label('Nueva'), description: 'Descripción' },
            after: { name: label('Editada'), description: null },
          },
        });
      });

      it('rechaza renombrar a un nombre existente', async () => {
        const other = await catalogs.create(kind, admin.id, {
          name: label('Otra'),
        });

        await http()
          .patch(`${publicUrl}/${other.id}`)
          .set('Authorization', bearer(admin))
          .send({ name: label('editada') })
          .expect(409);
      });

      it('no permite cambiar el estado ni otros campos', async () => {
        await http()
          .patch(`${publicUrl}/${itemId}`)
          .set('Authorization', bearer(admin))
          .send({ isActive: false })
          .expect(400);
        await http()
          .patch(`${publicUrl}/${itemId}`)
          .set('Authorization', bearer(admin))
          .send({})
          .expect(400);
      });

      it('impide editar sin rol administrador', () =>
        http()
          .patch(`${publicUrl}/${itemId}`)
          .set('Authorization', bearer(worker))
          .send({ name: label('Intrusa') })
          .expect(403));

      it('responde 404 si no existe', () =>
        http()
          .patch(`${publicUrl}/${randomUUID()}`)
          .set('Authorization', bearer(admin))
          .send({ name: label('Fantasma') })
          .expect(404));
    });

    describe('desactivar', () => {
      it('impide desactivar sin rol administrador', () =>
        http()
          .patch(`${publicUrl}/${itemId}/deactivate`)
          .set('Authorization', bearer(worker))
          .expect(403));

      it('marca el registro como inactivo', async () => {
        const res = await http()
          .patch(`${publicUrl}/${itemId}/deactivate`)
          .set('Authorization', bearer(admin))
          .expect(200);

        expect(res.body).toMatchObject({ id: itemId, isActive: false });
      });

      it('deja de ofrecerse en la consulta pública', async () => {
        const res = await http().get(publicUrl).expect(200);

        expect(res.body.map((c: { id: string }) => c.id)).not.toContain(itemId);
        await http().get(`${publicUrl}/${itemId}`).expect(404);
      });

      it('sigue visible para el administrador y se puede filtrar por estado', async () => {
        const inactive = await http()
          .get(`${adminUrl}?isActive=false`)
          .set('Authorization', bearer(admin))
          .expect(200);
        const active = await http()
          .get(`${adminUrl}?isActive=true`)
          .set('Authorization', bearer(admin))
          .expect(200);
        const all = await http()
          .get(adminUrl)
          .set('Authorization', bearer(admin))
          .expect(200);

        const ids = (res: { body: { id: string }[] }) =>
          res.body.map((c) => c.id);
        expect(ids(inactive)).toContain(itemId);
        expect(ids(active)).not.toContain(itemId);
        expect(ids(all)).toContain(itemId);
      });

      it('conserva el registro, su identidad y su historial', async () => {
        const row = await (kind === CatalogKind.CATEGORY
          ? prisma.serviceCategory.findUnique({ where: { id: itemId } })
          : prisma.zone.findUnique({ where: { id: itemId } }));

        expect(row).toMatchObject({ id: itemId, name: label('Editada') });
        expect(row?.createdAt.toISOString()).toBe(createdAt);
        expect((await auditTrail(itemId)).map((l) => l.action)).toEqual([
          AuditAction.CREACION,
          AuditAction.EDICION,
          AuditAction.DESACTIVACION,
        ]);
      });

      it('no existe un endpoint de borrado físico', () =>
        http()
          .delete(`${publicUrl}/${itemId}`)
          .set('Authorization', bearer(admin))
          .expect(404));

      it('responde 409 si ya estaba inactivo', () =>
        http()
          .patch(`${publicUrl}/${itemId}/deactivate`)
          .set('Authorization', bearer(admin))
          .expect(409));

      it('rechaza usarlo en registros nuevos desde otros módulos', async () => {
        await expect(catalogs.assertActive(kind, itemId)).rejects.toThrow(
          new BadRequestException(`La ${noun} seleccionada no está activa`),
        );
      });

      it('impide crear otro registro con el nombre del inactivo', async () => {
        const res = await http()
          .post(publicUrl)
          .set('Authorization', bearer(admin))
          .send({ name: label('Editada') })
          .expect(409);

        expect(res.body.message).toBe(
          `Ya existe una ${noun} inactiva con ese nombre`,
        );
      });
    });

    describe('unicidad garantizada por PostgreSQL', () => {
      const insertDirectly = (name: string) =>
        kind === CatalogKind.CATEGORY
          ? prisma.serviceCategory.create({ data: { name } })
          : prisma.zone.create({ data: { name } });
      const countByName = (name: string) =>
        kind === CatalogKind.CATEGORY
          ? prisma.serviceCategory.count({ where: { name } })
          : prisma.zone.count({ where: { name } });
      const creationLogs = () =>
        prisma.adminAuditLog.count({
          where: {
            actorId: admin.id,
            entityType,
            action: AuditAction.CREACION,
          },
        });

      it('el índice único rechaza variantes de mayúsculas aunque no pase por el servicio', async () => {
        const base = label('Índice Único');
        await insertDirectly(base);

        for (const variant of [base.toUpperCase(), base.toLowerCase()]) {
          await expect(insertDirectly(variant)).rejects.toMatchObject({
            code: 'P2002',
          });
        }
        expect(await countByName(base.toLowerCase())).toBe(1);
      });

      it('de varias solicitudes HTTP simultáneas equivalentes solo una se registra', async () => {
        const base = label('Concurrente Http');
        const variants = [
          base,
          base.toUpperCase(),
          base.toLowerCase(),
          base,
          base.toUpperCase(),
          base.toLowerCase(),
        ];
        const logsBefore = await creationLogs();

        const responses = await Promise.all(
          variants.map((name) =>
            http()
              .post(publicUrl)
              .set('Authorization', bearer(admin))
              .send({ name }),
          ),
        );

        const statuses = responses
          .map((res) => res.status)
          .sort((a, b) => a - b);
        expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
        for (const res of responses.filter((r) => r.status === 409)) {
          expect(res.body.message).toBe(`Ya existe una ${noun} con ese nombre`);
        }
        expect(await countByName(base)).toBe(1);
        expect((await creationLogs()) - logsBefore).toBe(1);
      });

      it('de varias creaciones simultáneas sin la comprobación previa, PostgreSQL deja pasar una', async () => {
        const base = label('Concurrente Bd');
        const results = await Promise.allSettled(
          [base, base.toUpperCase(), base.toLowerCase(), base].map(
            insertDirectly,
          ),
        );

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await countByName(base)).toBe(1);
      });

      it('de dos renombres simultáneos al mismo nombre solo uno se aplica', async () => {
        const first = await catalogs.create(kind, admin.id, {
          name: label('Renombre A'),
        });
        const second = await catalogs.create(kind, admin.id, {
          name: label('Renombre B'),
        });
        const target = label('Renombre Final');

        const results = await Promise.allSettled([
          catalogs.update(kind, admin.id, first.id, { name: target }),
          catalogs.update(kind, admin.id, second.id, {
            name: target.toUpperCase(),
          }),
        ]);

        expect(
          results.map((r) => r.status).sort((a, b) => a.localeCompare(b)),
        ).toEqual(['fulfilled', 'rejected']);
        const rejected = results.find((r) => r.status === 'rejected');
        expect(rejected?.reason).toMatchObject({ status: 409 });
        expect(await countByName(target)).toBe(1);
      });

      it('los nombres de registros inactivos siguen reservados en PostgreSQL', async () => {
        const created = await catalogs.create(kind, admin.id, {
          name: label('Reservada'),
        });
        await catalogs.deactivate(kind, admin.id, created.id);

        await expect(insertDirectly(label('RESERVADA'))).rejects.toMatchObject({
          code: 'P2002',
        });
      });
    });

    it('revierte la acción si no puede registrarla en la bitácora', async () => {
      const name = label('Sin bitácora');

      await expect(
        catalogs.create(kind, randomUUID(), { name }),
      ).rejects.toThrow();

      const all = await catalogs.findAll(kind);
      expect(all.map((c) => c.name)).not.toContain(name);
    });
  });
});
