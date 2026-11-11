import { applyDecorators, UseGuards } from '@nestjs/common';
import type { RoleName } from '../../../generated/prisma/enums.js';
import { JwtAuthGuard } from '../guards/jwt-auth.guard.js';
import { RolesGuard } from '../guards/roles.guard.js';
import { Roles } from './roles.decorator.js';

/** Exige un JWT válido y, si se indican, alguno de los roles. */
export const Auth = (...roles: RoleName[]) =>
  applyDecorators(UseGuards(JwtAuthGuard, RolesGuard), Roles(...roles));
