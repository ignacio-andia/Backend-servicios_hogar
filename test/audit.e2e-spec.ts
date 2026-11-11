import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
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
const EMAIL_DOMAIN = '@audit-e2e.test';
const label = (text: string) => `${text} ${RUN_ID}`;
const URL = '/api/audit-logs';

interface AuditLogBody {
  id: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  createdAt: string;
  actor: { id: string; firstName: string; email: string };
}

describe('AuditModule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let adminA: PublicUser;
  let adminB: PublicUser;
  let worker: PublicUser;
  let categoryId: string;
  let zoneId: string;
  let startedAt: Date;

  const http = () => request(app.getHttpServer());
  const bearer = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
  const list = async (query: Record<string, string | number>) => {
    const res = await http()
      .get(URL)
      .query(query)
      .set('Authorization', bearer(adminA))
      .expect(200);
    return res.body as {
      data: AuditLogBody[];
      meta: { page: number; limit: number; total: number; totalPages: number };
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    const users = app.get(UsersService);
    const catalogs = app.get(CatalogsService);

    const newUser = (name: string) =>
      users.create({
        firstName: name,
        lastName: 'E2E',
        email: `${name}-${RUN_ID}${EMAIL_DOMAIN}`,
        passwordHash: 'hash',
      });
    adminA = await newUser('admin-a');
    adminB = await newUser('admin-b');
    worker = await newUser('worker');
    await prisma.userRole.createMany({
      data: [
        { userId: adminA.id, role: RoleName.ADMINISTRADOR },
        { userId: adminB.id, role: RoleName.ADMINISTRADOR },
        { userId: worker.id, role: RoleName.TRABAJADOR },
      ],
    });

    startedAt = new Date();
    // adminA: crea y edita una categoría; adminB: crea y desactiva una zona.
    const category = await catalogs.create(CatalogKind.CATEGORY, adminA.id, {
      name: label('Categoría'),
    });
    await catalogs.update(CatalogKind.CATEGORY, adminA.id, category.id, {
      description: 'Editada',
    });
    const zone = await catalogs.create(CatalogKind.ZONE, adminB.id, {
      name: label('Zona'),
    });
    await catalogs.deactivate(CatalogKind.ZONE, adminB.id, zone.id);
    categoryId = category.id;
    zoneId = zone.id;
  });

  afterAll(async () => {
    const ids = [adminA.id, adminB.id, worker.id];
    await deleteAuditLogs(prisma, { actorId: { in: ids } });
    await prisma.serviceCategory.deleteMany({
      where: { name: { contains: RUN_ID } },
    });
    await prisma.zone.deleteMany({ where: { name: { contains: RUN_ID } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  describe('protección', () => {
    it('exige sesión (401)', () => http().get(URL).expect(401));

    it('exige rol administrador (403)', () =>
      http().get(URL).set('Authorization', bearer(worker)).expect(403));

    it.each(['patch', 'put', 'delete'] as const)(
      'no expone %s sobre la bitácora',
      async (method) => {
        const { data } = await list({ actorId: adminA.id });
        await http()
          [method](`${URL}/${data[0].id}`)
          .set('Authorization', bearer(adminA))
          .expect(404);
      },
    );
  });

  describe('consulta', () => {
    it('devuelve quién, qué y cuándo, del más reciente al más antiguo', async () => {
      const { data, meta } = await list({ actorId: adminA.id });

      expect(meta).toMatchObject({ page: 1, limit: 20, total: 2 });
      expect(data.map((log) => log.action)).toEqual([
        AuditAction.EDICION,
        AuditAction.CREACION,
      ]);
      expect(data[0]).toMatchObject({
        entityType: AuditEntityType.CATEGORIA_SERVICIO,
        entityId: categoryId,
        actor: { id: adminA.id, firstName: 'admin-a' },
      });
      expect(new Date(data[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(data[1].createdAt).getTime(),
      );
      expect(JSON.stringify(data)).not.toMatch(/password/i);
    });

    it('filtra por administrador', async () => {
      const { data } = await list({ actorId: adminB.id });

      expect(data).toHaveLength(2);
      expect(data.every((log) => log.actor.id === adminB.id)).toBe(true);
    });

    it('filtra por tipo de entidad', async () => {
      const { data } = await list({
        actorId: adminB.id,
        entityType: AuditEntityType.ZONA,
      });
      const none = await list({
        actorId: adminB.id,
        entityType: AuditEntityType.CATEGORIA_SERVICIO,
      });

      expect(data.map((log) => log.entityId)).toEqual([zoneId, zoneId]);
      expect(none.data).toHaveLength(0);
    });

    it('filtra por acción', async () => {
      const { data } = await list({
        actorId: adminB.id,
        action: AuditAction.DESACTIVACION,
      });

      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ entityId: zoneId });
    });

    it('filtra por registro afectado', async () => {
      const { data } = await list({ entityId: categoryId });

      expect(data.map((log) => log.action)).toEqual([
        AuditAction.EDICION,
        AuditAction.CREACION,
      ]);
    });

    it('filtra por intervalo de fechas', async () => {
      const inside = await list({
        actorId: adminA.id,
        from: new Date(startedAt.getTime() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      });
      const before = await list({
        actorId: adminA.id,
        to: new Date(startedAt.getTime() - 60_000).toISOString(),
      });
      const after = await list({
        actorId: adminA.id,
        from: new Date(Date.now() + 60_000).toISOString(),
      });

      expect(inside.meta.total).toBe(2);
      expect(before.meta.total).toBe(0);
      expect(after.meta.total).toBe(0);
    });

    it('una fecha final sin hora incluye todo ese día', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { meta } = await list({
        actorId: adminA.id,
        from: today,
        to: today,
      });

      expect(meta.total).toBe(2);
    });

    it('pagina los resultados', async () => {
      const first = await list({ entityId: zoneId, limit: 1, page: 1 });
      const second = await list({ entityId: zoneId, limit: 1, page: 2 });

      expect(first.meta).toEqual({
        page: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
      });
      expect(first.data[0].id).not.toBe(second.data[0].id);
      expect(second.data[0].action).toBe(AuditAction.CREACION);
    });

    it.each([
      ['un tipo de entidad desconocido', { entityType: 'PEDIDO' }],
      ['una acción desconocida', { action: 'BORRADO' }],
      ['un administrador que no es UUID', { actorId: '123' }],
      ['una fecha inválida', { from: '2026-13-45' }],
      ['un intervalo invertido', { from: '2026-11-10', to: '2026-11-01' }],
      ['un límite excesivo', { limit: 1000 }],
      ['un filtro no soportado', { name: 'x' }],
    ])('responde 400 con %s', async (_label, query) => {
      await http()
        .get(URL)
        .query(query)
        .set('Authorization', bearer(adminA))
        .expect(400);
    });
  });

  describe('inmutabilidad en PostgreSQL', () => {
    it('rechaza modificar un registro', async () => {
      const log = await prisma.adminAuditLog.findFirstOrThrow({
        where: { entityId: zoneId },
      });

      await expect(
        prisma.adminAuditLog.update({
          where: { id: log.id },
          data: { action: AuditAction.CREACION },
        }),
      ).rejects.toThrow(/solo inserción/);
    });

    it('rechaza eliminar registros', async () => {
      await expect(
        prisma.adminAuditLog.deleteMany({ where: { entityId: zoneId } }),
      ).rejects.toThrow(/solo inserción/);
      expect(
        await prisma.adminAuditLog.count({ where: { entityId: zoneId } }),
      ).toBe(2);
    });

    it('rechaza vaciar la tabla', async () => {
      // Se revierte siempre: si el trigger fallara, no se perdería nada.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('TRUNCATE "admin_audit_logs"');
          throw new Error('TRUNCATE no fue rechazado');
        }),
      ).rejects.toThrow(/solo inserción/);
    });
  });
});
