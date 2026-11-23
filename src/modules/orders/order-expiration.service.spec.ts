import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { FileDeletionService } from '../../storage/file-deletion.service.js';
import { OrderExpirationService } from './order-expiration.service.js';
import { OrderLifecycleRegistry } from './order-lifecycle.registry.js';
import type { OrderRetentionService } from './order-retention.service.js';
import { OrdersConfig } from './orders.config.js';

type Fn = ReturnType<typeof vi.fn>;

describe('OrderExpirationService', () => {
  let scheduler: SchedulerRegistry;
  let lifecycle: OrderLifecycleRegistry;
  let tx: { $queryRaw: Fn; $executeRaw: Fn; $transaction: Fn };
  let prisma: { $transaction: Fn };
  let retention: { cleanupClosedOrder: Fn; recoverClosedOrders: Fn };
  let fileDeletion: { processNow: Fn };

  const create = (env: Record<string, string> = {}) => {
    const config = new ConfigService(env);
    return new OrderExpirationService(
      prisma as unknown as PrismaService,
      new OrdersConfig(config),
      lifecycle,
      config,
      scheduler,
      retention as unknown as OrderRetentionService,
      fileDeletion as unknown as FileDeletionService,
    );
  };
  const due = (...ids: string[]) =>
    ids.map((id) => ({ id, status: 'PUBLICADO' }));
  const dueIn = (status: string, ...ids: string[]) =>
    ids.map((id) => ({ id, status }));
  const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

  beforeEach(() => {
    scheduler = new SchedulerRegistry();
    lifecycle = new OrderLifecycleRegistry();
    tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      // Transaccion anidada (SAVEPOINT): mismo cliente en la prueba.
      $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    prisma = {
      $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    retention = {
      cleanupClosedOrder: vi.fn().mockResolvedValue([]),
      recoverClosedOrders: vi.fn().mockResolvedValue({ cleaned: 0, failed: 0 }),
    };
    fileDeletion = { processNow: vi.fn().mockResolvedValue(undefined) };
  });

  it('toma los pedidos con SKIP LOCKED y vence cada uno en su SAVEPOINT', async () => {
    tx.$queryRaw.mockResolvedValueOnce(due('a', 'b'));
    const afterCommit = vi.fn();
    lifecycle.register({ name: 'spy', afterCommit });

    expect(await create().expireDue(5)).toBe(2);

    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toContain(
      'FOR UPDATE SKIP LOCKED',
    );
    expect(tx.$transaction).toHaveBeenCalledTimes(2);
    const history = tx.$executeRaw.mock.calls.filter((call) =>
      sqlOf(call).includes('order_status_history'),
    );
    expect(history).toHaveLength(2);
    expect(sqlOf(history[0])).toContain("'SISTEMA'");
    expect(history[0]).toContain('VENCIMIENTO');
    expect(afterCommit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'VENCIDO', orderId: 'a', fromStatus: 'PUBLICADO' },
      { type: 'VENCIDO', orderId: 'b', fromStatus: 'PUBLICADO' },
    ]);
    // Toda la pasada usa un tiempo limite explicito.
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 30_000 });
  });

  it('busca pedidos PUBLICADO y EN_NEGOCIACION vencidos con el reloj de la BD (T5.1)', async () => {
    await create().expireDue(5);

    const [query, ...params] = tx.$queryRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    expect(query.join('?')).toContain('"expires_at" <= now()');
    expect(params[0]).toEqual(['PUBLICADO', 'EN_NEGOCIACION']);
  });

  it('vence un pedido EN_NEGOCIACION con su historial y el estado de origen en el evento', async () => {
    tx.$queryRaw.mockResolvedValueOnce(dueIn('EN_NEGOCIACION', 'n'));
    const inTransaction = vi.fn().mockResolvedValue(undefined);
    lifecycle.register({ name: 'spy', inTransaction });

    expect(await create().expireDue(5)).toBe(1);

    const [update, history] = tx.$executeRaw.mock.calls;
    // El UPDATE repite las condiciones: estado y plazo, con el reloj de la BD.
    expect(sqlOf(update)).toContain('"expires_at" <= now()');
    expect(update).toContain('EN_NEGOCIACION');
    expect(sqlOf(history)).toContain('order_status_history');
    expect(history).toContain('EN_NEGOCIACION');
    expect(inTransaction).toHaveBeenCalledWith(
      { type: 'VENCIDO', orderId: 'n', fromStatus: 'EN_NEGOCIACION' },
      tx,
    );
  });

  it('si el pedido ya no coincide al actualizarlo, no lo vence ni deja historial', async () => {
    tx.$queryRaw.mockResolvedValueOnce(due('a'));
    tx.$executeRaw.mockResolvedValueOnce(0);
    const afterCommit = vi.fn();
    lifecycle.register({ name: 'spy', afterCommit });

    expect(await create().expireDue(5)).toBe(0);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('limpia cada pedido vencido en su SAVEPOINT y borra los archivos despues de confirmar (T5.4)', async () => {
    tx.$queryRaw.mockResolvedValueOnce(due('a', 'b'));
    retention.cleanupClosedOrder
      .mockResolvedValueOnce(['order-images/a1', 'order-images/a2'])
      .mockResolvedValueOnce([]);
    const afterCommit = vi.fn();
    lifecycle.register({ name: 'spy', afterCommit });

    expect(await create().expireDue(5)).toBe(2);

    expect(retention.cleanupClosedOrder.mock.calls).toEqual([
      [tx, 'a', 'VENCIDO'],
      [tx, 'b', 'VENCIDO'],
    ]);
    // Primero el borrado fisico de lo encolado, despues los efectos posteriores.
    expect(fileDeletion.processNow).toHaveBeenCalledWith([
      'order-images/a1',
      'order-images/a2',
    ]);
    expect(fileDeletion.processNow.mock.invocationCallOrder[0]).toBeLessThan(
      afterCommit.mock.invocationCallOrder[0],
    );
  });

  it('si la limpieza falla, ese pedido no vence en esta pasada y sus archivos no se borran', async () => {
    tx.$queryRaw.mockResolvedValueOnce(due('a', 'b'));
    retention.cleanupClosedOrder
      .mockRejectedValueOnce(new Error('fallo de prueba'))
      .mockResolvedValueOnce(['order-images/b1']);
    const afterCommit = vi.fn();
    lifecycle.register({ name: 'spy', afterCommit });

    expect(await create().expireDue(5)).toBe(1);

    expect(afterCommit.mock.calls.map(([event]) => event.orderId)).toEqual([
      'b',
    ]);
    expect(fileDeletion.processNow).toHaveBeenCalledWith(['order-images/b1']);
  });

  it('un hook que falla solo afecta a su pedido y este se salta en la pasada', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce(due('a', 'b'))
      .mockResolvedValueOnce(due('c'));
    const afterCommit = vi.fn();
    lifecycle.register({
      name: 'falla-con-b',
      inTransaction: async (event) => {
        if (event.orderId === 'b') throw new Error('fallo de prueba');
      },
      afterCommit,
    });

    expect(await create().expireDue(2)).toBe(2);

    expect(afterCommit.mock.calls.map(([event]) => event.orderId)).toEqual([
      'a',
      'c',
    ]);
    // El segundo lote excluye el pedido que fallo.
    expect(tx.$queryRaw.mock.calls[1]).toContainEqual(['b']);
  });

  it('sigue con otro lote mientras el lote salga lleno', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce(due('a', 'b'))
      .mockResolvedValueOnce(due('c'));
    expect(await create().expireDue(2)).toBe(3);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('al arrancar corre una pasada y luego cada 15 minutos (configurable), solo si las tareas estan activas', async () => {
    vi.useFakeTimers();
    try {
      create({ SCHEDULED_JOBS_ENABLED: 'false' }).onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual([]);
      expect(prisma.$transaction).not.toHaveBeenCalled();

      const service = create();
      service.onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual(['order-expiration']);
      // Recuperacion tras un reinicio: primera pasada inmediata.
      await vi.advanceTimersByTimeAsync(0);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      expect(scheduler.getIntervals()).toEqual([]);

      create({
        ORDER_EXPIRATION_INTERVAL_MINUTES: '5',
      }).onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // Pasada al arrancar y una del intervalo de 5 minutos.
      expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cada pasada programada corre la recuperacion despues de vencer (T5.4)', async () => {
    vi.useFakeTimers();
    try {
      const service = create();
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(retention.recoverClosedOrders).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        retention.recoverClosedOrders.mock.invocationCallOrder[0],
      );
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dos pasadas del mismo proceso no se superponen', async () => {
    let finish!: () => void;
    prisma.$transaction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ claimed: 0, events: [], failed: [] });
        }),
    );
    vi.useFakeTimers();
    try {
      const service = create({ ORDER_EXPIRATION_INTERVAL_MINUTES: '1' });
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      // La primera pasada sigue en curso: las del intervalo no arrancan.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
