import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { OfferStatus, Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OrderVisibilityService } from '../orders/order-visibility.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { CreateOfferDto } from './dto/create-offer.dto.js';
import { effectiveOfferStatus, offerStatusWhere } from './offer-views.js';
import { OffersService } from './offers.service.js';

type Fn = ReturnType<typeof vi.fn>;

const NOW = new Date('2026-11-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const offerRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'oferta-1',
  orderId: 'pedido-1',
  workerId: 'trabajador-1',
  status: OfferStatus.VIGENTE,
  round: 1,
  amount: new Prisma.Decimal('150'),
  turn: 'CLIENTE',
  requiresVisit: true,
  visitCost: new Prisma.Decimal('0'),
  materialsIncluded: false,
  proposedStartAt: new Date(NOW.getTime() + 48 * HOUR),
  estimatedDurationMinutes: 120,
  expiresAt: new Date(NOW.getTime() + 24 * HOUR),
  closedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  events: [],
  ...overrides,
});

describe('OffersService (T6.2)', () => {
  let tx: {
    $queryRaw: Fn;
    offer: { findMany: Fn; create: Fn; update: Fn };
    offerEvent: { create: Fn };
    workerSchedule: { findMany: Fn };
  };
  let prisma: {
    $transaction: Fn;
    $queryRaw: Fn;
    offer: { findFirst: Fn; findMany: Fn; count: Fn };
  };
  let visibility: { assertOpenForOffers: Fn };
  let orders: { getOwn: Fn; transition: Fn };
  let service: OffersService;

  const dto = (overrides: Partial<CreateOfferDto> = {}): CreateOfferDto => ({
    amount: '150.00',
    requiresVisit: true,
    visitCost: '0',
    materialsIncluded: false,
    proposedStartAt: new Date(NOW.getTime() + 48 * HOUR).toISOString(),
    estimatedDurationMinutes: 120,
    ...overrides,
  });

  beforeEach(() => {
    tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ now: NOW }]),
      offer: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'oferta-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
      offerEvent: { create: vi.fn().mockResolvedValue({}) },
      workerSchedule: { findMany: vi.fn().mockResolvedValue([]) },
    };
    prisma = {
      $transaction: vi.fn((work: unknown) =>
        typeof work === 'function'
          ? (work as (client: typeof tx) => unknown)(tx)
          : Promise.all(work as Promise<unknown>[]),
      ),
      $queryRaw: vi.fn().mockResolvedValue([{ now: NOW }]),
      offer: {
        findFirst: vi.fn().mockResolvedValue(offerRow()),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    visibility = {
      assertOpenForOffers: vi.fn().mockResolvedValue({
        worker: { userId: 'trabajador-1' },
        order: { status: 'PUBLICADO', revision: 1 },
      }),
    };
    orders = {
      getOwn: vi.fn().mockResolvedValue({}),
      transition: vi.fn().mockResolvedValue({}),
    };
    service = new OffersService(
      prisma as unknown as PrismaService,
      visibility as unknown as OrderVisibilityService,
      orders as unknown as OrdersService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  describe('create', () => {
    it('valida el pedido bajo bloqueo y crea la oferta VIGENTE con su PROPUESTA', async () => {
      const detail = await service.create('trabajador-1', 'pedido-1', dto());

      expect(visibility.assertOpenForOffers).toHaveBeenCalledWith(
        tx,
        'trabajador-1',
        'pedido-1',
      );
      expect(tx.offer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'pedido-1',
          workerId: 'trabajador-1',
          amount: '150.00',
          visitCost: '0',
          // 24 horas con el reloj de la BD.
          expiresAt: new Date(NOW.getTime() + 24 * HOUR),
        }),
        select: { id: true },
      });
      expect(tx.offerEvent.create).toHaveBeenCalledWith({
        data: {
          offerId: 'oferta-1',
          orderId: 'pedido-1',
          type: 'PROPUESTA',
          round: 1,
          amount: '150.00',
          actorType: 'USUARIO',
          changedById: 'trabajador-1',
          actorRole: 'TRABAJADOR',
        },
      });
      // La validacion va antes de escribir.
      expect(
        visibility.assertOpenForOffers.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.offer.create.mock.invocationCallOrder[0]);
      expect(detail).toMatchObject({ status: 'VIGENTE', round: 1 });
    });

    it('no depende del horario de atencion: oferta a cualquier hora (aclaracion del docente)', async () => {
      // Domingo 03:00 en La Paz (07:00 UTC) y sin horarios cargados.
      const detail = await service.create(
        'trabajador-1',
        'pedido-1',
        dto({ proposedStartAt: '2026-11-29T07:00:00.000Z' }),
      );

      expect(tx.workerSchedule.findMany).not.toHaveBeenCalled();
      expect(tx.offer.create).toHaveBeenCalled();
      expect(detail.status).toBe('VIGENTE');
    });

    it('la primera oferta pasa el pedido a EN_NEGOCIACION por OrdersService.transition (T6.4.1)', async () => {
      await service.create('trabajador-1', 'pedido-1', dto());

      expect(orders.transition).toHaveBeenCalledWith(tx, {
        orderId: 'pedido-1',
        from: 'PUBLICADO',
        to: 'EN_NEGOCIACION',
        actor: { type: 'USUARIO', userId: 'trabajador-1', role: 'TRABAJADOR' },
      });
      expect(tx.offer.create.mock.invocationCallOrder[0]).toBeLessThan(
        orders.transition.mock.invocationCallOrder[0],
      );
    });

    it('con el pedido ya EN_NEGOCIACION no vuelve a cambiar su estado', async () => {
      visibility.assertOpenForOffers.mockResolvedValue({
        worker: { userId: 'trabajador-1' },
        order: { status: 'EN_NEGOCIACION', revision: 1 },
      });

      await service.create('trabajador-1', 'pedido-1', dto());

      expect(orders.transition).not.toHaveBeenCalled();
    });

    it('si el pedido no esta disponible para el trabajador no escribe nada', async () => {
      visibility.assertOpenForOffers.mockRejectedValue(
        new NotFoundException('Pedido no encontrado'),
      );

      await expect(
        service.create('trabajador-1', 'pedido-1', dto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.offer.create).not.toHaveBeenCalled();
      expect(tx.offerEvent.create).not.toHaveBeenCalled();
    });

    it.each([
      [{ requiresVisit: true, visitCost: undefined }, 'obligatorio'],
      [{ requiresVisit: false, visitCost: '10' }, 'solo se indica'],
    ])(
      'rechaza un costo de visita incoherente (%o)',
      async (overrides, msg) => {
        await expect(
          service.create('trabajador-1', 'pedido-1', dto(overrides)),
        ).rejects.toThrow(msg);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('sin visita guarda visitCost null', async () => {
      await service.create(
        'trabajador-1',
        'pedido-1',
        dto({ requiresVisit: false, visitCost: undefined }),
      );
      expect(tx.offer.create.mock.calls[0][0].data.visitCost).toBeNull();
    });

    it('rechaza una disponibilidad que no es futura segun el reloj de la BD', async () => {
      await expect(
        service.create(
          'trabajador-1',
          'pedido-1',
          dto({ proposedStartAt: NOW.toISOString() }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.offer.create).not.toHaveBeenCalled();
    });

    it('una oferta VIGENTE sin vencer es un duplicado (409)', async () => {
      tx.offer.findMany.mockResolvedValue([offerRow()]);

      await expect(
        service.create('trabajador-1', 'pedido-1', dto()),
      ).rejects.toThrow('Ya tiene una oferta vigente');
      expect(tx.offer.create).not.toHaveBeenCalled();
    });

    it.each([
      OfferStatus.RETIRADA,
      OfferStatus.RECHAZADA,
      OfferStatus.ACEPTADA,
      OfferStatus.SIN_EFECTO,
    ])('una oferta anterior %s impide volver a ofertar', async (status) => {
      tx.offer.findMany.mockResolvedValue([offerRow({ status })]);

      await expect(
        service.create('trabajador-1', 'pedido-1', dto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.offer.create).not.toHaveBeenCalled();
    });

    it('despues de una VENCIDA puede volver a ofertar', async () => {
      tx.offer.findMany.mockResolvedValue([
        offerRow({ status: OfferStatus.VENCIDA }),
      ]);

      await service.create('trabajador-1', 'pedido-1', dto());
      expect(tx.offer.update).not.toHaveBeenCalled();
      expect(tx.offer.create).toHaveBeenCalled();
    });

    it('una VIGENTE ya vencida se cierra como VENCIDA, con su evento, antes de la nueva', async () => {
      tx.offer.findMany.mockResolvedValue([
        offerRow({ id: 'vieja', round: 2, expiresAt: NOW }),
      ]);

      await service.create('trabajador-1', 'pedido-1', dto());

      expect(tx.offer.update).toHaveBeenCalledWith({
        where: { id: 'vieja' },
        data: { status: 'VENCIDA', closedAt: NOW },
      });
      expect(tx.offerEvent.create.mock.calls[0][0].data).toEqual({
        offerId: 'vieja',
        orderId: 'pedido-1',
        type: 'VENCIDA',
        round: 2,
        actorType: 'SISTEMA',
        systemProcess: 'VENCIMIENTO_OFERTA',
      });
      expect(tx.offer.update.mock.invocationCallOrder[0]).toBeLessThan(
        tx.offer.create.mock.invocationCallOrder[0],
      );
    });

    it('traduce la violacion del indice unico a 409', async () => {
      tx.offer.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicado', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.create('trabajador-1', 'pedido-1', dto()),
      ).rejects.toThrow('Ya tiene una oferta vigente');
    });
  });

  describe('consultas', () => {
    it('el trabajador solo encuentra sus ofertas (404 si es ajena)', async () => {
      prisma.offer.findFirst.mockResolvedValue(null);

      await expect(
        service.getOwn('trabajador-1', 'oferta-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.offer.findFirst.mock.calls[0][0].where).toEqual({
        id: 'oferta-1',
        workerId: 'trabajador-1',
      });
    });

    it('el cliente solo ve ofertas de sus pedidos; con orderId, OrdersModule valida al dueno', async () => {
      await service.listReceived('cliente-1', {
        orderId: 'pedido-1',
        page: 1,
        limit: 20,
      });

      expect(orders.getOwn).toHaveBeenCalledWith('cliente-1', 'pedido-1');
      expect(prisma.offer.findMany.mock.calls[0][0].where).toEqual({
        AND: [
          { order: { clientId: 'cliente-1' } },
          { orderId: 'pedido-1' },
          {},
        ],
      });
    });

    it('el detalle recibido no incluye direccion ni contacto del trabajador', async () => {
      prisma.offer.findFirst.mockResolvedValue(
        offerRow({
          worker: { id: 'trabajador-1', firstName: 'Ana', lastName: 'Rojas' },
        }),
      );

      const detail = await service.getReceived('cliente-1', 'oferta-1');

      expect(detail.worker).toEqual({
        id: 'trabajador-1',
        firstName: 'Ana',
        lastName: 'Rojas',
      });
      expect(JSON.stringify(detail)).not.toMatch(/address|email|phone/i);
    });
  });

  describe('estado efectivo', () => {
    it('una VIGENTE con la vigencia cumplida es VENCIDA', () => {
      expect(
        effectiveOfferStatus({ status: 'VIGENTE', expiresAt: NOW }, NOW),
      ).toBe('VENCIDA');
      expect(
        effectiveOfferStatus(
          { status: 'VIGENTE', expiresAt: new Date(NOW.getTime() + 1) },
          NOW,
        ),
      ).toBe('VIGENTE');
    });

    it('el filtro por estado sigue al estado efectivo', () => {
      expect(offerStatusWhere('VIGENTE', NOW)).toEqual({
        status: 'VIGENTE',
        expiresAt: { gt: NOW },
      });
      expect(offerStatusWhere('VENCIDA', NOW)).toEqual({
        OR: [
          { status: 'VENCIDA' },
          { status: 'VIGENTE', expiresAt: { lte: NOW } },
        ],
      });
    });
  });
});
