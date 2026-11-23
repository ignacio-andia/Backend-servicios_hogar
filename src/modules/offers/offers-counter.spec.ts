import { ConflictException, NotFoundException } from '@nestjs/common';
import { OfferStatus, Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CatalogsService } from '../catalogs/catalogs.service.js';
import type { OrderVisibilityService } from '../orders/order-visibility.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { UsersService } from '../users/users.service.js';
import type { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import { assertCanCounter, LockedOffer } from './offer-negotiation.js';
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

describe('assertCanCounter (T6.3)', () => {
  it('permite responder a quien tiene el turno mientras quede ronda', () => {
    expect(() => assertCanCounter(locked(), 'CLIENTE', NOW)).not.toThrow();
    expect(() =>
      assertCanCounter(
        locked({ round: 2, turn: 'TRABAJADOR' }),
        'TRABAJADOR',
        NOW,
      ),
    ).not.toThrow();
  });

  it.each([
    ['turno incorrecto', locked(), 'TRABAJADOR', 'cliente'],
    ['ronda 3 alcanzada', locked({ round: 3 }), 'CLIENTE', 'máximo de 3'],
    ['oferta vencida', locked({ expiresAt: NOW }), 'CLIENTE', 'venció'],
    [
      'oferta cerrada',
      locked({ status: OfferStatus.RETIRADA }),
      'CLIENTE',
      'cerrada',
    ],
  ] as const)('rechaza: %s (409)', (_case, offer, party, message) => {
    expect(() => assertCanCounter(offer, party, NOW)).toThrow(
      ConflictException,
    );
    expect(() => assertCanCounter(offer, party, NOW)).toThrow(message);
  });
});

describe('OffersService.counter (T6.3)', () => {
  let order: Record<string, unknown> | null;
  let lockedOffer: LockedOffer | null;
  let calls: string[];
  let tx: {
    $queryRaw: Fn;
    offer: { update: Fn };
    offerEvent: { create: Fn };
    order: { findUniqueOrThrow: Fn };
  };
  let prisma: {
    $transaction: Fn;
    $queryRaw: Fn;
    offer: { findUnique: Fn; findFirst: Fn };
  };
  let users: { findByIdForShare: Fn };
  let workerProfiles: { lockApprovedWorker: Fn };
  let catalogs: { findByIdsForShare: Fn };
  let service: OffersService;

  beforeEach(() => {
    calls = [];
    order = {
      status: 'PUBLICADO',
      effectiveStatus: 'PUBLICADO',
      clientId: 'cliente-1',
      assignedWorkerId: null,
    };
    lockedOffer = locked();
    tx = {
      // lockOrder, lockOffer y now(), en ese orden.
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM "orders"')) {
          calls.push('pedido');
          return Promise.resolve(
            order
              ? [
                  {
                    ...order,
                    // lockOrder deriva el estado efectivo de status y expired.
                    status:
                      order.effectiveStatus === 'VENCIDO'
                        ? 'PUBLICADO'
                        : order.effectiveStatus,
                    expired: order.effectiveStatus === 'VENCIDO',
                  },
                ]
              : [],
          );
        }
        if (sql.includes('FROM "offers"')) {
          calls.push('oferta');
          return Promise.resolve(lockedOffer ? [lockedOffer] : []);
        }
        return Promise.resolve([{ now: NOW }]);
      }),
      offer: { update: vi.fn().mockResolvedValue({}) },
      offerEvent: { create: vi.fn().mockResolvedValue({}) },
      order: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ zoneId: 'zona-1', categoryId: 'cat-1' }),
      },
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
          status: 'VIGENTE',
          round: 2,
          amount: new Prisma.Decimal('90'),
          turn: 'TRABAJADOR',
          requiresVisit: false,
          visitCost: null,
          materialsIncluded: true,
          proposedStartAt: NOW,
          estimatedDurationMinutes: 60,
          expiresAt: new Date(NOW.getTime() + 24 * HOUR),
          closedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
          worker: { id: 'trabajador-1', firstName: 'Ana', lastName: 'Rojas' },
          events: [],
        }),
      },
    };
    users = {
      findByIdForShare: vi.fn(() => {
        calls.push('cuenta');
        return Promise.resolve({ status: 'ACTIVO' });
      }),
    };
    workerProfiles = {
      lockApprovedWorker: vi.fn(() => {
        calls.push('trabajador');
        return Promise.resolve({});
      }),
    };
    catalogs = {
      findByIdsForShare: vi.fn((_tx: unknown, kind: string) => {
        calls.push(kind);
        return Promise.resolve([{ isActive: true }]);
      }),
    };
    service = new OffersService(
      prisma as unknown as PrismaService,
      {} as OrderVisibilityService,
      {} as OrdersService,
      users as unknown as UsersService,
      workerProfiles as unknown as WorkerProfileService,
      catalogs as unknown as CatalogsService,
    );
  });

  it('el cliente contraoferta: ronda 2, turno al trabajador, 24 horas y evento CONTRAOFERTA', async () => {
    await service.counter('cliente-1', 'oferta-1', { amount: '90.00' });

    expect(tx.offer.update).toHaveBeenCalledWith({
      where: { id: 'oferta-1' },
      data: {
        round: 2,
        amount: '90.00',
        turn: 'TRABAJADOR',
        expiresAt: new Date(NOW.getTime() + 24 * HOUR),
      },
    });
    expect(tx.offerEvent.create).toHaveBeenCalledWith({
      data: {
        offerId: 'oferta-1',
        orderId: 'pedido-1',
        type: 'CONTRAOFERTA',
        round: 2,
        amount: '90.00',
        actorType: 'USUARIO',
        changedById: 'cliente-1',
        actorRole: 'CLIENTE',
      },
    });
    // Solo cambia monto, ronda, turno y vigencia: nunca las condiciones.
    expect(Object.keys(tx.offer.update.mock.calls[0][0].data).sort()).toEqual([
      'amount',
      'expiresAt',
      'round',
      'turn',
    ]);
  });

  it('respeta el orden de bloqueos: cuenta, trabajador, pedido, oferta y catalogos', async () => {
    await service.counter('cliente-1', 'oferta-1', { amount: '90.00' });

    expect(calls).toEqual([
      'cuenta',
      'trabajador',
      'pedido',
      'oferta',
      'ZONE',
      'CATEGORY',
    ]);
  });

  it('el trabajador contraoferta en su turno con su rol', async () => {
    lockedOffer = locked({ round: 2, turn: 'TRABAJADOR' });

    await service.counter('trabajador-1', 'oferta-1', { amount: '95.00' });

    expect(tx.offer.update.mock.calls[0][0].data).toMatchObject({
      round: 3,
      turn: 'CLIENTE',
    });
    expect(tx.offerEvent.create.mock.calls[0][0].data).toMatchObject({
      round: 3,
      changedById: 'trabajador-1',
      actorRole: 'TRABAJADOR',
    });
  });

  it('quien no participa recibe 404 sin abrir la transaccion', async () => {
    await expect(
      service.counter('otro', 'oferta-1', { amount: '90.00' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'pedido vencido',
      () => (order!.effectiveStatus = 'VENCIDO'),
      'ya no admite',
    ],
    [
      'pedido cancelado',
      () => (order!.effectiveStatus = 'CANCELADO'),
      'ya no admite',
    ],
    [
      'zona inactiva',
      () =>
        catalogs.findByIdsForShare.mockResolvedValueOnce([{ isActive: false }]),
      'zona',
    ],
    [
      'categoria inactiva',
      () =>
        catalogs.findByIdsForShare
          .mockResolvedValueOnce([{ isActive: true }])
          .mockResolvedValueOnce([{ isActive: false }]),
      'categoría',
    ],
    [
      'cliente suspendido',
      () => users.findByIdForShare.mockResolvedValue({ status: 'SUSPENDIDO' }),
      'cliente',
    ],
  ])('%s: 409 y no escribe nada', async (_case, arrange, message) => {
    arrange();

    await expect(
      service.counter('cliente-1', 'oferta-1', { amount: '90.00' }),
    ).rejects.toThrow(message);
    expect(tx.offer.update).not.toHaveBeenCalled();
    expect(tx.offerEvent.create).not.toHaveBeenCalled();
  });

  it('un trabajador que ya no esta aprobado invalida la oferta', async () => {
    workerProfiles.lockApprovedWorker.mockRejectedValue(
      new ConflictException('no aprobado'),
    );

    await expect(
      service.counter('cliente-1', 'oferta-1', { amount: '90.00' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.offer.update).not.toHaveBeenCalled();
  });

  it('traduce la violacion del indice de rondas a 409', async () => {
    tx.offerEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicado', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.counter('cliente-1', 'oferta-1', { amount: '90.00' }),
    ).rejects.toThrow('La oferta cambió');
  });
});
