import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

/**
 * Borra registros de bitácora creados por las pruebas. La tabla es de solo
 * inserción; el trigger solo lo permite con el ajuste de mantenimiento,
 * activo únicamente dentro de esta transacción.
 */
export async function deleteAuditLogs(
  prisma: PrismaService,
  where: Prisma.AdminAuditLogWhereInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.adminAuditLog.deleteMany({ where });
  });
}
