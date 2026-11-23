import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import { OfferExpirationService } from './offer-expiration.service.js';
import { OffersService } from './offers.service.js';

type Fn = ReturnType<typeof vi.fn>;

const NOW = new Date('2026-11-24T12:00:00.000Z');

describe('OfferExpirationService (T6.5.1)', () => {
  let prisma: { $queryRaw: Fn };
  let offers: { expireOffersOfOrder: Fn };
  let scheduler: SchedulerRegistry;

  const create = (env: Record<string, string> = {}) =>
    new OfferExpirationService(
      prisma as unknown as PrismaService,
      offers as unknown as OffersService,
      new ConfigService(env),
      scheduler,
    );

  beforeEach(() => {
    prisma = { $queryRaw: vi.fn().mockResolvedValue([]) };
    offers = { expireOffersOfOrder: vi.fn().mockResolvedValue(1) };
    scheduler = new SchedulerRegistry();
  });

  it('procesa cada pedido con ofertas vencidas, por lotes, hasta terminar', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ orderId: 'p1' }, { orderId: 'p2' }])
      .mockResolvedValueOnce([{ orderId: 'p3' }]);
    offers.expireOffersOfOrder.mockResolvedValueOnce(2);

    await expect(create().expireDue(2)).resolves.toBe(4);

    expect(offers.expireOffersOfOrder.mock.calls).toEqual([
      ['p1'],
      ['p2'],
      ['p3'],
    ]);
    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain(`"status" = 'VIGENTE'`);
    expect(sql).toContain('"expires_at" <= now()');
    // El segundo lote excluye lo ya procesado en la pasada.
    expect(prisma.$queryRaw.mock.calls[1]).toContainEqual(['p1', 'p2']);
  });

  it('un pedido que falla no frena al resto y no se repite en la misma pasada', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ orderId: 'p1' }, { orderId: 'p2' }])
      .mockResolvedValueOnce([]);
    offers.expireOffersOfOrder.mockRejectedValueOnce(new Error('fallo'));

    await expect(create().expireDue(2)).resolves.toBe(1);
    expect(prisma.$queryRaw.mock.calls[1]).toContainEqual(['p1', 'p2']);
  });

  it('al arrancar corre enseguida (recuperacion) y luego por intervalo, solo si las tareas estan activas', async () => {
    vi.useFakeTimers();
    try {
      create({ SCHEDULED_JOBS_ENABLED: 'false' }).onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();

      const service = create({ OFFER_EXPIRATION_INTERVAL_MINUTES: '5' });
      service.onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual(['offer-expiration']);
      await vi.advanceTimersByTimeAsync(0);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
      expect(scheduler.getIntervals()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dos pasadas del mismo proceso no se superponen', async () => {
    let release!: (value: unknown) => void;
    prisma.$queryRaw.mockReturnValueOnce(
      new Promise((resolve) => (release = resolve)),
    );
    vi.useFakeTimers();
    try {
      const service = create({ OFFER_EXPIRATION_INTERVAL_MINUTES: '1' });
      service.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      release([]);
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechaza un intervalo invalido al arrancar', () => {
    expect(() => create({ OFFER_EXPIRATION_INTERVAL_MINUTES: '0' })).toThrow(
      'OFFER_EXPIRATION_INTERVAL_MINUTES',
    );
  });
});

describe('OffersService.expireOffersOfOrder (T6.5.1)', () => {
  let order: { status: string; expired: boolean } | null;
  let due: { id: string; round: number }[];
  let tx: {
    $queryRaw: Fn;
    offer: { updateMany: Fn; count: Fn };
    offerEvent: { createMany: Fn };
  };
  let orders: { transition: Fn };
  let service: OffersService;

  beforeEach(() => {
    order = { status: 'EN_NEGOCIACION', expired: false };
    due = [
      { id: 'o1', round: 1 },
      { id: 'o2', round: 3 },
    ];
    tx = {
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM "orders"')) {
          return Promise.resolve(
            order ? [{ clientId: 'c', assignedWorkerId: null, ...order }] : [],
          );
        }
        if (sql.includes('FROM "offers"')) {
          return Promise.resolve(due);
        }
        return Promise.resolve([{ now: NOW }]);
      }),
      offer: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        count: vi.fn().mockResolvedValue(0),
      },
      offerEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    orders = { transition: vi.fn().mockResolvedValue({}) };
    service = new OffersService(
      {
        $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
      } as unknown as PrismaService,
      {} as never,
      orders as unknown as OrdersService,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('cierra como VENCIDA con evento del sistema y, sin vigentes, devuelve el pedido a PUBLICADO', async () => {
    await expect(service.expireOffersOfOrder('p1')).resolves.toBe(2);

    const lockSql = (tx.$queryRaw.mock.calls[1][0] as string[]).join('?');
    expect(lockSql).toContain('"expires_at" <= now()');
    expect(lockSql).toContain('FOR UPDATE');
    expect(tx.offer.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['o1', 'o2'] }, status: 'VIGENTE' },
      data: { status: 'VENCIDA', closedAt: NOW },
    });
    expect(tx.offerEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          offerId: 'o1',
          orderId: 'p1',
          type: 'VENCIDA',
          round: 1,
          actorType: 'SISTEMA',
          systemProcess: 'VENCIMIENTO_OFERTA',
        },
        {
          offerId: 'o2',
          orderId: 'p1',
          type: 'VENCIDA',
          round: 3,
          actorType: 'SISTEMA',
          systemProcess: 'VENCIMIENTO_OFERTA',
        },
      ],
    });
    expect(orders.transition).toHaveBeenCalledWith(tx, {
      orderId: 'p1',
      from: 'EN_NEGOCIACION',
      to: 'PUBLICADO',
      actor: { type: 'SISTEMA', process: 'VENCIMIENTO_OFERTA' },
    });
  });

  it('con otras ofertas vigentes el pedido sigue EN_NEGOCIACION', async () => {
    tx.offer.count.mockResolvedValue(1);

    await service.expireOffersOfOrder('p1');
    expect(orders.transition).not.toHaveBeenCalled();
  });

  it('sin ofertas por vencer no escribe nada (idempotente)', async () => {
    due = [];

    await expect(service.expireOffersOfOrder('p1')).resolves.toBe(0);
    expect(tx.offer.updateMany).not.toHaveBeenCalled();
    expect(tx.offerEvent.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['vencido', { status: 'EN_NEGOCIACION', expired: true }],
    ['cancelado', { status: 'CANCELADO', expired: false }],
  ])(
    'en un pedido %s cierra las ofertas pero no cambia su estado',
    async (_case, state) => {
      order = state;

      await expect(service.expireOffersOfOrder('p1')).resolves.toBe(2);
      expect(tx.offer.updateMany).toHaveBeenCalled();
      expect(orders.transition).not.toHaveBeenCalled();
    },
  );
});
