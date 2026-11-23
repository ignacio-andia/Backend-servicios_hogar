import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OfferStatus, Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import { assertCanClose, LockedOffer } from './offer-negotiation.js';
import { OffersService } from './offers.service.js';

type Fn = ReturnType<typeof vi.fn>;

const NOW = new Date('2026-11-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const locked = (overrides: Partial<LockedOffer> = {}): LockedOffer => ({
  status: OfferStatus.VIGENTE,
  round: 1,
  turn: 'CLIENTE',
  expiresAt: new Date(NOW.getTime() + HOUR),
  ...overrides,
});

describe('assertCanClose (T6.4.1)', () => {
  it('el cliente rechaza en su turno; el trabajador retira en cualquier turno', () => {
    expect(() => assertCanClose(locked(), 'CLIENTE', NOW)).not.toThrow();
    expect(() =>
      assertCanClose(locked({ turn: 'TRABAJADOR' }), 'TRABAJADOR', NOW),
    ).not.toThrow();
    expect(() => assertCanClose(locked(), 'TRABAJADOR', NOW)).not.toThrow();
  });

  it.each([
    [
      'turno del trabajador',
      locked({ turn: 'TRABAJADOR' }),
      'CLIENTE',
      'trabajador',
    ],
    ['oferta vencida', locked({ expiresAt: NOW }), 'TRABAJADOR', 'venció'],
    [
      'oferta cerrada',
      locked({ status: OfferStatus.RECHAZADA }),
      'CLIENTE',
      'cerrada',
    ],
  ] as const)('rechaza: %s (409)', (_case, offer, party, message) => {
    expect(() => assertCanClose(offer, party, NOW)).toThrow(ConflictException);
    expect(() => assertCanClose(offer, party, NOW)).toThrow(message);
  });
});

describe('OffersService: rechazo y retiro (T6.4.1)', () => {
  let orderStatus: string;
  let lockedOffer: LockedOffer;
  let calls: string[];
  let tx: {
    $queryRaw: Fn;
    offer: { update: Fn; count: Fn };
    offerEvent: { create: Fn };
  };
  let prisma: {
    $transaction: Fn;
    $queryRaw: Fn;
    offer: { findUnique: Fn; findFirst: Fn };
  };
  let orders: { transition: Fn };
  let service: OffersService;

  beforeEach(() => {
    calls = [];
    orderStatus = 'EN_NEGOCIACION';
    lockedOffer = locked({ round: 2, turn: 'CLIENTE' });
    tx = {
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM "orders"')) {
          calls.push('pedido');
          return Promise.resolve([
            {
              status: orderStatus,
              clientId: 'cliente-1',
              assignedWorkerId: null,
              expired: false,
            },
          ]);
        }
        if (sql.includes('FROM "offers"')) {
          calls.push('oferta');
          return Promise.resolve([lockedOffer]);
        }
        return Promise.resolve([{ now: NOW }]);
      }),
      offer: {
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),
      },
      offerEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma = {
      $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
      $queryRaw: vi.fn().mockResolvedValue([{ now: NOW }]),
      offer: {
        findUnique: vi.fn().mockResolvedValue({
          workerId: 'trabajador-1',
          orderId: 'pedido-1',
          order: { clientId: 'cliente-1' },
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: 'oferta-1',
          orderId: 'pedido-1',
          workerId: 'trabajador-1',
          status: 'RECHAZADA',
          round: 2,
          amount: new Prisma.Decimal('90'),
          turn: 'CLIENTE',
          requiresVisit: false,
          visitCost: null,
          materialsIncluded: true,
          proposedStartAt: NOW,
          estimatedDurationMinutes: 60,
          expiresAt: NOW,
          closedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
          worker: { id: 'trabajador-1', firstName: 'Ana', lastName: 'Rojas' },
          events: [],
        }),
      },
    };
    orders = { transition: vi.fn().mockResolvedValue({}) };
    service = new OffersService(
      prisma as unknown as PrismaService,
      {} as never,
      orders as unknown as OrdersService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('el cliente rechaza: RECHAZADA con su evento y, sin otras vigentes, el pedido vuelve a PUBLICADO', async () => {
    await service.reject('cliente-1', 'oferta-1');

    expect(tx.offer.update).toHaveBeenCalledWith({
      where: { id: 'oferta-1' },
      data: { status: 'RECHAZADA', closedAt: NOW },
    });
    expect(tx.offerEvent.create).toHaveBeenCalledWith({
      data: {
        offerId: 'oferta-1',
        orderId: 'pedido-1',
        type: 'RECHAZADA',
        round: 2,
        actorType: 'USUARIO',
        changedById: 'cliente-1',
        actorRole: 'CLIENTE',
      },
    });
    // Vigentes: VIGENTE y sin vencer (reloj de la BD).
    expect(tx.offer.count).toHaveBeenCalledWith({
      where: {
        orderId: 'pedido-1',
        status: 'VIGENTE',
        expiresAt: { gt: NOW },
      },
    });
    expect(orders.transition).toHaveBeenCalledWith(tx, {
      orderId: 'pedido-1',
      from: 'EN_NEGOCIACION',
      to: 'PUBLICADO',
      actor: { type: 'USUARIO', userId: 'cliente-1', role: 'CLIENTE' },
    });
    // Solo pedido y oferta: ni la cuenta ni el trabajador.
    expect(calls).toEqual(['pedido', 'oferta']);
  });

  it('con otras ofertas vigentes el pedido sigue EN_NEGOCIACION', async () => {
    tx.offer.count.mockResolvedValue(2);

    await service.withdraw('trabajador-1', 'oferta-1');

    expect(orders.transition).not.toHaveBeenCalled();
  });

  it('el trabajador retira en cualquier turno: RETIRADA con su evento', async () => {
    lockedOffer = locked({ turn: 'CLIENTE' });

    await service.withdraw('trabajador-1', 'oferta-1');

    expect(tx.offerEvent.create.mock.calls[0][0].data).toMatchObject({
      type: 'RETIRADA',
      round: 1,
      changedById: 'trabajador-1',
      actorRole: 'TRABAJADOR',
    });
    expect(orders.transition.mock.calls[0][1]).toMatchObject({
      to: 'PUBLICADO',
      actor: { role: 'TRABAJADOR' },
    });
  });

  it('un pedido que sigue PUBLICADO (ofertas anteriores a T6.4.1) no cambia de estado', async () => {
    orderStatus = 'PUBLICADO';

    await service.reject('cliente-1', 'oferta-1');

    expect(tx.offer.count).not.toHaveBeenCalled();
    expect(orders.transition).not.toHaveBeenCalled();
  });

  it('el trabajador no puede rechazar ni el cliente retirar (403)', async () => {
    await expect(
      service.reject('trabajador-1', 'oferta-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.withdraw('cliente-1', 'oferta-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('quien no participa recibe 404', async () => {
    await expect(service.reject('otro', 'oferta-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it.each(['VENCIDO', 'CANCELADO'])(
    'un pedido %s no admite el cierre ni cambia de estado',
    async (status) => {
      orderStatus = status === 'VENCIDO' ? 'EN_NEGOCIACION' : status;
      if (status === 'VENCIDO') {
        tx.$queryRaw.mockImplementationOnce(() =>
          Promise.resolve([
            {
              status: 'EN_NEGOCIACION',
              clientId: 'cliente-1',
              assignedWorkerId: null,
              expired: true,
            },
          ]),
        );
      }

      await expect(
        service.withdraw('trabajador-1', 'oferta-1'),
      ).rejects.toThrow('ya no admite negociación');
      expect(tx.offer.update).not.toHaveBeenCalled();
      expect(orders.transition).not.toHaveBeenCalled();
    },
  );

  it('si el cierre ya existe (indice unico) responde 409', async () => {
    tx.offerEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicado', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.withdraw('trabajador-1', 'oferta-1')).rejects.toThrow(
      'ya fue cerrada',
    );
  });
});
