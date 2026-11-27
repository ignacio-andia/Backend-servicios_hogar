//=========================================================
// NUEVO: cancellation-summary-views.spec.ts
// Fase B4 (cancelacion): pruebas unitarias de la respuesta del resumen y del
// saldo de un pedido cancelado.
// Reglas: la fotografia se devuelve sin recalcular; las declaraciones
// posteriores van aparte; nunca se resta un anticipo no confirmado.
//=========================================================
import { Prisma } from '../../generated/prisma/client.js';
import {
  cancelledBalance,
  type DeclarationAfterCancellation,
  toCancellationSummaryView,
} from './cancellation-summary-views.js';
import { summaryWithoutAgreement } from './cancellation-summary.js';

const AT = new Date('2026-11-27T12:00:00.000Z');
const money = (value: string) => new Prisma.Decimal(value);

const declaration = (id: string) => ({
  id,
  declaredBy: 'CLIENTE' as const,
  userId: 'cliente',
  amount: '100.00',
  method: 'QR' as const,
});

const later = (id: string): DeclarationAfterCancellation => ({
  ...declaration(id),
  concept: 'VISITA',
  createdAt: AT,
});

const payment = (ids: string[]) => ({
  paymentId: 'pago',
  expectedAmount: null,
  status: 'DECLARADO_SIN_CONFIRMAR' as const,
  declarations: ids.map((id) => ({
    ...declaration(id),
    createdAt: AT.toISOString(),
  })),
});

/** Importes que NO cumplen ninguna formula: deben devolverse tal cual. */
const stored = {
  orderId: 'pedido',
  capturedAt: AT,
  acceptedOfferId: 'oferta',
  agreedAt: AT,
  agreedAmount: money('400'),
  acceptedAdditionalTotal: money('1'),
  updatedTotal: money('2'),
  confirmedAdvanceTotal: money('3'),
  unconfirmedAdvanceAmount: null,
  pendingBalance: money('4.5'),
  visitCost: money('30'),
  details: {
    advance: payment(['anticipo']),
    additionalBudgets: [],
    visit: {
      ...payment(['visita']),
      agreedCost: '30.00',
      performedAt: null,
      registeredCost: null,
    },
    otherPayments: [{ concept: 'SALDO' as const, ...payment(['saldo']) }],
  },
  schemaVersion: 1,
};

describe('toCancellationSummaryView', () => {
  it('devuelve los importes guardados sin recalcularlos', () => {
    const view = toCancellationSummaryView(stored, []);
    expect(view.totals).toEqual({
      agreedAmount: '400.00',
      acceptedAdditionalTotal: '1.00',
      updatedTotal: '2.00',
      confirmedAdvanceTotal: '3.00',
      unconfirmedAdvanceAmount: null,
      pendingBalance: '4.50',
    });
    expect(view).toMatchObject({
      hasAgreement: true,
      agreement: { offerId: 'oferta', agreedAt: AT },
      advance: stored.details.advance,
      visit: stored.details.visit,
      otherPayments: stored.details.otherPayments,
    });
  });

  it('separa solo las declaraciones que no estan en la fotografia', () => {
    const view = toCancellationSummaryView(
      stored,
      ['anticipo', 'visita', 'saldo', 'posterior'].map(later),
    );
    expect(view.declarationsAfterCancellation).toEqual([later('posterior')]);
  });

  it('sin acuerdo no inventa importes', () => {
    const view = toCancellationSummaryView(
      {
        ...summaryWithoutAgreement(),
        orderId: 'pedido',
        capturedAt: AT,
        details: summaryWithoutAgreement().details as never,
      },
      [],
    );
    expect(view).toMatchObject({
      hasAgreement: false,
      agreement: null,
      advance: null,
      visit: null,
      additionalBudgets: [],
      declarationsAfterCancellation: [],
    });
    expect(Object.values(view.totals)).toEqual(Array(6).fill(null));
  });
});

describe('cancelledBalance', () => {
  it('usa el saldo guardado y solo el anticipo confirmado', () => {
    expect(
      cancelledBalance({
        pendingBalance: money('400'),
        confirmedAdvanceTotal: money('0'),
        acceptedAdditionalTotal: money('0'),
      }),
    ).toMatchObject({
      status: 'CALCULADO',
      amount: '400.00',
      advanceAmount: '0.00',
      additionalBudgetsTotal: '0.00',
    });
  });

  it.each([
    ['sin fotografia', null, 'sin resumen'],
    [
      'sin acuerdo',
      {
        pendingBalance: null,
        confirmedAdvanceTotal: null,
        acceptedAdditionalTotal: null,
      },
      'sin acuerdo',
    ],
  ])('%s no calcula saldo', (_label, summary, note) => {
    const balance = cancelledBalance(summary);
    expect(balance).toMatchObject({
      status: 'NO_APLICA',
      amount: null,
      advanceAmount: null,
      additionalBudgetsTotal: null,
    });
    expect(balance.note).toContain(note);
  });
});
