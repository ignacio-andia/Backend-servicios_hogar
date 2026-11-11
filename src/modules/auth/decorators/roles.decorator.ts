import { SetMetadata } from '@nestjs/common';
import type { RoleName } from '../../../generated/prisma/enums.js';

export const ROLES_KEY = 'roles';

/** Roles permitidos para un endpoint; lo evalúa RolesGuard. */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
