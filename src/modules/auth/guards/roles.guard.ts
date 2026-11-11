import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RoleName } from '../../../generated/prisma/enums.js';
import type { PublicUser } from '../../users/users.service.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

/**
 * Autoriza según los roles del usuario que JwtStrategy cargó desde la base
 * de datos. Debe ejecutarse después de JwtAuthGuard.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      RoleName[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!requiredRoles?.length) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<{ user?: PublicUser }>();
    if (!user) {
      throw new UnauthorizedException();
    }
    if (!requiredRoles.some((role) => user.roles.includes(role))) {
      throw new ForbiddenException(
        'No tiene permisos para realizar esta operación',
      );
    }
    return true;
  }
}
