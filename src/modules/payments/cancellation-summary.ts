//=========================================================
// NUEVO: cancellation-summary.ts
// Fase B3 (cancelacion): reglas puras de la fotografia economica de un pedido
// cancelado y formato de su detalle (version 1). Sin acceso a la base.
// Reglas economicas:
// - total actualizado = monto acordado + adicionales ACEPTADOS;
// - saldo pendiente = total actualizado - anticipo confirmado;
// - confirmado = declaracion del trabajador asignado, por su importe;
// - lo declarado por el cliente sin confirmacion se informa aparte y no reduce
//   el saldo; con confirmacion no queda nada "sin confirmar", aunque los
//   importes difieran (la diferencia no es un pago pendiente);
// - la visita se informa aparte y no entra en ningun total;
// - sin acuerdo, todos los importes son null (nunca 0);
// - se conservan todas las declaraciones originales.
// La plataforma no procesa, devuelve ni retiene dinero.
//=========================================================
import { Prisma } from '../../generated/prisma/client.js';
import {
  AdditionalBudgetStatus,
  PaymentConcept,
  PaymentDeclarer,
  type PaymentMethod,
} from '../../generated/prisma/enums.js';

export const CANCELLATION_SUMMARY_VERSION = 1;

/** Situacion de un pago al cancelar. */
export type CancellationPaymentStatus =
  'CONFIRMADO' | 'DECLARADO_SIN_CONFIRMAR' | 'SIN_DECLARACIONES';

export interface CancellationPaymentFact {
  id: string;
  concept: PaymentConcept;
  expectedAmount: Prisma.Decimal | null;
  declarations: readonly {
    id: string;
    declaredBy: PaymentDeclarer;
    userId: string;
    amount: Prisma.Decimal;
    method: PaymentMethod;
    createdAt: Date;
  }[];
}

export interface CancellationAgreementFacts {
  offerId: string;
  /** Trabajador asignado: solo su declaracion confirma un pago. */
  workerId: string;
  agreedAmount: Prisma.Decimal;
  /** Fecha del evento de aceptacion; null si no esta disponible. */
  agreedAt: Date | null;
  /** Costo de visita pactado; null si el acuerdo no tiene visita. */
  agreedVisitCost: Prisma.Decimal | null;
  visit: { performedAt: Date; visitCost: string | null } | null;
  additionalBudgets: readonly {
    id: string;
    amount: string;
    status: AdditionalBudgetStatus;
    respondedAt: Date | null;
    createdAt: Date;
  }[];
  payments: readonly CancellationPaymentFact[];
}

export interface SummaryDeclaration {
  id: string;
  declaredBy: PaymentDeclarer;
  userId: string;
  amount: string;
  method: PaymentMethod;
  createdAt: string;
}

export interface SummaryPayment {
  paymentId: string | null;
  expectedAmount: string | null;
  status: CancellationPaymentStatus;
  declarations: SummaryDeclaration[];
}

/** Formato de `details` (version 1). Importes como texto con 2 decimales. */
export interface CancellationSummaryDetails {
  /** null sin acuerdo. */
  advance: SummaryPayment | null;
  /** Solo los ACEPTADOS, uno por uno; su suma es el total de adicionales. */
  additionalBudgets: {
    id: string;
    amount: string;
    respondedAt: string | null;
    createdAt: string;
  }[];
  /** null sin acuerdo. */
  visit:
    | (SummaryPayment & {
        agreedCost: string | null;
        performedAt: string | null;
        registeredCost: string | null;
      })
    | null;
  /**
   * Cualquier otro pago registrado (el saldo no puede declararse en un estado
   * cancelable): se conserva y no se suma a nada.
   */
  otherPayments: (SummaryPayment & { concept: PaymentConcept })[];
}

export interface CancellationSummaryData {
  acceptedOfferId: string | null;
  agreedAt: Date | null;
  agreedAmount: Prisma.Decimal | null;
  acceptedAdditionalTotal: Prisma.Decimal | null;
  updatedTotal: Prisma.Decimal | null;
  confirmedAdvanceTotal: Prisma.Decimal | null;
  unconfirmedAdvanceAmount: Prisma.Decimal | null;
  pendingBalance: Prisma.Decimal | null;
  visitCost: Prisma.Decimal | null;
  details: CancellationSummaryDetails;
  schemaVersion: number;
}

/** Fotografia de un pedido cancelado sin acuerdo: no hay importes. */
export function summaryWithoutAgreement(): CancellationSummaryData {
  return {
    acceptedOfferId: null,
    agreedAt: null,
    agreedAmount: null,
    acceptedAdditionalTotal: null,
    updatedTotal: null,
    confirmedAdvanceTotal: null,
    unconfirmedAdvanceAmount: null,
    pendingBalance: null,
    visitCost: null,
    details: {
      advance: null,
      additionalBudgets: [],
      visit: null,
      otherPayments: [],
    },
    schemaVersion: CANCELLATION_SUMMARY_VERSION,
  };
}

export function summaryWithAgreement(
  facts: CancellationAgreementFacts,
): CancellationSummaryData {
  const accepted = facts.additionalBudgets.filter(
    (budget) => budget.status === AdditionalBudgetStatus.ACEPTADO,
  );
  const additional = accepted.reduce(
    (total, budget) => total.plus(budget.amount),
    new Prisma.Decimal(0),
  );
  const updated = facts.agreedAmount.plus(additional);

  const byConcept = (concept: PaymentConcept) =>
    facts.payments.find((payment) => payment.concept === concept);
  const advance = byConcept(PaymentConcept.ANTICIPO);
  const confirmation = confirmationOf(advance, facts.workerId);
  const claimed = advance?.declarations.find(
    (d) => d.declaredBy === PaymentDeclarer.CLIENTE,
  );
  const confirmed = confirmation?.amount ?? new Prisma.Decimal(0);
  const visit = byConcept(PaymentConcept.VISITA);

  return {
    acceptedOfferId: facts.offerId,
    agreedAt: facts.agreedAt,
    agreedAmount: facts.agreedAmount,
    acceptedAdditionalTotal: additional,
    updatedTotal: updated,
    confirmedAdvanceTotal: confirmed,
    unconfirmedAdvanceAmount: confirmation ? null : (claimed?.amount ?? null),
    pendingBalance: updated.minus(confirmed),
    visitCost: facts.agreedVisitCost,
    details: {
      advance: toSummaryPayment(advance, facts.workerId),
      additionalBudgets: accepted.map((budget) => ({
        id: budget.id,
        amount: budget.amount,
        respondedAt: budget.respondedAt?.toISOString() ?? null,
        createdAt: budget.createdAt.toISOString(),
      })),
      visit: {
        agreedCost: facts.agreedVisitCost?.toFixed(2) ?? null,
        performedAt: facts.visit?.performedAt.toISOString() ?? null,
        registeredCost: facts.visit?.visitCost ?? null,
        ...toSummaryPayment(visit, facts.workerId),
      },
      otherPayments: facts.payments
        .filter(
          (payment) =>
            payment.concept !== PaymentConcept.ANTICIPO &&
            payment.concept !== PaymentConcept.VISITA,
        )
        .map((payment) => ({
          concept: payment.concept,
          ...toSummaryPayment(payment, facts.workerId),
        })),
    },
    schemaVersion: CANCELLATION_SUMMARY_VERSION,
  };
}

/** La declaracion que confirma un pago: la del trabajador asignado. */
function confirmationOf(
  payment: CancellationPaymentFact | undefined,
  workerId: string,
) {
  return payment?.declarations.find(
    (d) => d.declaredBy === PaymentDeclarer.TRABAJADOR && d.userId === workerId,
  );
}

function toSummaryPayment(
  payment: CancellationPaymentFact | undefined,
  workerId: string,
): SummaryPayment {
  const declarations = payment?.declarations ?? [];
  let status: CancellationPaymentStatus = 'SIN_DECLARACIONES';
  if (confirmationOf(payment, workerId)) {
    status = 'CONFIRMADO';
  } else if (declarations.length > 0) {
    status = 'DECLARADO_SIN_CONFIRMAR';
  }
  return {
    paymentId: payment?.id ?? null,
    expectedAmount: payment?.expectedAmount?.toFixed(2) ?? null,
    status,
    declarations: declarations.map((d) => ({
      id: d.id,
      declaredBy: d.declaredBy,
      userId: d.userId,
      amount: d.amount.toFixed(2),
      method: d.method,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}
