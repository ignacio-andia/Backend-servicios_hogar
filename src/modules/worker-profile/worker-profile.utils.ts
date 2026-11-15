import { ForbiddenException } from '@nestjs/common';
import { Prisma, RoleName, UserStatus } from '../../generated/prisma/client.js';
import type { CatalogItem } from '../catalogs/catalogs.service.js';
import type { PublicUser, UsersService } from '../users/users.service.js';

// Auxiliares internos de WorkerProfileModule compartidos por sus servicios.

export const PRISMA_UNIQUE_VIOLATION = 'P2002';

export interface CatalogRef {
  id: string;
  name: string;
  isActive: boolean;
}

export function toRef({ id, name, isActive }: CatalogItem): CatalogRef {
  return { id, name, isActive };
}

export function normalizeText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function isPrismaError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

/** Defensa en profundidad para operaciones administrativas publicas. */
export async function assertActiveAdmin(
  users: UsersService,
  adminId: string,
): Promise<PublicUser> {
  const admin = await users.findById(adminId).catch(() => null);
  if (
    !admin ||
    admin.status !== UserStatus.ACTIVO ||
    !admin.roles.includes(RoleName.ADMINISTRADOR)
  ) {
    throw new ForbiddenException('Operación reservada a administradores');
  }
  return admin;
}
