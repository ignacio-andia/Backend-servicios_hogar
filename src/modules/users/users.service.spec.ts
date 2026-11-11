import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, RoleName, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const ADMIN_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const CLIENT_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const OTHER_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';

const actorRecord = (
  id: string,
  roles: RoleName[],
  status: UserStatus = UserStatus.ACTIVO,
) => ({ id, status, roles: roles.map((role) => ({ role })) });

const userRecord = (
  id: string,
  roles: RoleName[] = [RoleName.CLIENTE],
  status: UserStatus = UserStatus.ACTIVO,
) => ({
  id,
  firstName: 'Ana',
  lastName: 'Pérez',
  email: 'ana@example.com',
  phone: null,
  status,
  createdAt: new Date(),
  updatedAt: new Date(),
  roles: roles.map((role) => ({ role })),
});

const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('error', {
    code,
    clientVersion: 'test',
  });

describe('UsersService', () => {
  let prisma: {
    user: Record<
      'create' | 'findUnique' | 'findMany' | 'count' | 'update',
      ReturnType<typeof vi.fn>
    >;
    userRole: Record<'upsert' | 'delete', ReturnType<typeof vi.fn>>;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
      userRole: { upsert: vi.fn(), delete: vi.fn() },
      $transaction: vi.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
    };
    service = new UsersService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('normaliza el correo, asigna CLIENTE y no selecciona el hash', async () => {
      prisma.user.create.mockResolvedValue(userRecord(CLIENT_ID));

      const user = await service.create({
        firstName: 'Ana',
        lastName: 'Pérez',
        email: '  Ana@Example.COM ',
        passwordHash: 'hash',
      });

      const args = prisma.user.create.mock.calls[0][0];
      expect(args.data.email).toBe('ana@example.com');
      expect(args.data.roles).toEqual({
        create: { role: RoleName.CLIENTE },
      });
      expect(args.select.passwordHash).toBeUndefined();
      expect(user.roles).toEqual([RoleName.CLIENTE]);
      expect(user).not.toHaveProperty('passwordHash');
    });

    it('lanza ConflictException si el correo ya existe', async () => {
      prisma.user.create.mockRejectedValue(knownError('P2002'));

      await expect(
        service.create({
          firstName: 'Ana',
          lastName: 'Pérez',
          email: 'ana@example.com',
          passwordHash: 'hash',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('consultas internas', () => {
    it('findById lanza NotFound sin consultar si el id no es UUID', async () => {
      await expect(service.findById('abc')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('findById lanza NotFound si el usuario no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findById(CLIENT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('findCredentialsByEmail devuelve el hash para AuthModule', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: CLIENT_ID,
        email: 'ana@example.com',
        passwordHash: 'hash',
        status: UserStatus.ACTIVO,
        roles: [{ role: RoleName.CLIENTE }],
      });

      const credentials =
        await service.findCredentialsByEmail('ANA@example.com');

      expect(prisma.user.findUnique.mock.calls[0][0].where).toEqual({
        email: 'ana@example.com',
      });
      expect(credentials).toEqual({
        id: CLIENT_ID,
        email: 'ana@example.com',
        passwordHash: 'hash',
        status: UserStatus.ACTIVO,
        roles: [RoleName.CLIENTE],
      });
    });
  });

  describe('autorización del actor', () => {
    it('rechaza actores inexistentes o inactivos', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(CLIENT_ID, [RoleName.CLIENTE], UserStatus.INACTIVO),
      );

      await expect(
        service.findOne(CLIENT_ID, CLIENT_ID),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('findAll está reservado a administradores', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(CLIENT_ID, [RoleName.CLIENTE, RoleName.TRABAJADOR]),
      );

      await expect(
        service.findAll(CLIENT_ID, { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('findAll pagina para administradores', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(ADMIN_ID, [RoleName.ADMINISTRADOR]),
      );
      prisma.user.findMany.mockResolvedValue([userRecord(CLIENT_ID)]);
      prisma.user.count.mockResolvedValue(21);

      const result = await service.findAll(ADMIN_ID, { page: 2, limit: 10 });

      expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({
        skip: 10,
        take: 10,
      });
      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        total: 21,
        totalPages: 3,
      });
    });

    it('un usuario común no puede consultar a otro usuario', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(CLIENT_ID, [RoleName.CLIENTE]),
      );

      await expect(service.findOne(CLIENT_ID, OTHER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(CLIENT_ID, [RoleName.CLIENTE]),
      );
    });

    it('solo envía a Prisma los campos personales permitidos', async () => {
      prisma.user.update.mockResolvedValue(userRecord(CLIENT_ID));
      const dto = {
        firstName: 'Ana María',
        phone: null,
        email: 'otro@example.com',
        roles: [RoleName.ADMINISTRADOR],
      };

      await service.update(CLIENT_ID, CLIENT_ID, dto);

      expect(prisma.user.update.mock.calls[0][0].data).toEqual({
        firstName: 'Ana María',
        phone: null,
      });
    });

    it('rechaza una actualización vacía', async () => {
      await expect(
        service.update(CLIENT_ID, CLIENT_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('traduce P2025 a NotFoundException', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(ADMIN_ID, [RoleName.ADMINISTRADOR]),
      );
      prisma.user.update.mockRejectedValue(knownError('P2025'));

      await expect(
        service.update(ADMIN_ID, OTHER_ID, { lastName: 'Gómez' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('permite que un usuario desactive su propia cuenta', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(actorRecord(CLIENT_ID, [RoleName.CLIENTE]))
        .mockResolvedValueOnce(userRecord(CLIENT_ID));
      prisma.user.update.mockResolvedValue(
        userRecord(CLIENT_ID, [RoleName.CLIENTE], UserStatus.INACTIVO),
      );

      const user = await service.updateStatus(CLIENT_ID, CLIENT_ID, {
        status: UserStatus.INACTIVO,
      });

      expect(user.status).toBe(UserStatus.INACTIVO);
    });

    it('un usuario común no puede asignarse otro estado', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(CLIENT_ID, [RoleName.CLIENTE]),
      );

      await expect(
        service.updateStatus(CLIENT_ID, CLIENT_ID, {
          status: UserStatus.SUSPENDIDO,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('un usuario común no puede cambiar el estado de otro', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(CLIENT_ID, [RoleName.CLIENTE]),
      );

      await expect(
        service.updateStatus(CLIENT_ID, OTHER_ID, {
          status: UserStatus.INACTIVO,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('no permite desactivar al único administrador activo', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(actorRecord(ADMIN_ID, [RoleName.ADMINISTRADOR]))
        .mockResolvedValueOnce(userRecord(ADMIN_ID, [RoleName.ADMINISTRADOR]));
      prisma.user.count.mockResolvedValue(1);

      await expect(
        service.updateStatus(ADMIN_ID, ADMIN_ID, {
          status: UserStatus.INACTIVO,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('grantWorkerRole', () => {
    it('solo otorga TRABAJADOR, de forma idempotente y con la transaccion recibida', async () => {
      const tx = { userRole: { upsert: vi.fn() } };

      await service.grantWorkerRole(CLIENT_ID, tx as never);

      expect(tx.userRole.upsert).toHaveBeenCalledWith({
        where: {
          userId_role: { userId: CLIENT_ID, role: RoleName.TRABAJADOR },
        },
        create: { userId: CLIENT_ID, role: RoleName.TRABAJADOR },
        update: {},
      });
      expect(prisma.userRole.upsert).not.toHaveBeenCalled();
    });
  });

  describe('gestión de roles', () => {
    it('solo un administrador puede asignar roles', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(CLIENT_ID, [RoleName.CLIENTE]),
      );

      await expect(
        service.assignRole(CLIENT_ID, CLIENT_ID, RoleName.ADMINISTRADOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.userRole.upsert).not.toHaveBeenCalled();
    });

    it('un administrador no puede modificar sus propios roles', async () => {
      prisma.user.findUnique.mockResolvedValue(
        actorRecord(ADMIN_ID, [RoleName.ADMINISTRADOR]),
      );

      await expect(
        service.assignRole(ADMIN_ID, ADMIN_ID, RoleName.TRABAJADOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('registra quién asignó el rol', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(actorRecord(ADMIN_ID, [RoleName.ADMINISTRADOR]))
        .mockResolvedValueOnce(userRecord(CLIENT_ID))
        .mockResolvedValueOnce(
          userRecord(CLIENT_ID, [RoleName.CLIENTE, RoleName.TRABAJADOR]),
        );

      const user = await service.assignRole(
        ADMIN_ID,
        CLIENT_ID,
        RoleName.TRABAJADOR,
      );

      expect(prisma.userRole.upsert.mock.calls[0][0].create).toEqual({
        userId: CLIENT_ID,
        role: RoleName.TRABAJADOR,
        assignedById: ADMIN_ID,
      });
      expect(user.roles).toEqual([RoleName.CLIENTE, RoleName.TRABAJADOR]);
    });

    it('no permite retirar el último rol de un usuario', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(actorRecord(ADMIN_ID, [RoleName.ADMINISTRADOR]))
        .mockResolvedValueOnce(userRecord(CLIENT_ID));

      await expect(
        service.revokeRole(ADMIN_ID, CLIENT_ID, RoleName.CLIENTE),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.userRole.delete).not.toHaveBeenCalled();
    });
  });
});
