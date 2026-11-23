import type { PrismaService } from '../../src/prisma/prisma.service.js';

/**
 * Borra los pedidos de los clientes indicados (historial, fotos, direccion)
 * y sus claves en la cola de borrado. Solo toca datos creados por las pruebas;
 * el historial es de solo insercion y se borra con el ajuste de mantenimiento.
 */
export async function deleteOrderData(
  prisma: PrismaService,
  clientIds: string[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    const orders = await tx.order.findMany({
      where: { clientId: { in: clientIds } },
      select: { id: true },
    });
    const orderIds = orders.map((order) => order.id);
    const images = await tx.orderImage.findMany({
      where: { orderId: { in: orderIds } },
      select: { storageKey: true, thumbnailKey: true },
    });
    // T6.2: las ofertas y su historial (solo insercion) van antes que el pedido.
    await tx.offerEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.offer.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderStatusHistory.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await tx.orderImage.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    await tx.pendingFileDeletion.deleteMany({
      where: {
        storageKey: {
          in: images.flatMap((image) => [image.storageKey, image.thumbnailKey]),
        },
      },
    });
  });
}
