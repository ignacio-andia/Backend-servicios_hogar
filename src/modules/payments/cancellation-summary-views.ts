//=========================================================
// NUEVO: cancellation-summary-views.ts
// Fase B4 (cancelacion): respuesta de la consulta del resumen economico y
// saldo que informa la consulta de pagos para un pedido cancelado.
// Necesario para mostrar la fotografia guardada en B3 sin recalcularla.
// Reglas: los importes salen tal cual de las columnas guardadas (solo se les
// da formato de 2 decimales); la visita va aparte; las declaraciones hechas
// despues de cancelar se listan por separado y no cambian la fotografia; un
// anticipo solo se resta si estaba confirmado al cancelar. La plataforma no
// procesa, devuelve ni retiene dinero.
//=========================================================
import type { OrderCancellationSummary } from '../../generated/prisma/client.js';
import type { CancellationSummaryDetails } from './cancellation-summary.js';
import {
  type BalanceView,
  type DeclarationView,
  money,
} from './payment-views.js';
import type { PaymentConcept } from './payments.rules.js';
import { DIRECT_PAYMENT_NOTICE } from './payments.rules.js';

export type DeclarationAfterCancellation = DeclarationView & {
  concept: PaymentConcept;
};

export interface CancellationSummaryView {
  orderId: string;
  /** Aviso de pago directo (RF-43). */
  notice: string;
  /** Instante en que se tomo la fotografia. */
  capturedAt: Date;
  hasAgreement: boolean;
  /** null si el pedido se cancelo sin acuerdo. */
  agreement: { offerId: string; agreedAt: Date | null } | null;
  /** Importes al cancelar; todos null sin acuerdo. */
  totals: {
    agreedAmount: string | null;
    acceptedAdditionalTotal: string | null;
    updatedTotal: string | null;
    /** Anticipo confirmado por el trabajador. */
    confirmedAdvanceTotal: string | null;
    /** Declarado por el cliente y sin confirmar: no reduce el saldo. */
    unconfirmedAdvanceAmount: string | null;
    pendingBalance: string | null;
  };
  /** Anticipo: situacion y declaraciones originales; null sin acuerdo. */
  advance: CancellationSummaryDetails['advance'];
  additionalBudgets: CancellationSummaryDetails['additionalBudgets'];
  /** Visita, aparte de los totales; null sin acuerdo. */
  visit: CancellationSummaryDetails['visit'];
  otherPayments: CancellationSummaryDetails['otherPayments'];
  /**
   * Declaraciones registradas despues de la fotografia (el cobro de una visita
   * ya realizada). No forman parte de ella ni cambian sus importes.
   */
  declarationsAfterCancellation: DeclarationAfterCancellation[];
  schemaVersion: number;
}

export function toCancellationSummaryView(
  summary: OrderCancellationSummary,
  declarations: readonly DeclarationAfterCancellation[],
): CancellationSummaryView {
  const details = summary.details as unknown as CancellationSummaryDetails;
  // Se distinguen por su identificador, no por la fecha: una declaracion
  // confirmada mientras la cancelacion esperaba el bloqueo es de la
  // fotografia aunque su hora sea posterior al inicio de la cancelacion.
  const captured = new Set(
    [details.advance, details.visit, ...details.otherPayments].flatMap(
      (payment) => payment?.declarations.map((d) => d.id) ?? [],
    ),
  );
  return {
    orderId: summary.orderId,
    notice: DIRECT_PAYMENT_NOTICE,
    capturedAt: summary.capturedAt,
    hasAgreement: summary.acceptedOfferId !== null,
    agreement:
      summary.acceptedOfferId === null
        ? null
        : { offerId: summary.acceptedOfferId, agreedAt: summary.agreedAt },
    totals: {
      agreedAmount: money(summary.agreedAmount),
      acceptedAdditionalTotal: money(summary.acceptedAdditionalTotal),
      updatedTotal: money(summary.updatedTotal),
      confirmedAdvanceTotal: money(summary.confirmedAdvanceTotal),
      unconfirmedAdvanceAmount: money(summary.unconfirmedAdvanceAmount),
      pendingBalance: money(summary.pendingBalance),
    },
    advance: details.advance,
    additionalBudgets: details.additionalBudgets,
    visit: details.visit,
    otherPayments: details.otherPayments,
    declarationsAfterCancellation: declarations.filter(
      (declaration) => !captured.has(declaration.id),
    ),
    schemaVersion: summary.schemaVersion,
  };
}

const NO_AMOUNTS = {
  status: 'NO_APLICA',
  amount: null,
  advanceAmount: null,
  additionalBudgetsTotal: null,
} as const;

/**
 * Saldo de un pedido CANCELADO en la consulta de pagos: el de la fotografia.
 * Nunca resta el anticipo esperado. Sin fotografia o sin acuerdo no se calcula.
 */
export function cancelledBalance(
  summary: Pick<
    OrderCancellationSummary,
    'pendingBalance' | 'confirmedAdvanceTotal' | 'acceptedAdditionalTotal'
  > | null,
): BalanceView {
  if (!summary) {
    return {
      ...NO_AMOUNTS,
      note: 'El pedido se canceló sin resumen económico registrado: no se calcula un saldo.',
    };
  }
  if (summary.pendingBalance === null) {
    return {
      ...NO_AMOUNTS,
      note: 'El pedido se canceló sin acuerdo: no hay saldo.',
    };
  }
  return {
    status: 'CALCULADO',
    amount: money(summary.pendingBalance),
    advanceAmount: money(summary.confirmedAdvanceTotal),
    additionalBudgetsTotal: money(summary.acceptedAdditionalTotal),
    note: 'Pedido cancelado. Informativo: saldo registrado al cancelar; solo resta el anticipo confirmado por el trabajador. La plataforma no recibe, devuelve ni retiene dinero.',
  };
}
