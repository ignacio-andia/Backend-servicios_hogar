import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  INestApplication,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import { RoleName, UserStatus } from '../src/generated/prisma/client.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import {
  PublicUser,
  UsersService,
} from '../src/modules/users/users.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@users-e2e.test';
const email = (name: string) => `${name}-${RUN_ID}${EMAIL_DOMAIN}`;

describe('UsersModule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let usersService: UsersService;
  let admin: PublicUser;
  let client: PublicUser;
  let other: PublicUser;

  let jwt: JwtService;

  const http = () => request(app.getHttpServer());
  const bearer = (user: PublicUser) =>
    `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    usersService = app.get(UsersService);
    jwt = app.get(JwtService);

    const newUser = (name: string) =>
      usersService.create({
        firstName: name,
        lastName: 'E2E',
        email: email(name),
        passwordHash: `hash-${name}`,
      });
    admin = await newUser('admin');
    client = await newUser('client');
    other = await newUser('other');

    // No existe aún un flujo de alta de administradores (seed pendiente).
    await prisma.userRole.create({
      data: { userId: admin.id, role: RoleName.ADMINISTRADOR },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { endsWith: `-${RUN_ID}${EMAIL_DOMAIN}` } },
    });
    await app.close();
  });

  describe('flujo interno (UsersService)', () => {
    it('crea usuarios con UUID, rol CLIENTE, estado ACTIVO y fechas', async () => {
      expect(client.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(client.roles).toEqual([RoleName.CLIENTE]);
      expect(client.status).toBe(UserStatus.ACTIVO);
      expect(client.createdAt).toBeInstanceOf(Date);
      expect(client.updatedAt).toBeInstanceOf(Date);
      expect(client).not.toHaveProperty('passwordHash');

      const row = await prisma.user.findUnique({ where: { id: client.id } });
      expect(row?.passwordHash).toBe('hash-client');
    });

    it('rechaza correos duplicados sin distinguir mayúsculas', async () => {
      await expect(
        usersService.create({
          firstName: 'Dup',
          lastName: 'E2E',
          email: email('client').toUpperCase(),
          passwordHash: 'x',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('consulta por correo y expone credenciales solo por el método dedicado', async () => {
      const byEmail = await usersService.findByEmail(` ${email('client')} `);
      expect(byEmail?.id).toBe(client.id);
      expect(byEmail).not.toHaveProperty('passwordHash');

      const credentials = await usersService.findCredentialsByEmail(
        email('client'),
      );
      expect(credentials).toMatchObject({
        id: client.id,
        passwordHash: 'hash-client',
        status: UserStatus.ACTIVO,
      });
      expect(await usersService.findByEmail(email('nadie'))).toBeNull();
    });

    it('gestiona roles solo desde administradores y nunca sobre sí mismos', async () => {
      await expect(
        usersService.assignRole(client.id, client.id, RoleName.ADMINISTRADOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        usersService.assignRole(admin.id, admin.id, RoleName.TRABAJADOR),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const updated = await usersService.assignRole(
        admin.id,
        other.id,
        RoleName.TRABAJADOR,
      );
      expect(updated.roles).toEqual([RoleName.CLIENTE, RoleName.TRABAJADOR]);
      expect(await usersService.getRoles(other.id)).toEqual(updated.roles);

      const assignment = await prisma.userRole.findUnique({
        where: {
          userId_role: { userId: other.id, role: RoleName.TRABAJADOR },
        },
      });
      expect(assignment?.assignedById).toBe(admin.id);

      const revoked = await usersService.revokeRole(
        admin.id,
        other.id,
        RoleName.TRABAJADOR,
      );
      expect(revoked.roles).toEqual([RoleName.CLIENTE]);
    });

    it('AuthModule reutiliza la misma instancia de UsersService', () => {
      expect(app.get(AuthService)['usersService']).toBe(usersService);
    });
  });

  describe('GET /api/users', () => {
    it('exige autenticación', () => http().get('/api/users').expect(401));

    it('está reservado a administradores', () =>
      http()
        .get('/api/users')
        .set('Authorization', bearer(client))
        .expect(403));

    it('devuelve una página sin hashes', async () => {
      const res = await http()
        .get('/api/users?page=1&limit=2')
        .set('Authorization', bearer(admin))
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 2 });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    });

    it('valida la paginación', () =>
      http()
        .get('/api/users?limit=1000')
        .set('Authorization', bearer(admin))
        .expect(400));
  });

  describe('GET /api/users/:id', () => {
    it('exige autenticación', () =>
      http().get(`/api/users/${client.id}`).expect(401));

    it('permite consultar la propia cuenta sin exponer el hash', async () => {
      const res = await http()
        .get(`/api/users/${client.id}`)
        .set('Authorization', bearer(client))
        .expect(200);

      expect(res.body).toMatchObject({
        id: client.id,
        email: email('client'),
        roles: [RoleName.CLIENTE],
      });
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('impide consultar cuentas ajenas sin ser administrador', () =>
      http()
        .get(`/api/users/${other.id}`)
        .set('Authorization', bearer(client))
        .expect(403));

    it('permite a un administrador consultar cualquier cuenta', () =>
      http()
        .get(`/api/users/${other.id}`)
        .set('Authorization', bearer(admin))
        .expect(200));

    it('responde 404 si el usuario no existe', () =>
      http()
        .get(`/api/users/${randomUUID()}`)
        .set('Authorization', bearer(admin))
        .expect(404));

    it('responde 400 si el id no es un UUID', () =>
      http()
        .get('/api/users/123')
        .set('Authorization', bearer(admin))
        .expect(400));
  });

  describe('PATCH /api/users/:id', () => {
    it('actualiza los datos personales propios', async () => {
      const res = await http()
        .patch(`/api/users/${client.id}`)
        .set('Authorization', bearer(client))
        .send({ firstName: '  Carla ', phone: '+59171234567' })
        .expect(200);

      expect(res.body).toMatchObject({
        firstName: 'Carla',
        phone: '+59171234567',
      });
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it.each([
      ['correo', { email: 'nuevo@users-e2e.test' }],
      ['roles', { roles: [RoleName.ADMINISTRADOR] }],
      ['hash', { passwordHash: 'x' }],
      ['estado', { status: UserStatus.SUSPENDIDO }],
      ['id', { id: randomUUID() }],
      ['nombre nulo', { firstName: null }],
      ['teléfono inválido', { phone: 'abc' }],
    ])('rechaza modificar %s', async (_label, body) => {
      await http()
        .patch(`/api/users/${client.id}`)
        .set('Authorization', bearer(client))
        .send(body)
        .expect(400);
    });

    it('impide modificar cuentas ajenas sin ser administrador', () =>
      http()
        .patch(`/api/users/${other.id}`)
        .set('Authorization', bearer(client))
        .send({ lastName: 'Hack' })
        .expect(403));
  });

  describe('PATCH /api/users/:id/status', () => {
    it('impide que un usuario común se asigne otro estado que no sea INACTIVO', () =>
      http()
        .patch(`/api/users/${client.id}/status`)
        .set('Authorization', bearer(client))
        .send({ status: UserStatus.SUSPENDIDO })
        .expect(403));

    it('rechaza estados desconocidos', () =>
      http()
        .patch(`/api/users/${client.id}/status`)
        .set('Authorization', bearer(admin))
        .send({ status: 'BORRADO' })
        .expect(400));

    it('impide desactivar al único administrador activo', () =>
      http()
        .patch(`/api/users/${admin.id}/status`)
        .set('Authorization', bearer(admin))
        .send({ status: UserStatus.INACTIVO })
        .expect(409));

    it('permite a un administrador suspender una cuenta', async () => {
      const res = await http()
        .patch(`/api/users/${other.id}/status`)
        .set('Authorization', bearer(admin))
        .send({ status: UserStatus.SUSPENDIDO })
        .expect(200);

      expect(res.body.status).toBe(UserStatus.SUSPENDIDO);
    });

    it('permite desactivar la propia cuenta sin borrarla', async () => {
      const res = await http()
        .patch(`/api/users/${client.id}/status`)
        .set('Authorization', bearer(client))
        .send({ status: UserStatus.INACTIVO })
        .expect(200);

      expect(res.body.status).toBe(UserStatus.INACTIVO);
      expect(
        await prisma.user.findUnique({ where: { id: client.id } }),
      ).not.toBeNull();

      await http()
        .get(`/api/users/${client.id}`)
        .set('Authorization', bearer(client))
        .expect(401);
    });
  });
});
