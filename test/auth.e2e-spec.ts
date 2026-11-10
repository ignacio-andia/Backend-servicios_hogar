import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import { RoleName, UserStatus } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const RUN_ID = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@auth-e2e.test';
const email = (name: string) => `${name}-${RUN_ID}${EMAIL_DOMAIN}`;
const PASSWORD = 'Password123';

const registerBody = (name: string, extra: object = {}) => ({
  firstName: 'Juan',
  lastName: 'Pérez',
  email: email(name),
  password: PASSWORD,
  phone: '70000000',
  ...extra,
});

describe('AuthModule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let userId: string;
  let accessToken: string;

  const http = () => request(app.getHttpServer());
  const me = (token?: string) => {
    const req = http().get('/api/auth/me');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
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
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { endsWith: `-${RUN_ID}${EMAIL_DOMAIN}` } },
    });
    await app.close();
  });

  describe('POST /api/auth/register', () => {
    it('registra un CLIENTE, devuelve un token y no expone el hash', async () => {
      const res = await http()
        .post('/api/auth/register')
        .send(registerBody('juan'))
        .expect(201);

      expect(res.body.tokenType).toBe('Bearer');
      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.user).toMatchObject({
        email: email('juan'),
        phone: '70000000',
        status: UserStatus.ACTIVO,
        roles: [RoleName.CLIENTE],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);

      userId = res.body.user.id;
      accessToken = res.body.accessToken;
      expect(jwt.decode(accessToken)).toMatchObject({
        sub: userId,
        email: email('juan'),
      });
      expect(Object.keys(jwt.decode(accessToken)).sort()).toEqual([
        'email',
        'exp',
        'iat',
        'sub',
      ]);
    });

    it('almacena la contraseña como hash bcrypt', async () => {
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });

      expect(row.passwordHash).not.toBe(PASSWORD);
      expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
      expect(await bcrypt.compare(PASSWORD, row.passwordHash)).toBe(true);
    });

    it('responde 409 si el correo ya está registrado', () =>
      http()
        .post('/api/auth/register')
        .send(registerBody('juan', { email: email('juan').toUpperCase() }))
        .expect(409));

    it.each([
      ['un correo inválido', { email: 'no-es-correo' }],
      ['una contraseña corta', { password: 'Ab1' }],
      ['una contraseña sin números', { password: 'SoloLetras' }],
      ['roles', { roles: [RoleName.ADMINISTRADOR] }],
      ['un rol', { role: RoleName.ADMINISTRADOR }],
      ['un estado', { status: UserStatus.ACTIVO }],
      ['un passwordHash', { passwordHash: 'x' }],
    ])('responde 400 al enviar %s', async (_label, extra) => {
      const body = registerBody(`invalido-${randomUUID().slice(0, 4)}`, extra);
      await http().post('/api/auth/register').send(body).expect(400);

      expect(await prisma.user.count({ where: { email: body.email } })).toBe(0);
    });
  });

  describe('POST /api/auth/login', () => {
    it('emite un token con credenciales correctas', async () => {
      const res = await http()
        .post('/api/auth/login')
        .send({ email: ` ${email('juan').toUpperCase()} `, password: PASSWORD })
        .expect(200);

      expect(res.body.user.id).toBe(userId);
      expect(res.body.user).not.toHaveProperty('passwordHash');
      await me(res.body.accessToken).expect(200);
    });

    it('usa el mismo mensaje para correo inexistente y contraseña incorrecta', async () => {
      const unknown = await http()
        .post('/api/auth/login')
        .send({ email: email('nadie'), password: PASSWORD })
        .expect(401);
      const wrong = await http()
        .post('/api/auth/login')
        .send({ email: email('juan'), password: 'Incorrecta123' })
        .expect(401);

      expect(unknown.body).toEqual(wrong.body);
    });

    it('valida el cuerpo de la petición', () =>
      http()
        .post('/api/auth/login')
        .send({ email: email('juan') })
        .expect(400));

    it.each([UserStatus.INACTIVO, UserStatus.SUSPENDIDO])(
      'rechaza cuentas en estado %s',
      async (status) => {
        const name = `estado-${status.toLowerCase()}`;
        const res = await http()
          .post('/api/auth/register')
          .send(registerBody(name))
          .expect(201);
        await prisma.user.update({
          where: { id: res.body.user.id },
          data: { status },
        });

        await http()
          .post('/api/auth/login')
          .send({ email: email(name), password: PASSWORD })
          .expect(403);
        // El token emitido antes de la desactivación deja de servir.
        await me(res.body.accessToken).expect(401);
      },
    );
  });

  describe('GET /api/auth/me', () => {
    it('devuelve el perfil público con un token válido', async () => {
      const res = await me(accessToken).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(
        [
          'createdAt',
          'email',
          'firstName',
          'id',
          'lastName',
          'phone',
          'roles',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(res.body).toMatchObject({
        id: userId,
        status: UserStatus.ACTIVO,
        roles: [RoleName.CLIENTE],
      });
    });

    it('toma roles y estado de la base de datos, no del token', async () => {
      const forged = jwt.sign({
        sub: userId,
        email: email('juan'),
        roles: [RoleName.ADMINISTRADOR],
      });

      const res = await me(forged).expect(200);
      expect(res.body.roles).toEqual([RoleName.CLIENTE]);
    });

    it('responde 401 sin token', () => me().expect(401));

    it('responde 401 con un token mal formado', () =>
      me('no.es.un-jwt').expect(401));

    it('responde 401 con un token vencido', () =>
      me(
        jwt.sign({ sub: userId, email: email('juan') }, { expiresIn: -10 }),
      ).expect(401));

    it('responde 401 con una firma incorrecta', () =>
      me(
        jwt.sign(
          { sub: userId, email: email('juan') },
          { secret: 'otra-clave-secreta-de-al-menos-32-caracteres' },
        ),
      ).expect(401));

    it('responde 401 con un token sin firmar (alg none)', () => {
      const encode = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
        sub: userId,
        email: email('juan'),
      })}.`;

      return me(unsigned).expect(401);
    });

    it('responde 401 si el usuario del token no existe', () =>
      me(jwt.sign({ sub: randomUUID(), email: email('fantasma') })).expect(
        401,
      ));

    it('protege también los endpoints de UsersModule', async () => {
      await http().get(`/api/users/${userId}`).expect(401);
      await http()
        .get(`/api/users/${userId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });
  });
});
