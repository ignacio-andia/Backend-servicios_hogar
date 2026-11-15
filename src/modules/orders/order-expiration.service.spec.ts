import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { OrderExpirationService } from './order-expiration.service.js';
import { OrderLifecycleRegistry } from './order-lifecycle.registry.js';
import { OrdersConfig } from './orders.config.js';

type Fn = ReturnType<typeof vi.fn>;

describe('OrderExpirationService', () => {
  let scheduler: SchedulerRegistry;
  let lifecycle: OrderLifecycleRegistry;
  let tx: { $queryRaw: Fn; $executeRaw: Fn; $transaction: Fn };
  let prisma: { $transaction: Fn };

  const create = (env: Record<string, string> = {}) => {
    const config = new ConfigService(env);
    return new OrderExpirationService(
      prisma as unknown as PrismaService,
      new OrdersConfig(config),
      lifecycle,
      config,
      scheduler,
    );
  };
  const due = (...ids: string[]) =>
    ids.map((id) => ({ id, status: 'PUBLICADO' }));
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
      { type: 'VENCIDO', orderId: 'a' },
      { type: 'VENCIDO', orderId: 'b' },
    ]);
    // Toda la pasada usa un tiempo limite explicito.
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({ timeout: 30_000 });
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

  it('corre cada 15 minutos (configurable) solo si las tareas estan activas', () => {
    vi.useFakeTimers();
    try {
      create({ SCHEDULED_JOBS_ENABLED: 'false' }).onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual([]);

      const service = create();
      service.onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual(['order-expiration']);
      vi.advanceTimersByTime(14 * 60_000);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      expect(scheduler.getIntervals()).toEqual([]);

      create({
        ORDER_EXPIRATION_INTERVAL_MINUTES: '5',
      }).onApplicationBootstrap();
      vi.advanceTimersByTime(5 * 60_000);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
