import type { PrismaService } from '../../prisma/prisma.service.js';
import { OrderLifecycleRegistry } from '../orders/order-lifecycle.registry.js';
import type { OrdersService } from '../orders/orders.service.js';
import { AccountStatusRegistry } from '../users/account-status.registry.js';
import type { WorkerActiveWorkRegistry } from '../worker-profile/active-work.registry.js';
import { WorkerProfileStatusRegistry } from '../worker-profile/profile-status.registry.js';
import { OffersClosureHooks } from './offers-closure.hooks.js';
import { OffersService } from './offers.service.js';

type Fn = ReturnType<typeof vi.fn>;

const NOW = new Date('2026-11-24T12:00:00.000Z');

describe('OffersService: cierres externos (T6.5.2)', () => {
  let calls: string[];
  let openByOrder: Record<string, { id: string; round: number }[]>;
  let orderStatus: Record<string, string>;
  let tx: {
    $queryRaw: Fn;
    offer: { updateMany: Fn; findMany: Fn; count: Fn };
    offerEvent: { createMany: Fn };
    order: { findMany: Fn };
  };
  let activeWork: { lockWorker: Fn };
  let orders: { transition: Fn };
  let service: OffersService;

  beforeEach(() => {
    calls = [];
    openByOrder = {};
    orderStatus = {};
    tx = {
      $queryRaw: vi.fn(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('?');
          if (sql.includes('FROM "orders"')) {
            const id = values[0] as string;
            calls.push(`pedido:${id}`);
            return Promise.resolve([
              {
                status: orderStatus[id] ?? 'EN_NEGOCIACION',
                clientId: 'cliente-1',
                assignedWorkerId: null,
                expired: false,
              },
            ]);
          }
          if (sql.includes('FROM "offers"')) {
            const id = values[0] as string;
            calls.push(`ofertas:${id}`);
            return Promise.resolve(openByOrder[id] ?? []);
          }
          return Promise.resolve([{ now: NOW }]);
        },
      ),
      offer: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      offerEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      order: { findMany: vi.fn().mockResolvedValue([]) },
    };
    activeWork = {
      lockWorker: vi.fn(() => {
        calls.push('trabajador');
        return Promise.resolve();
      }),
    };
    orders = { transition: vi.fn().mockResolvedValue({}) };
    service = new OffersService(
      {} as PrismaService,
      {} as never,
      orders as unknown as OrdersService,
      {} as never,
      {} as never,
      {} as never,
      activeWork as unknown as WorkerActiveWorkRegistry,
    );
  });

  it('cierra las ofertas VIGENTE del pedido con evento del sistema y motivo, sin cambiar el pedido', async () => {
    openByOrder.p1 = [
      { id: 'o1', round: 1 },
      { id: 'o2', round: 2 },
    ];

    await expect(
      service.closeOpenOffersOfOrder(
        tx as never,
        'p1',
        'SIN_EFECTO',
        'PEDIDO_CANCELADO',
      ),
    ).resolves.toBe(2);

    const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain(`"status" = 'VIGENTE'`);
    expect(sql).toContain('FOR UPDATE');
    expect(tx.offer.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['o1', 'o2'] }, status: 'VIGENTE' },
      data: { status: 'SIN_EFECTO', closedAt: NOW },
    });
    expect(tx.offerEvent.createMany.mock.calls[0][0].data).toEqual([
      {
        offerId: 'o1',
        orderId: 'p1',
        type: 'SIN_EFECTO',
        round: 1,
        actorType: 'SISTEMA',
        systemProcess: 'CIERRE_OFERTAS',
        reason: 'PEDIDO_CANCELADO',
      },
      expect.objectContaining({ offerId: 'o2', round: 2 }),
    ]);
    expect(orders.transition).not.toHaveBeenCalled();
  });

  it('sin ofertas abiertas no escribe nada (idempotente)', async () => {
    await expect(
      service.closeOpenOffersOfOrder(
        tx as never,
        'p1',
        'VENCIDA',
        'PEDIDO_VENCIDO',
      ),
    ).resolves.toBe(0);
    expect(tx.offer.updateMany).not.toHaveBeenCalled();
    expect(tx.offerEvent.createMany).not.toHaveBeenCalled();
  });

  it('cuenta suspendida: bloquea al trabajador, recorre los pedidos por id y usa el motivo de cada rol', async () => {
    tx.offer.findMany.mockResolvedValue([{ orderId: 'p3' }, { orderId: 'p1' }]);
    tx.order.findMany.mockResolvedValue([{ id: 'p2' }]);
    openByOrder = {
      p1: [{ id: 'w1', round: 1 }],
      p2: [{ id: 'c1', round: 1 }],
      p3: [{ id: 'w3', round: 2 }],
    };

    await expect(
      service.closeOffersOfSuspendedAccount(tx as never, 'usuario-1'),
    ).resolves.toBe(3);

    expect(calls).toEqual([
      'trabajador',
      'pedido:p1',
      'ofertas:p1',
      'pedido:p2',
      'ofertas:p2',
      'pedido:p3',
      'ofertas:p3',
    ]);
    // Como trabajador solo sus ofertas; como cliente todas las del pedido.
    const offerQueries = tx.$queryRaw.mock.calls.filter((call) =>
      (call[0] as string[]).join('?').includes('FROM "offers"'),
    );
    expect(offerQueries[0]).toContain('usuario-1');
    expect(offerQueries[1].slice(1)).toEqual(['p2', null, null]);
    const reasons = tx.offerEvent.createMany.mock.calls.map(
      (call) => call[0].data[0].reason,
    );
    expect(reasons).toEqual([
      'TRABAJADOR_SUSPENDIDO',
      'CLIENTE_SUSPENDIDO',
      'TRABAJADOR_SUSPENDIDO',
    ]);
    // Sin ofertas vigentes, cada pedido vuelve a PUBLICADO (decision 10).
    expect(orders.transition).toHaveBeenCalledTimes(3);
    expect(orders.transition.mock.calls[0][1]).toEqual({
      orderId: 'p1',
      from: 'EN_NEGOCIACION',
      to: 'PUBLICADO',
      actor: { type: 'SISTEMA', process: 'CIERRE_OFERTAS' },
    });
  });

  it('un pedido con otras ofertas vigentes o ya cerrado no cambia de estado', async () => {
    tx.offer.findMany.mockResolvedValue([{ orderId: 'p1' }, { orderId: 'p2' }]);
    openByOrder = { p1: [{ id: 'a', round: 1 }], p2: [{ id: 'b', round: 1 }] };
    orderStatus.p2 = 'CANCELADO';
    tx.offer.count.mockResolvedValue(1);

    await service.closeOffersOfSuspendedProfile(tx as never, 'trabajador-1');

    expect(orders.transition).not.toHaveBeenCalled();
    expect(activeWork.lockWorker).not.toHaveBeenCalled();
    expect(tx.offerEvent.createMany.mock.calls[0][0].data[0].reason).toBe(
      'PERFIL_SUSPENDIDO',
    );
  });
});

describe('OffersClosureHooks (T6.5.2)', () => {
  it('se registra en los tres puntos de extension y reparte cada evento', async () => {
    const offers = {
      closeOpenOffersOfOrder: vi.fn().mockResolvedValue(1),
      closeOffersOfSuspendedAccount: vi.fn().mockResolvedValue(1),
      closeOffersOfSuspendedProfile: vi.fn().mockResolvedValue(1),
    };
    const lifecycle = new OrderLifecycleRegistry();
    const accounts = new AccountStatusRegistry();
    const profiles = new WorkerProfileStatusRegistry();
    new OffersClosureHooks(
      offers as unknown as OffersService,
      lifecycle,
      accounts,
      profiles,
    ).onModuleInit();
    const tx = {} as never;
    const actor = { type: 'SISTEMA', process: 'X' } as const;

    await lifecycle.runInTransaction(
      [
        {
          type: 'CANCELADO',
          orderId: 'p1',
          fromStatus: 'PUBLICADO',
          actor,
          reason: null,
        },
        { type: 'VENCIDO', orderId: 'p2', fromStatus: 'EN_NEGOCIACION' },
        { type: 'EDITADO', orderId: 'p3', revision: 2, actor },
      ],
      tx,
    );
    await accounts.runSuspended(tx, { userId: 'u1', actorId: 'admin' });
    await profiles.runSuspended(tx, {
      profileId: 'perfil',
      userId: 'u2',
      actorId: 'admin',
    });

    expect(offers.closeOpenOffersOfOrder.mock.calls).toEqual([
      [tx, 'p1', 'SIN_EFECTO', 'PEDIDO_CANCELADO'],
      [tx, 'p2', 'VENCIDA', 'PEDIDO_VENCIDO'],
    ]);
    expect(offers.closeOffersOfSuspendedAccount).toHaveBeenCalledWith(tx, 'u1');
    expect(offers.closeOffersOfSuspendedProfile).toHaveBeenCalledWith(tx, 'u2');
  });
});
