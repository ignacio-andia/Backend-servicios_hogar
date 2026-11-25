import { Prisma } from '../../generated/prisma/client.js';
import {
  OfferEventType,
  OrderActorType,
  OrderStatus,
  RoleName,
} from '../../generated/prisma/enums.js';
import type { OffersService } from '../offers/offers.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { PaymentsService } from '../payments/payments.service.js';
import type { WorkflowQueryService } from '../service-workflow/workflow-query.service.js';
import { TimelineSourceRegistry } from './timeline-source.registry.js';
import {
  ClaimsTimelineSource,
  OffersTimelineSource,
  OrdersTimelineSource,
  PaymentsTimelineSource,
  TimelineSourcesIntegration,
  WorkflowTimelineSource,
} from './timeline.sources.js';
import type { TimelineContext } from './timeline.types.js';

const db = {} as Prisma.TransactionClient;
const D = (iso: string) => new Date(iso);
const context = (viewerId: string, isAdmin = false): TimelineContext => ({
  orderId: 'o1',
  clientId: 'c1',
  workerId: 'w1',
  viewer: { userId: viewerId, isAdmin },
});

const history = (
  id: string,
  from: OrderStatus | null,
  to: OrderStatus,
  iso: string,
) => ({
  id,
  fromStatus: from,
  toStatus: to,
  actorType: OrderActorType.USUARIO,
  changedById: 'c1',
  actorRole: RoleName.CLIENTE,
  systemProcess: null,
  reason: null,
  createdAt: D(iso),
});

describe('lectores de la linea de tiempo (RF-32)', () => {
  const orders = {
    listStatusHistory: vi.fn(),
  } as unknown as OrdersService & {
    listStatusHistory: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orders.listStatusHistory.mockResolvedValue([
      history('h1', null, OrderStatus.PUBLICADO, '2026-11-24T10:00:00Z'),
      history(
        'h2',
        OrderStatus.PUBLICADO,
        OrderStatus.EN_NEGOCIACION,
        '2026-11-24T11:00:00Z',
      ),
      history(
        'h3',
        OrderStatus.EN_NEGOCIACION,
        OrderStatus.PUBLICADO,
        '2026-11-24T12:00:00Z',
      ),
      history(
        'h4',
        OrderStatus.TERMINADO,
        OrderStatus.EN_RECLAMO,
        '2026-11-25T10:00:00Z',
      ),
      history(
        'h5',
        OrderStatus.EN_RECLAMO,
        OrderStatus.CERRADO,
        '2026-11-26T10:00:00Z',
      ),
    ]);
  });

  it('Orders y Claims se reparten el historial: ningun evento se repite ni se pierde', async () => {
    const fromOrders = await new OrdersTimelineSource(orders).listEvents(
      db,
      context('c1'),
    );
    const fromClaims = await new ClaimsTimelineSource(orders).listEvents(
      db,
      context('c1'),
    );
    expect(fromOrders.map((e) => e.id)).toEqual(['h1', 'h2', 'h3']);
    expect(fromClaims.map((e) => e.id)).toEqual(['h4', 'h5']);
    expect(fromOrders.map((e) => e.summary)).toEqual([
      'Pedido publicado',
      'Negociación iniciada',
      'Pedido nuevamente publicado',
    ]);
    expect(fromClaims.map((e) => e.type)).toEqual([
      'RECLAMO_PRESENTADO',
      'RECLAMO_RESUELTO',
    ]);
  });

  it('un evento de sistema conserva el proceso como autor', async () => {
    orders.listStatusHistory.mockResolvedValue([
      {
        ...history('h1', null, OrderStatus.VENCIDO, '2026-11-24T10:00:00Z'),
        actorType: OrderActorType.SISTEMA,
        changedById: null,
        actorRole: null,
        systemProcess: 'VENCIMIENTO',
      },
    ]);
    const [event] = await new OrdersTimelineSource(orders).listEvents(
      db,
      context('c1'),
    );
    expect(event.actor).toEqual({ type: 'SISTEMA', process: 'VENCIMIENTO' });
  });

  describe('Offers: cada espectador ve solo lo que le corresponde', () => {
    const event = (id: string, workerId: string, type: OfferEventType) => ({
      id,
      offerId: `offer-${workerId}`,
      type,
      round: 1,
      amount: new Prisma.Decimal('100'),
      actorType: OrderActorType.USUARIO,
      changedById: workerId,
      actorRole: RoleName.TRABAJADOR,
      systemProcess: null,
      createdAt: D('2026-11-24T11:00:00Z'),
      workerId,
      clientId: 'c1',
    });
    const offers = {
      listNegotiationEvents: vi.fn(),
      getAcceptedOfferTerms: vi.fn(),
    } as unknown as OffersService & {
      listNegotiationEvents: ReturnType<typeof vi.fn>;
      getAcceptedOfferTerms: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      offers.listNegotiationEvents.mockResolvedValue([
        event('e1', 'w1', OfferEventType.PROPUESTA),
        event('e2', 'w2', OfferEventType.PROPUESTA),
      ]);
      offers.getAcceptedOfferTerms.mockResolvedValue(null);
    });

    it('el cliente y el administrador ven todas las ofertas', async () => {
      const source = new OffersTimelineSource(offers);
      expect(await source.listEvents(db, context('c1'))).toHaveLength(2);
      expect(await source.listEvents(db, context('admin', true))).toHaveLength(
        2,
      );
    });

    it('el trabajador asignado solo ve las suyas', async () => {
      const events = await new OffersTimelineSource(offers).listEvents(
        db,
        context('w1'),
      );
      expect(events.map((e) => e.details?.workerId)).toEqual(['w1']);
      expect(JSON.stringify(events)).not.toContain('w2');
    });

    it('al acordar incluye el monto acordado y el costo de la visita', async () => {
      offers.listNegotiationEvents.mockResolvedValue([
        {
          ...event('e3', 'w1', OfferEventType.ACEPTADA),
          amount: null,
          actorRole: RoleName.CLIENTE,
          changedById: 'c1',
        },
      ]);
      offers.getAcceptedOfferTerms.mockResolvedValue({
        offerId: 'offer-w1',
        workerId: 'w1',
        amount: new Prisma.Decimal('120.5'),
        requiresVisit: true,
        visitCost: new Prisma.Decimal('30'),
        proposedStartAt: D('2026-12-07T14:00:00Z'),
        estimatedDurationMinutes: 30,
      });
      const [accepted] = await new OffersTimelineSource(offers).listEvents(
        db,
        context('c1'),
      );
      expect(accepted.details).toMatchObject({
        agreedAmount: '120.50',
        requiresVisit: true,
        visitCost: '30.00',
      });
    });
  });

  it('Workflow: aporta solo detalles que el historial no tiene', async () => {
    const workflow = {
      getVisit: vi.fn().mockResolvedValue({
        orderId: 'o1',
        performedAt: D('2026-11-25T10:00:00Z'),
        visitCost: '30.00',
      }),
      listAdditionalBudgets: vi.fn().mockResolvedValue([
        {
          id: 'b1',
          orderId: 'o1',
          amount: '50.00',
          reason: 'Cambio de tuberia',
          materials: 'Tubo',
          status: 'ACEPTADO',
          respondedAt: D('2026-11-25T12:00:00Z'),
          createdAt: D('2026-11-25T11:00:00Z'),
        },
        {
          id: 'b2',
          orderId: 'o1',
          amount: '10.00',
          reason: 'x',
          materials: 'y',
          status: 'PENDIENTE',
          respondedAt: null,
          createdAt: D('2026-11-25T13:00:00Z'),
        },
      ]),
      getExecution: vi.fn().mockResolvedValue({
        orderId: 'o1',
        startedAt: D('2026-11-26T10:00:00Z'),
        finishedAt: D('2026-11-26T12:00:00Z'),
        conformityDeadline: D('2026-12-03T12:00:00Z'),
        conformedAt: D('2026-11-27T12:00:00Z'),
      }),
      getNoShowReport: vi.fn().mockResolvedValue(null),
    } as unknown as WorkflowQueryService;
    const events = await new WorkflowTimelineSource(workflow).listEvents(
      db,
      context('c1'),
    );
    expect(events.map((e) => e.type)).toEqual([
      'VISITA_COSTO',
      'ADICIONAL_PROPUESTO',
      'ADICIONAL_ACEPTADO',
      'ADICIONAL_PROPUESTO',
      'PLAZO_CONFORMIDAD',
      'CONFORMIDAD_CONFIRMADA',
    ]);
    expect(events[0].summary).toContain('Bs 30.00');
    expect(events.every((e) => e.source === 'workflow')).toBe(true);
  });

  it('Payments: constancia del servicio y una entrada por declaracion', async () => {
    const payments = {
      listTimelineFacts: vi.fn().mockResolvedValue({
        receipt: {
          id: 'r1',
          agreedAmount: new Prisma.Decimal('120.5'),
          createdAt: D('2026-11-24T13:00:00Z'),
        },
        declarations: [
          {
            id: 'd1',
            concept: 'ANTICIPO',
            declaredBy: 'CLIENTE',
            userId: 'c1',
            method: 'QR',
            amount: new Prisma.Decimal('30.13'),
            createdAt: D('2026-11-24T14:00:00Z'),
          },
        ],
      }),
    } as unknown as PaymentsService;
    const events = await new PaymentsTimelineSource(payments).listEvents(
      db,
      context('c1'),
    );
    expect(events.map((e) => e.type)).toEqual([
      'CONSTANCIA_SERVICIO',
      'PAGO_ANTICIPO_CLIENTE',
    ]);
    expect(events[1].actor).toEqual({
      type: 'USUARIO',
      userId: 'c1',
      role: RoleName.CLIENTE,
    });
    expect(events[1].details).toMatchObject({ method: 'QR', amount: '30.13' });
  });

  it('TimelineSourcesIntegration registra las cinco fuentes acordadas y ninguna otra', () => {
    const registry = new TimelineSourceRegistry();
    const make = (name: string) => ({
      name,
      listEvents: () => Promise.resolve([]),
    });
    new TimelineSourcesIntegration(
      registry,
      make('orders') as never,
      make('claims') as never,
      make('offers') as never,
      make('workflow') as never,
      make('payments') as never,
    ).onModuleInit();
    expect(registry.list().map((s) => s.name)).toEqual([
      'orders',
      'claims',
      'offers',
      'workflow',
      'payments',
    ]);
  });
});
