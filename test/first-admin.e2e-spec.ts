import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import {
  FirstAdminInputError,
  FirstAdministratorService,
} from '../src/cli/first-admin.service.js';
import { FirstAdminModule } from '../src/cli/first-admin.module.js';
import { RoleName, UserStatus } from '../src/generated/prisma/client.js';
import { FIRST_ADMIN_EXISTS_MESSAGE } from '../src/modules/users/users.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  createIsolatedSchema,
  IsolatedSchema,
} from './utils/isolated-schema.js';

// Corre sobre un esquema temporal vacio con todas las migraciones aplicadas:
// no lee ni modifica los datos del esquema public de la base de desarrollo.
describe('Creación del primer administrador (RF-04, e2e)', () => {
  let isolated: IsolatedSchema;
  let service: FirstAdministratorService;
  let close: () => Promise<void>;

  const input = (extra: object = {}) => ({
    firstName: 'Ada',
    lastName: 'Admin',
    email: 'Ada.Admin@Example.com',
    password: 'Clave1234',
    ...extra,
  });
  const administrators = () =>
    isolated.prisma.userRole.count({ where: { role: RoleName.ADMINISTRADOR } });

  beforeAll(async () => {
    isolated = await createIsolatedSchema('first_admin');
    const moduleRef = await Test.createTestingModule({
      imports: [FirstAdminModule],
    })
      .overrideProvider(PrismaService)
      .useValue(isolated.prisma)
      .compile();
    const context = await moduleRef.init();
    service = context.get(FirstAdministratorService);
    close = () => context.close();
  });

  afterAll(async () => {
    await close?.();
    await isolated?.drop();
  });

  beforeEach(async () => {
    // Cada prueba parte de un esquema sin cuentas.
    await isolated.prisma.userRole.deleteMany();
    await isolated.prisma.user.deleteMany();
  });

  it('usa un esquema aislado y vacío', async () => {
    expect(isolated.schema).toMatch(/^first_admin_/);
    expect(await isolated.prisma.user.count()).toBe(0);
  });

  it('crea el primer administrador con el rol, el estado y el hash correctos', async () => {
    const admin = await service.create(input({ phone: ' 70000009 ' }));

    expect(admin).toMatchObject({
      email: 'ada.admin@example.com',
      phone: '70000009',
      status: UserStatus.ACTIVO,
      roles: [RoleName.ADMINISTRADOR],
    });
    expect(admin).not.toHaveProperty('passwordHash');

    const row = await isolated.prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      include: { roles: true },
    });
    // Mismo mecanismo que el registro: bcrypt con 12 rondas, nunca en claro.
    expect(row.passwordHash).not.toContain('Clave1234');
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare('Clave1234', row.passwordHash)).toBe(true);
    expect(row.roles.map((r) => r.role)).toEqual([RoleName.ADMINISTRADOR]);
  });

  it('registra sin teléfono cuando se omite', async () => {
    const admin = await service.create(input({ phone: '   ' }));
    expect(admin.phone).toBeNull();
  });

  it('rechaza la ejecución si ya existe un administrador', async () => {
    await service.create(input());

    await expect(
      service.create(input({ email: 'otro@example.com' })),
    ).rejects.toThrow(new ConflictException(FIRST_ADMIN_EXISTS_MESSAGE));
    expect(await administrators()).toBe(1);
    expect(await isolated.prisma.user.count()).toBe(1);
  });

  it('rechaza si existe un administrador aunque esté suspendido', async () => {
    const admin = await service.create(input());
    await isolated.prisma.user.update({
      where: { id: admin.id },
      data: { status: UserStatus.SUSPENDIDO },
    });

    await expect(
      service.create(input({ email: 'otro@example.com' })),
    ).rejects.toThrow(FIRST_ADMIN_EXISTS_MESSAGE);
  });

  it.each([
    ['correo inválido', { email: 'no-es-correo' }],
    ['contraseña corta', { password: 'Ab1' }],
    ['contraseña sin números', { password: 'SoloLetras' }],
    ['nombre vacío', { firstName: '   ' }],
    ['teléfono inválido', { phone: '7000-0000' }],
  ])('rechaza credenciales inválidas: %s', async (_label, extra) => {
    await expect(service.create(input(extra))).rejects.toBeInstanceOf(
      FirstAdminInputError,
    );
    expect(await isolated.prisma.user.count()).toBe(0);
  });

  it('no duplica un correo ya registrado ni lo convierte en administrador', async () => {
    await isolated.prisma.user.create({
      data: {
        firstName: 'Cliente',
        lastName: 'Existente',
        email: 'ada.admin@example.com',
        passwordHash: 'hash',
        roles: { create: { role: RoleName.CLIENTE } },
      },
    });

    await expect(service.create(input())).rejects.toThrow(
      'El correo electrónico ya está registrado',
    );
    expect(await administrators()).toBe(0);
    expect(await isolated.prisma.user.count()).toBe(1);
  });

  it('ejecuciones simultáneas crean un solo administrador', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        service.create(input({ email: `admin${i}@example.com` })),
      ),
    );

    const created = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(ConflictException);
      expect((result.reason as Error).message).toBe(FIRST_ADMIN_EXISTS_MESSAGE);
    }
    expect(await administrators()).toBe(1);
    expect(await isolated.prisma.user.count()).toBe(1);
  });
});
