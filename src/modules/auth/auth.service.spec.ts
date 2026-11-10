import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RoleName, UserStatus } from '../../generated/prisma/enums.js';
import { PublicUser, UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';

const USER_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const PASSWORD = 'Password123';

const publicUser: PublicUser = {
  id: USER_ID,
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'juan@example.com',
  phone: null,
  status: UserStatus.ACTIVO,
  roles: [RoleName.CLIENTE],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AuthService', () => {
  let usersService: Record<
    'create' | 'findById' | 'findCredentialsByEmail',
    ReturnType<typeof vi.fn>
  >;
  let jwtService: { signAsync: ReturnType<typeof vi.fn> };
  let service: AuthService;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    usersService = {
      create: vi.fn().mockResolvedValue(publicUser),
      findById: vi.fn().mockResolvedValue(publicUser),
      findCredentialsByEmail: vi.fn(),
    };
    jwtService = { signAsync: vi.fn().mockResolvedValue('token') };
    service = new AuthService(
      usersService as unknown as UsersService,
      jwtService as unknown as JwtService,
    );
  });

  const credentials = (status: UserStatus = UserStatus.ACTIVO) => ({
    id: USER_ID,
    email: publicUser.email,
    passwordHash,
    status,
    roles: [RoleName.CLIENTE],
  });

  describe('register', () => {
    it('hashea la contraseña y delega la creación en UsersService', async () => {
      const result = await service.register({
        firstName: 'Juan',
        lastName: 'Pérez',
        email: 'juan@example.com',
        password: PASSWORD,
        phone: '70000000',
      });

      const dto = usersService.create.mock.calls[0][0];
      expect(dto).not.toHaveProperty('password');
      expect(dto.passwordHash).not.toBe(PASSWORD);
      expect(await bcrypt.compare(PASSWORD, dto.passwordHash)).toBe(true);
      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: USER_ID,
        email: publicUser.email,
      });
      expect(result).toEqual({
        accessToken: 'token',
        tokenType: 'Bearer',
        user: publicUser,
      });
    });
  });

  describe('login', () => {
    it('emite un token con credenciales correctas', async () => {
      usersService.findCredentialsByEmail.mockResolvedValue(credentials());

      const result = await service.login({
        email: publicUser.email,
        password: PASSWORD,
      });

      expect(usersService.findById).toHaveBeenCalledWith(USER_ID);
      expect(result.accessToken).toBe('token');
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('usa el mismo error para correo inexistente y contraseña incorrecta', async () => {
      usersService.findCredentialsByEmail.mockResolvedValueOnce(null);
      const unknownEmail = await service
        .login({ email: 'nadie@example.com', password: PASSWORD })
        .catch((error: unknown) => error);

      usersService.findCredentialsByEmail.mockResolvedValueOnce(credentials());
      const wrongPassword = await service
        .login({ email: publicUser.email, password: 'Otra12345' })
        .catch((error: unknown) => error);

      expect(unknownEmail).toBeInstanceOf(UnauthorizedException);
      expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
      expect((unknownEmail as Error).message).toBe(
        (wrongPassword as Error).message,
      );
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it.each([UserStatus.INACTIVO, UserStatus.SUSPENDIDO])(
      'rechaza cuentas en estado %s',
      async (status) => {
        usersService.findCredentialsByEmail.mockResolvedValue(
          credentials(status),
        );

        await expect(
          service.login({ email: publicUser.email, password: PASSWORD }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(jwtService.signAsync).not.toHaveBeenCalled();
      },
    );

    it('no revela el estado de la cuenta si la contraseña es incorrecta', async () => {
      usersService.findCredentialsByEmail.mockResolvedValue(
        credentials(UserStatus.SUSPENDIDO),
      );

      await expect(
        service.login({ email: publicUser.email, password: 'Otra12345' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
