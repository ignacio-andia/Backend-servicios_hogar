import { NotificationResourceType } from '../../src/generated/prisma/enums.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

/**
 * Borra los perfiles de trabajador (y sus datos) de los usuarios indicados,
 * mas sus registros de bitacora y sus notificaciones (las recibidas y las que
 * apuntan a esos perfiles, aunque las haya recibido otro administrador de la
 * base compartida). Solo toca datos creados por las pruebas.
 * El historial de estados y la bitacora son de solo insercion: el ajuste de
 * mantenimiento se activa unicamente dentro de esta transaccion.
 */
export async function deleteWorkerData(
  prisma: PrismaService,
  userIds: string[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    const profiles = await tx.workerProfile.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });
    const profileIds = profiles.map((profile) => profile.id);
    await tx.notification.deleteMany({
      where: {
        OR: [
          { userId: { in: userIds } },
          {
            resourceType: NotificationResourceType.PERFIL_TRABAJADOR,
            resourceId: { in: profileIds },
          },
        ],
      },
    });
    await tx.zoneChangeRequest.deleteMany({
      where: { profileId: { in: profileIds } },
    });
    await tx.workerDocument.updateMany({
      where: { profileId: { in: profileIds } },
      data: { replacedById: null },
    });
    await tx.workerDocument.deleteMany({
      where: { profileId: { in: profileIds } },
    });
    await tx.workerProfileStatusHistory.deleteMany({
      where: { profileId: { in: profileIds } },
    });
    await tx.workerProfile.deleteMany({ where: { id: { in: profileIds } } });
    await tx.adminAuditLog.deleteMany({ where: { actorId: { in: userIds } } });
  });
}
