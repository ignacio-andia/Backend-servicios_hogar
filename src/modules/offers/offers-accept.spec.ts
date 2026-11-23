import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OfferStatus, Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CatalogsService } from '../catalogs/catalogs.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { UsersService } from '../users/users.service.js';
import type { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import { LockedOffer, slotsOverlap } from './offer-negotiation.js';
import { OffersService } from './offers.service.js';

type Fn = ReturnType<typeof vi.fn>;

const NOW = new Date('2026-11-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const START = new Date('2026-11-30T14:00:00.000Z');

describe('slotsOverlap (RF-30)', () => {
  const slot = (offsetMinutes: number, minutes: number) => ({
    proposedStartAt: new Date(START.getTime() + offsetMinutes * 60_000),
    estimatedDurationMinutes: minutes,
  });

  it('detecta cruces reales y no los trabajos contiguos', () => {
    expect(slotsOverlap(slot(0, 120), slot(60, 60))).toBe(true);
    expect(slotsOverlap(slot(60, 30), slot(0, 120))).toBe(true);
    expect(slotsOverlap(slot(0, 120), slot(119, 10))).toBe(true);
    expect(slotsOverlap(slot(0, 120), slot(120, 60))).toBe(false);
    expect(slotsOverlap(slot(180, 60), slot(0, 120))).toBe(false);
  });
});

describe('OffersService.accept (T6.4.2)', () => {
  let order: {
    status: string;
    expired: boolean;
    assignedWorkerId: string | null;
  };
  let lockedOffer: LockedOffer;
  let calls: string[];
  let tx: {
    $queryRaw: Fn;
    offer: {
      update: Fn;
      updateMany: Fn;
      findMany: Fn;
      findUniqueOrThrow: Fn;
    };
    offerEvent: { create: Fn; createMany: Fn };
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
  let orders: { transition: Fn; findActiveAssignedOrderIds: Fn };
  let service: OffersService;

  beforeEach(() => {
    calls = [];
    order = {
      status: 'EN_NEGOCIACION',
      expired: false,
      assignedWorkerId: null,
    };
    lockedOffer = {
      status: OfferStatus.VIGENTE,
      round: 3,
      turn: 'CLIENTE',
      expiresAt: new Date(NOW.getTime() + HOUR),
    };
    tx = {
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM "orders"')) {
          calls.push('pedido');
          return Promise.resolve([{ clientId: 'cliente-1', ...order }]);
        }
        if (sql.includes('FROM "offers"')) {
          calls.push('oferta');
          return Promise.resolve([lockedOffer]);
        }
        return Promise.resolve([{ now: NOW }]);
      }),
      offer: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        // Sin trabajos activos no se consultan horarios: la unica lectura es
        // la de las demas ofertas vigentes del pedido.
        findMany: vi.fn().mockResolvedValueOnce([
          { id: 'otra-1', round: 1 },
          { id: 'otra-2', round: 2 },
        ]),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          proposedStartAt: START,
          estimatedDurationMinutes: 120,
        }),
      },
      offerEvent: {
        create: vi.fn().mockResolvedValue({}),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
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
          status: 'ACEPTADA',
          round: 3,
          amount: new Prisma.Decimal('90'),
          turn: 'CLIENTE',
          requiresVisit: false,
          visitCost: null,
          materialsIncluded: true,
          proposedStartAt: START,
          estimatedDurationMinutes: 120,
          expiresAt: NOW,
          closedAt: NOW,
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
    orders = {
      transition: vi.fn(() => {
        calls.push('transicion');
        return Promise.resolve({});
      }),
      findActiveAssignedOrderIds: vi.fn().mockResolvedValue([]),
    };
    service = new OffersService(
      prisma as unknown as PrismaService,
      {} as never,
      orders as unknown as OrdersService,
      users as unknown as UsersService,
      workerProfiles as unknown as WorkerProfileService,
      catalogs as unknown as CatalogsService,
    );
  });

  it('asigna al trabajador por OrdersService.transition, acepta la oferta y deja SIN_EFECTO las demas', async () => {
    await service.accept('cliente-1', 'oferta-1');

    expect(orders.transition).toHaveBeenCalledWith(tx, {
      orderId: 'pedido-1',
      from: 'EN_NEGOCIACION',
      to: 'ACORDADO',
      assignWorkerId: 'trabajador-1',
      actor: { type: 'USUARIO', userId: 'cliente-1', role: 'CLIENTE' },
    });
    expect(tx.offer.update).toHaveBeenCalledWith({
      where: { id: 'oferta-1' },
      data: { status: 'ACEPTADA', closedAt: NOW },
    });
    expect(tx.offerEvent.create).toHaveBeenCalledWith({
      data: {
        offerId: 'oferta-1',
        orderId: 'pedido-1',
        type: 'ACEPTADA',
        round: 3,
        actorType: 'USUARIO',
        changedById: 'cliente-1',
        actorRole: 'CLIENTE',
      },
    });
    // Solo ofertas VIGENTES de este pedido, salvo la aceptada.
    expect(tx.offer.findMany.mock.calls[0][0].where).toEqual({
      orderId: 'pedido-1',
      id: { not: 'oferta-1' },
      status: 'VIGENTE',
    });
    expect(tx.offer.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['otra-1', 'otra-2'] }, status: 'VIGENTE' },
      data: { status: 'SIN_EFECTO', closedAt: NOW },
    });
    expect(tx.offerEvent.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        offerId: 'otra-1',
        type: 'SIN_EFECTO',
        round: 1,
        actorType: 'SISTEMA',
        systemProcess: 'ACEPTACION_OFERTA',
        reason: 'El cliente aceptó otra oferta para este pedido.',
      }),
      expect.objectContaining({ offerId: 'otra-2', round: 2 }),
    ]);
  });

  it('respeta el orden de bloqueos y valida antes de asignar', async () => {
    await service.accept('cliente-1', 'oferta-1');

    expect(calls).toEqual([
      'cuenta',
      'trabajador',
      'pedido',
      'oferta',
      'ZONE',
      'CATEGORY',
      'transicion',
    ]);
    expect(
      orders.findActiveAssignedOrderIds.mock.invocationCallOrder[0],
    ).toBeLessThan(orders.transition.mock.invocationCallOrder[0]);
  });

  it('no exige la especialidad de la categoria actual (no usa la visibilidad del pedido)', async () => {
    // OrderVisibilityService no se inyecta: si se usara, la prueba fallaria.
    await expect(
      service.accept('cliente-1', 'oferta-1'),
    ).resolves.toMatchObject({ status: 'ACEPTADA' });
  });

  it('rechaza un cruce con otro trabajo activo del trabajador (RF-30)', async () => {
    orders.findActiveAssignedOrderIds.mockResolvedValue(['otro-pedido']);
    tx.offer.findMany.mockReset().mockResolvedValueOnce([
      {
        orderId: 'otro-pedido',
        proposedStartAt: new Date(START.getTime() + HOUR),
        estimatedDurationMinutes: 60,
      },
    ]);

    await expect(service.accept('cliente-1', 'oferta-1')).rejects.toThrow(
      'ya tiene un trabajo acordado en ese horario',
    );
    // Solo ofertas ACEPTADAS del trabajador en sus pedidos activos.
    expect(tx.offer.findMany.mock.calls[0][0].where).toEqual({
      workerId: 'trabajador-1',
      status: 'ACEPTADA',
      orderId: { in: ['otro-pedido'] },
    });
    expect(orders.transition).not.toHaveBeenCalled();
  });

  it('un trabajo contiguo no es un cruce', async () => {
    orders.findActiveAssignedOrderIds.mockResolvedValue(['otro-pedido']);
    tx.offer.findMany
      .mockReset()
      .mockResolvedValueOnce([
        {
          orderId: 'otro-pedido',
          proposedStartAt: new Date(START.getTime() + 2 * HOUR),
          estimatedDurationMinutes: 60,
        },
      ])
      .mockResolvedValueOnce([]);

    await service.accept('cliente-1', 'oferta-1');
    expect(orders.transition).toHaveBeenCalled();
  });

  it('solo el cliente acepta: el trabajador recibe 403 y un ajeno 404', async () => {
    await expect(
      service.accept('trabajador-1', 'oferta-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.accept('otro', 'oferta-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'turno del trabajador',
      () => (lockedOffer.turn = 'TRABAJADOR'),
      'aceptar',
    ],
    ['oferta vencida', () => (lockedOffer.expiresAt = NOW), 'venció'],
    ['oferta cerrada', () => (lockedOffer.status = 'RETIRADA'), 'cerrada'],
    ['pedido PUBLICADO', () => (order.status = 'PUBLICADO'), 'PUBLICADO'],
    ['pedido cancelado', () => (order.status = 'CANCELADO'), 'CANCELADO'],
    ['pedido vencido', () => (order.expired = true), 'VENCIDO'],
    [
      'otro trabajador asignado',
      () => (order.assignedWorkerId = 'trabajador-2'),
      'ya tiene un trabajador asignado',
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
    [
      'trabajador no aprobado',
      () =>
        workerProfiles.lockApprovedWorker.mockRejectedValue(
          new ConflictException('no habilitado'),
        ),
      'no habilitado',
    ],
  ])(
    '%s: 409 sin asignar ni cerrar ofertas',
    async (_case, arrange, message) => {
      arrange();

      await expect(service.accept('cliente-1', 'oferta-1')).rejects.toThrow(
        message,
      );
      expect(orders.transition).not.toHaveBeenCalled();
      expect(tx.offer.update).not.toHaveBeenCalled();
      expect(tx.offer.updateMany).not.toHaveBeenCalled();
    },
  );

  it('traduce las violaciones de unicidad a 409', async () => {
    tx.offer.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicado', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.accept('cliente-1', 'oferta-1')).rejects.toThrow(
      'cambiaron mientras se aceptaba',
    );
  });
});
