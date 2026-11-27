//=========================================================
// NUEVO: cancellation-summary.spec.ts
// Fase B3 (cancelacion): pruebas unitarias de las reglas de la fotografia
// economica, de las comprobaciones de coherencia del servicio y del registro
// en el ciclo del pedido.
// Reglas: saldo = total actualizado - anticipo confirmado por el trabajador
// asignado; diferencias entre declaraciones no son pagos pendientes; solo
// adicionales aceptados; visita aparte; sin acuerdo, importes null.
//=========================================================
import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { OrderStatus } from '../../generated/prisma/enums.js';
import { OrderLifecycleRegistry } from '../orders/order-lifecycle.registry.js';
import { CancellationSummaryService } from './cancellation-summary.service.js';
import {
  type CancellationAgreementFacts,
  type CancellationPaymentFact,
  summaryWithAgreement,
  summaryWithoutAgreement,
} from './cancellation-summary.js';
import { PaymentsIntegration } from './payments.integration.js';

const CLIENT = 'cliente';
const WORKER = 'trabajador';
const AT = new Date('2026-11-27T12:00:00.000Z');
const money = (value: string) => new Prisma.Decimal(value);

const declaration = (
  declaredBy: 'CLIENTE' | 'TRABAJADOR',
  amount: string,
  userId = declaredBy === 'CLIENTE' ? CLIENT : WORKER,
) => ({
  id: `decl-${declaredBy}`,
  declaredBy,
  userId,
  amount: money(amount),
  method: 'EFECTIVO' as const,
  createdAt: AT,
});

const payment = (
  concept: 'ANTICIPO' | 'VISITA' | 'SALDO',
  declarations: CancellationPaymentFact['declarations'],
): CancellationPaymentFact => ({
  id: `pago-${concept}`,
  concept,
  expectedAmount: concept === 'SALDO' ? null : money('100'),
  declarations,
});

const budget = (
  id: string,
  amount: string,
  status:
    | 'ACEPTADO'
    | 'PENDIENTE'
    | 'RECHAZADO'
    | 'SIN_EFECTO_POR_CANCELACION' = 'ACEPTADO',
) => ({ id, amount, status, respondedAt: AT, createdAt: AT });

const facts = (
  changes: Partial<CancellationAgreementFacts> = {},
): CancellationAgreementFacts => ({
  offerId: 'oferta',
  workerId: WORKER,
  agreedAmount: money('400'),
  agreedAt: AT,
  agreedVisitCost: null,
  visit: null,
  additionalBudgets: [],
  payments: [],
  ...changes,
});

const totals = (data: ReturnType<typeof summaryWithAgreement>) => ({
  updated: data.updatedTotal?.toFixed(2),
  confirmed: data.confirmedAdvanceTotal?.toFixed(2),
  unconfirmed: data.unconfirmedAdvanceAmount?.toFixed(2) ?? null,
  balance: data.pendingBalance?.toFixed(2),
});

describe('Resumen economico: calculo', () => {
  it.each([
    ['sin declaraciones', [], '0.00', null, '400.00', 'SIN_DECLARACIONES'],
    [
      'solo el cliente',
      [declaration('CLIENTE', '100')],
      '0.00',
      '100.00',
      '400.00',
      'DECLARADO_SIN_CONFIRMAR',
    ],
    [
      'solo el trabajador',
      [declaration('TRABAJADOR', '100')],
      '100.00',
      null,
      '300.00',
      'CONFIRMADO',
    ],
    [
      'ambos por lo mismo (no se cuenta dos veces)',
      [declaration('CLIENTE', '100'), declaration('TRABAJADOR', '100')],
      '100.00',
      null,
      '300.00',
      'CONFIRMADO',
    ],
    [
      'el cliente declara mas: la diferencia no queda pendiente',
      [declaration('CLIENTE', '150'), declaration('TRABAJADOR', '100')],
      '100.00',
      null,
      '300.00',
      'CONFIRMADO',
    ],
    [
      'el cliente declara menos',
      [declaration('CLIENTE', '80'), declaration('TRABAJADOR', '100')],
      '100.00',
      null,
      '300.00',
      'CONFIRMADO',
    ],
    [
      'un «trabajador» que no es el asignado no confirma',
      [declaration('TRABAJADOR', '100', 'otro')],
      '0.00',
      null,
      '400.00',
      'DECLARADO_SIN_CONFIRMAR',
    ],
  ])(
    'anticipo: %s',
    (_label, declarations, confirmed, unconfirmed, balance, status) => {
      const data = summaryWithAgreement(
        facts({ payments: [payment('ANTICIPO', declarations)] }),
      );
      expect(totals(data)).toEqual({
        updated: '400.00',
        confirmed,
        unconfirmed,
        balance,
      });
      expect(data.details.advance?.status).toBe(status);
      // Se conservan todas las declaraciones originales.
      expect(data.details.advance?.declarations).toEqual(
        declarations.map((d) => ({
          ...d,
          amount: d.amount.toFixed(2),
          createdAt: AT.toISOString(),
        })),
      );
    },
  );

  it('no resta el anticipo esperado si nadie lo confirmo', () => {
    const data = summaryWithAgreement(
      facts({ payments: [payment('ANTICIPO', [])] }),
    );
    expect(data.details.advance?.expectedAmount).toBe('100.00');
    expect(totals(data).balance).toBe('400.00');
  });

  it('suma solo los adicionales aceptados y los conserva uno por uno', () => {
    const data = summaryWithAgreement(
      facts({
        additionalBudgets: [
          budget('a', '0.10'),
          budget('b', '0.20'),
          budget('pendiente', '20', 'PENDIENTE'),
          budget('rechazado', '30', 'RECHAZADO'),
          budget('sin-efecto', '40', 'SIN_EFECTO_POR_CANCELACION'),
        ],
      }),
    );
    // Decimales exactos: 0.10 + 0.20 = 0.30.
    expect(data.acceptedAdditionalTotal?.toFixed(2)).toBe('0.30');
    expect(totals(data)).toMatchObject({
      updated: '400.30',
      balance: '400.30',
    });
    expect(data.details.additionalBudgets).toEqual(
      [
        ['a', '0.10'],
        ['b', '0.20'],
      ].map(([id, amount]) => ({
        id,
        amount,
        respondedAt: AT.toISOString(),
        createdAt: AT.toISOString(),
      })),
    );
  });

  it('mantiene la visita aparte, con sus declaraciones', () => {
    const data = summaryWithAgreement(
      facts({
        agreedVisitCost: money('30'),
        visit: { performedAt: AT, visitCost: '30.00' },
        payments: [
          payment('VISITA', [declaration('TRABAJADOR', '30')]),
          payment('ANTICIPO', [declaration('TRABAJADOR', '100')]),
        ],
      }),
    );
    expect(data.visitCost?.toFixed(2)).toBe('30.00');
    // La visita confirmada ni suma al total ni resta del saldo.
    expect(totals(data)).toMatchObject({
      updated: '400.00',
      confirmed: '100.00',
      balance: '300.00',
    });
    expect(data.details.visit).toMatchObject({
      agreedCost: '30.00',
      performedAt: AT.toISOString(),
      registeredCost: '30.00',
      status: 'CONFIRMADO',
      declarations: [expect.objectContaining({ amount: '30.00' }) as unknown],
    });
  });

  it('conserva cualquier otro pago sin sumarlo', () => {
    const data = summaryWithAgreement(
      facts({
        payments: [payment('SALDO', [declaration('CLIENTE', '50')])],
      }),
    );
    expect(totals(data).balance).toBe('400.00');
    expect(data.details.otherPayments).toEqual([
      expect.objectContaining({
        concept: 'SALDO',
        status: 'DECLARADO_SIN_CONFIRMAR',
      }),
    ]);
  });

  it('sin acuerdo, todos los importes son null', () => {
    const { details, schemaVersion, ...rest } = summaryWithoutAgreement();
    expect(Object.values(rest)).toEqual(Array(9).fill(null));
    expect(details).toEqual({
      advance: null,
      additionalBudgets: [],
      visit: null,
      otherPayments: [],
    });
    expect(schemaVersion).toBe(1);
  });
});

describe('CancellationSummaryService: coherencia', () => {
  const terms = {
    offerId: 'oferta',
    workerId: WORKER,
    amount: money('400'),
    requiresVisit: false,
    visitCost: null,
  };

  function setup(
    accepted: typeof terms | null,
    assignedWorkerId: string | null,
  ) {
    const tx = {
      orderCancellationSummary: { create: vi.fn() },
      payment: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new CancellationSummaryService(
      {
        findOrderSummary: vi.fn().mockResolvedValue({ assignedWorkerId }),
      } as never,
      {
        getAcceptedOfferTerms: vi.fn().mockResolvedValue(accepted),
        listNegotiationEvents: vi.fn().mockResolvedValue([]),
      } as never,
      {
        getVisit: vi.fn().mockResolvedValue(null),
        listAdditionalBudgets: vi.fn().mockResolvedValue([]),
      } as never,
    );
    const capture = (from: OrderStatus) =>
      service.capture(tx as never, 'pedido', from);
    return { tx, capture };
  }

  it.each([
    [
      'un pedido sin acuerdo con oferta aceptada',
      OrderStatus.EN_NEGOCIACION,
      terms,
      null,
    ],
    [
      'un pedido con acuerdo sin oferta aceptada',
      OrderStatus.ACORDADO,
      null,
      WORKER,
    ],
    [
      'una oferta que no es del trabajador asignado',
      OrderStatus.EN_EJECUCION,
      terms,
      'otro',
    ],
  ])('rechaza %s sin guardar nada', async (_label, from, accepted, worker) => {
    const { tx, capture } = setup(accepted, worker);
    await expect(capture(from)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.orderCancellationSummary.create).not.toHaveBeenCalled();
  });

  it('sin acuerdo guarda importes null sin leer pagos', async () => {
    const { tx, capture } = setup(null, null);
    await capture(OrderStatus.PUBLICADO);
    expect(tx.payment.findMany).not.toHaveBeenCalled();
    expect(tx.orderCancellationSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'pedido',
        acceptedOfferId: null,
        agreedAmount: null,
        pendingBalance: null,
      }) as unknown,
    });
  });

  it('con acuerdo y sin fecha de aceptacion la deja vacia', async () => {
    const { tx, capture } = setup(terms, WORKER);
    await capture(OrderStatus.ACORDADO);
    expect(tx.orderCancellationSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        acceptedOfferId: 'oferta',
        agreedAt: null,
      }) as unknown,
    });
  });
});

describe('PaymentsIntegration: captura al cancelar', () => {
  it('captura solo en CANCELADO, con la transaccion del pedido', async () => {
    const lifecycle = new OrderLifecycleRegistry();
    const capture = vi.fn();
    const registry = { register: vi.fn() } as never;
    new PaymentsIntegration(
      {} as never,
      {} as never,
      {} as never,
      registry,
      registry,
      registry,
      lifecycle,
      { capture } as never,
    ).onModuleInit();
    const tx = {} as Prisma.TransactionClient;

    await lifecycle.runInTransaction(
      [
        { type: 'VENCIDO', orderId: 'v', fromStatus: OrderStatus.PUBLICADO },
        {
          type: 'CANCELADO',
          orderId: 'c',
          fromStatus: OrderStatus.ACORDADO,
          actor: { type: 'SISTEMA', process: 'PRUEBA' },
          reason: 'motivo',
        },
      ],
      tx,
    );

    expect(capture.mock.calls).toEqual([[tx, 'c', OrderStatus.ACORDADO]]);
  });
});
