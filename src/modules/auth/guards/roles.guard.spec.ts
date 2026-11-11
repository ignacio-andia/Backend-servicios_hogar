import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '../../../generated/prisma/enums.js';
import { RolesGuard } from './roles.guard.js';

const contextFor = (user?: { roles: RoleName[] }) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('RolesGuard', () => {
  const guardRequiring = (roles?: RoleName[]) => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
    return new RolesGuard(reflector);
  };

  it('deja pasar si el endpoint no exige roles', () => {
    expect(guardRequiring(undefined).canActivate(contextFor())).toBe(true);
  });

  it('exige un usuario autenticado', () => {
    expect(() =>
      guardRequiring([RoleName.ADMINISTRADOR]).canActivate(contextFor()),
    ).toThrow(UnauthorizedException);
  });

  it('rechaza a quien no tiene el rol requerido', () => {
    expect(() =>
      guardRequiring([RoleName.ADMINISTRADOR]).canActivate(
        contextFor({ roles: [RoleName.CLIENTE, RoleName.TRABAJADOR] }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('permite a quien tiene alguno de los roles requeridos', () => {
    expect(
      guardRequiring([RoleName.ADMINISTRADOR]).canActivate(
        contextFor({ roles: [RoleName.CLIENTE, RoleName.ADMINISTRADOR] }),
      ),
    ).toBe(true);
  });
});
