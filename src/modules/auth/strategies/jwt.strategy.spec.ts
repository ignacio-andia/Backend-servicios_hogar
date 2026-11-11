import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleName, UserStatus } from '../../../generated/prisma/enums.js';
import { PublicUser, UsersService } from '../../users/users.service.js';
import { JwtStrategy } from './jwt.strategy.js';

const USER_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';

const user = (status: UserStatus): PublicUser => ({
  id: USER_ID,
  firstName: 'Juan',
  lastName: 'Pérez',
  email: 'juan@example.com',
  phone: null,
  status,
  roles: [RoleName.CLIENTE],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('JwtStrategy', () => {
  let findById: ReturnType<typeof vi.fn>;
  let strategy: JwtStrategy;

  beforeEach(() => {
    findById = vi.fn();
    strategy = new JwtStrategy(
      new ConfigService({ JWT_SECRET: 'x'.repeat(32) }),
      { findById } as unknown as UsersService,
    );
  });

  it('exige un JWT_SECRET de longitud suficiente', () => {
    expect(
      () =>
        new JwtStrategy(
          new ConfigService({ JWT_SECRET: 'corto' }),
          {} as UsersService,
        ),
    ).toThrow(/JWT_SECRET/);
  });

  it('devuelve el usuario leído de la base de datos', async () => {
    const activeUser = user(UserStatus.ACTIVO);
    findById.mockResolvedValue(activeUser);

    await expect(
      strategy.validate({ sub: USER_ID, email: 'otro@example.com' }),
    ).resolves.toBe(activeUser);
    expect(findById).toHaveBeenCalledWith(USER_ID);
  });

  it('rechaza payloads sin sub', async () => {
    await expect(strategy.validate({})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(findById).not.toHaveBeenCalled();
  });

  it('rechaza usuarios que ya no existen', async () => {
    findById.mockRejectedValue(new NotFoundException());

    await expect(
      strategy.validate({ sub: USER_ID, email: 'juan@example.com' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([UserStatus.INACTIVO, UserStatus.SUSPENDIDO])(
    'rechaza usuarios en estado %s',
    async (status) => {
      findById.mockResolvedValue(user(status));

      await expect(
        strategy.validate({ sub: USER_ID, email: 'juan@example.com' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
});
