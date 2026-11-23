import { OrderStatus } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { FileDeletionService } from '../../storage/file-deletion.service.js';
import type { FileStorage } from '../../storage/file-storage.js';
import type { OrderImageProcessor } from './images/order-image.processor.js';
import { OrderImagesService } from './images/order-images.service.js';
import { OrderRetentionService } from './order-retention.service.js';

type Fn = ReturnType<typeof vi.fn>;
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

describe('OrderRetentionService (T5.4)', () => {
  let tx: {
    $queryRaw: Fn;
    $executeRaw: Fn;
    $transaction: Fn;
    orderImage: { findMany: Fn; deleteMany: Fn };
    orderAddress: { deleteMany: Fn };
  };
  let prisma: { $transaction: Fn };
  let fileDeletion: { enqueue: Fn; processNow: Fn };
  let service: OrderRetentionService;

  beforeEach(() => {
    tx = {
      // hasEverHadAgreement: por defecto, nunca tuvo acuerdo.
      $queryRaw: vi.fn().mockResolvedValue([{ agreed: false }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
      orderImage: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { storageKey: 'order-images/f1', thumbnailKey: 'order-images/t1' },
          ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      orderAddress: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    fileDeletion = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      processNow: vi.fn().mockResolvedValue(undefined),
    };
    const images = new OrderImagesService(
      prisma as unknown as PrismaService,
      {} as FileStorage,
      fileDeletion as unknown as FileDeletionService,
      {} as OrderImageProcessor,
    );
    service = new OrderRetentionService(
      prisma as unknown as PrismaService,
      images,
      fileDeletion as unknown as FileDeletionService,
    );
  });

  describe('releaseOrderImages', () => {
    it('borra las filas y encola los archivos en la misma transaccion', async () => {
      const images = new OrderImagesService(
        prisma as unknown as PrismaService,
        {} as FileStorage,
        fileDeletion as unknown as FileDeletionService,
        {} as OrderImageProcessor,
      );

      await expect(
        images.releaseOrderImages(tx as never, 'p1', 'vencimiento-pedido'),
      ).resolves.toEqual(['order-images/f1', 'order-images/t1']);
      expect(tx.orderImage.deleteMany).toHaveBeenCalledWith({
        where: { orderId: 'p1' },
      });
      expect(fileDeletion.enqueue).toHaveBeenCalledWith(
        ['order-images/f1', 'order-images/t1'],
        'vencimiento-pedido',
        tx,
      );
    });

    it('sin fotos no escribe nada', async () => {
      tx.orderImage.findMany.mockResolvedValue([]);
      const images = new OrderImagesService(
        prisma as unknown as PrismaService,
        {} as FileStorage,
        fileDeletion as unknown as FileDeletionService,
        {} as OrderImageProcessor,
      );

      await expect(
        images.releaseOrderImages(tx as never, 'p1', 'x'),
      ).resolves.toEqual([]);
      expect(tx.orderImage.deleteMany).not.toHaveBeenCalled();
      expect(fileDeletion.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('hasEverHadAgreement', () => {
    it('revisa el trabajador asignado y el historial, no solo el estado actual', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ agreed: true }]);

      await expect(
        service.hasEverHadAgreement(tx as never, 'p1'),
      ).resolves.toBe(true);

      const [call] = tx.$queryRaw.mock.calls;
      expect(sqlOf(call)).toContain('"assigned_worker_id" IS NOT NULL');
      expect(sqlOf(call)).toContain('"order_status_history"');
      // ACORDADO y todos los posteriores, incluido CERRADO (lista exacta).
      expect([...(call[1] as string[])].sort()).toEqual(
        [
          OrderStatus.ACORDADO,
          OrderStatus.ANTICIPO_REGISTRADO,
          OrderStatus.VISITA_REALIZADA,
          OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
          OrderStatus.EN_EJECUCION,
          OrderStatus.TERMINADO,
          OrderStatus.EN_RECLAMO,
          OrderStatus.CERRADO,
        ].sort(),
      );
    });
  });

  describe('cleanupClosedOrder', () => {
    it('borra fotos y direccion y anonimiza la descripcion, de forma idempotente', async () => {
      await expect(
        service.cleanupClosedOrder(tx as never, 'p1', OrderStatus.VENCIDO),
      ).resolves.toEqual(['order-images/f1', 'order-images/t1']);

      expect(fileDeletion.enqueue).toHaveBeenCalledWith(
        ['order-images/f1', 'order-images/t1'],
        'vencimiento-pedido',
        tx,
      );
      expect(tx.orderAddress.deleteMany).toHaveBeenCalledWith({
        where: { orderId: 'p1' },
      });
      const [update] = tx.$executeRaw.mock.calls;
      expect(update).toContain(
        'Descripción no disponible por cierre del pedido.',
      );
      expect(sqlOf(update)).toContain('"anonymized_at" = now()');
      expect(sqlOf(update)).toContain('"anonymized_at" IS NULL');
      // Nunca borra el historial ni el pedido.
      expect(sqlOf(update)).not.toContain('DELETE');
    });

    it('al cancelar encola con su propio motivo', async () => {
      await service.cleanupClosedOrder(
        tx as never,
        'p1',
        OrderStatus.CANCELADO,
      );

      expect(fileDeletion.enqueue.mock.calls[0][1]).toBe('cancelacion-pedido');
    });

    it('no toca un pedido que alguna vez tuvo un acuerdo', async () => {
      tx.$queryRaw.mockResolvedValueOnce([{ agreed: true }]);

      await expect(
        service.cleanupClosedOrder(tx as never, 'p1', OrderStatus.CANCELADO),
      ).resolves.toEqual([]);
      expect(tx.orderImage.findMany).not.toHaveBeenCalled();
      expect(tx.orderAddress.deleteMany).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.PUBLICADO, OrderStatus.ACORDADO, OrderStatus.CERRADO])(
      'no limpia un pedido en %s',
      async (status) => {
        await expect(
          service.cleanupClosedOrder(tx as never, 'p1', status),
        ).resolves.toEqual([]);
        expect(tx.$queryRaw).not.toHaveBeenCalled();
        expect(tx.$executeRaw).not.toHaveBeenCalled();
      },
    );
  });

  describe('recoverClosedOrders', () => {
    it('toma pedidos cerrados pendientes con SKIP LOCKED, excluye acuerdos y borra despues de confirmar', async () => {
      tx.$queryRaw
        .mockResolvedValueOnce([
          { id: 'p1', status: OrderStatus.VENCIDO },
          { id: 'p2', status: OrderStatus.CANCELADO },
        ])
        .mockResolvedValue([{ agreed: false }]);

      await expect(service.recoverClosedOrders(5)).resolves.toEqual({
        cleaned: 2,
        failed: 0,
      });

      const select = sqlOf(tx.$queryRaw.mock.calls[0]);
      expect(select).toContain('FOR UPDATE OF o SKIP LOCKED');
      expect(select).toContain('"assigned_worker_id" IS NULL');
      expect(select).toContain('NOT EXISTS');
      expect(select).toContain('"anonymized_at" IS NULL');
      expect(select).toContain('"order_images"');
      // Un SAVEPOINT por pedido y el borrado fisico al final.
      expect(tx.$transaction).toHaveBeenCalledTimes(2);
      expect(fileDeletion.processNow).toHaveBeenCalledTimes(1);
      expect(fileDeletion.processNow.mock.calls[0][0]).toHaveLength(4);
    });

    it('un pedido que falla no frena al resto y se salta en las siguientes tandas', async () => {
      tx.$queryRaw
        .mockResolvedValueOnce([
          { id: 'p1', status: OrderStatus.VENCIDO },
          { id: 'p2', status: OrderStatus.VENCIDO },
        ])
        .mockRejectedValueOnce(new Error('fallo de prueba'))
        .mockResolvedValueOnce([{ agreed: false }])
        .mockResolvedValueOnce([]);

      await expect(service.recoverClosedOrders(2)).resolves.toEqual({
        cleaned: 1,
        failed: 1,
      });
      // La segunda tanda excluye el pedido que fallo.
      expect(tx.$queryRaw.mock.calls[3]).toContainEqual(['p1']);
    });
  });
});
