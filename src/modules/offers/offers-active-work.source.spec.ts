import { OfferStatus, OrderStatus } from '../../generated/prisma/enums.js';
import { OpenNegotiationRegistry } from '../orders/open-negotiation.registry.js';
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from '../worker-profile/active-work.registry.js';
import { OffersActiveWorkSource } from './offers-active-work.source.js';
import { OffersOpenNegotiationSource } from './offers-open-negotiation.source.js';

// RF-13: la fuente OFERTAS y la consulta de negociacion abierta.

const NOW = new Date('2026-11-25T12:00:00.000Z');
const WORKER = 'trabajador-1';

const openFilter = (extra: object) => ({
  where: {
    ...extra,
    status: OfferStatus.VIGENTE,
    expiresAt: { gt: NOW },
    order: {
      status: { in: [OrderStatus.PUBLICADO, OrderStatus.EN_NEGOCIACION] },
      expiresAt: { gt: NOW },
    },
  },
});

const fakeTx = (count: number) => ({
  $queryRaw: vi.fn().mockResolvedValue([{ now: NOW }]),
  offer: { count: vi.fn().mockResolvedValue(count) },
});

describe('OffersActiveWorkSource (RF-13)', () => {
  const setup = () => {
    const registry = new WorkerActiveWorkRegistry();
    const source = new OffersActiveWorkSource(registry);
    source.onModuleInit();
    return { registry, source };
  };

  it('se registra como la fuente OFERTAS al iniciar el modulo', async () => {
    const { registry } = setup();
    const tx = fakeTx(2);

    await expect(
      registry.check(WORKER, [ActiveWorkKind.OFERTAS], tx as never),
    ).resolves.toEqual({ verifiable: true, counts: { OFERTAS: 2 } });
  });

  it('no admite un segundo registro', () => {
    const { source } = setup();
    expect(() => source.onModuleInit()).toThrow(/OFERTAS/);
  });

  it('cuenta con la transaccion recibida y el reloj de la BD solo las VIGENTES sin vencer de pedidos abiertos', async () => {
    const { registry } = setup();
    const tx = fakeTx(0);

    await registry.check(WORKER, [ActiveWorkKind.OFERTAS], tx as never);

    const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('');
    expect(sql).toContain('now()');
    // Un unico estado de oferta: ACEPTADA, RECHAZADA, RETIRADA, VENCIDA y
    // SIN_EFECTO quedan fuera, igual que los pedidos cerrados o cancelados.
    expect(tx.offer.count).toHaveBeenCalledWith(
      openFilter({ workerId: WORKER }),
    );
  });
});

describe('OffersOpenNegotiationSource (RF-13)', () => {
  const setup = () => {
    const registry = new OpenNegotiationRegistry();
    new OffersOpenNegotiationSource(registry).onModuleInit();
    return registry;
  };
  const input = { orderId: 'pedido-1', workerId: WORKER };

  it.each([
    [1, true],
    [0, false],
  ])(
    'con %i ofertas abiertas en ese pedido responde %s',
    async (n, expected) => {
      const tx = fakeTx(n);
      await expect(setup().has(tx as never, input)).resolves.toBe(expected);
      expect(tx.offer.count).toHaveBeenCalledWith(openFilter(input));
    },
  );

  it('lista los pedidos con una oferta abierta del trabajador, con el mismo criterio', async () => {
    const tx = {
      ...fakeTx(0),
      offer: {
        findMany: vi.fn().mockResolvedValue([{ orderId: 'pedido-1' }]),
      },
    };

    await expect(setup().openOrderIds(tx as never, WORKER)).resolves.toEqual([
      'pedido-1',
    ]);
    expect(tx.offer.findMany).toHaveBeenCalledWith({
      ...openFilter({ workerId: WORKER }),
      select: { orderId: true },
    });
  });

  it('sin nadie registrado, ninguna asignacion cuenta como negociacion abierta', async () => {
    await expect(
      new OpenNegotiationRegistry().has({} as never, input),
    ).resolves.toBe(false);
    await expect(
      new OpenNegotiationRegistry().openOrderIds({} as never, WORKER),
    ).resolves.toEqual([]);
  });

  it('admite un solo verificador', () => {
    const registry = setup();
    expect(() =>
      registry.register({
        hasOpenNegotiation: () => Promise.resolve(true),
        findOpenOrderIds: () => Promise.resolve([]),
      }),
    ).toThrow();
  });
});
