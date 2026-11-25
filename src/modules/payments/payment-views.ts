import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderStatus } from '../../generated/prisma/enums.js';
import type { ExpectedBalance } from './expected-balance.js';
import type { DeclarationComparison } from './payment-declarations.js';
import type { RequiredConfirmation } from './payments.policy.js';
import type {
  PaymentConcept,
  PaymentDeclarer,
  PaymentMethod,
} from './payments.rules.js';

// Vistas HTTP de pagos y constancias. Montos como texto con 2 decimales
// (Decimal, sin flotantes). Nunca incluyen direccion, telefono ni correo.

export interface DeclarationView {
  id: string;
  declaredBy: PaymentDeclarer;
  userId: string;
  method: PaymentMethod;
  amount: string;
  createdAt: Date;
}

export interface PaymentView {
  concept: PaymentConcept;
  /** null si todavia nadie declaro este concepto. */
  paymentId: string | null;
  /** Monto esperado (anticipo y visita, congelado al crearse); null en el saldo. */
  expectedAmount: string | null;
  /** Que confirmacion exige el concepto; la del cliente es siempre opcional. */
  requiredConfirmation: RequiredConfirmation | 'CLIENTE' | 'AMBOS';
  declarations: DeclarationView[];
  /** Comparacion INFORMATIVA entre las declaraciones; no es una conciliacion. */
  comparison: DeclarationComparison;
  /** trabajador - cliente, solo si ambas declararon. */
  difference: string | null;
  methodsMatch: boolean | null;
}

export interface BalanceView {
  status: ExpectedBalance['status'];
  /** Saldo esperado = monto acordado + adicionales aceptados - anticipo. */
  amount: string | null;
  advanceAmount: string | null;
  additionalBudgetsTotal: string | null;
  note: string;
}

export interface PaymentsOverview {
  orderId: string;
  orderStatus: OrderStatus;
  /** RF-43: aviso de pago directo. */
  notice: string;
  agreement: {
    baseAmount: string;
    acceptedAdditional: string;
    totalAmount: string;
  } | null;
  advanceTransition: 'DESACTIVADA_PENDIENTE_DEFINICION' | 'ACTIVA';
  payments: PaymentView[];
  balance: BalanceView;
}

export interface ReceiptsView {
  orderId: string;
  notice: string;
  referenceNotice: string;
  service: {
    clientId: string;
    workerId: string;
    agreedAmount: string;
    issuedAt: Date;
  } | null;
  /** Una constancia por declaracion: fecha y hora, usuario, monto y metodo. */
  payments: {
    concept: PaymentConcept;
    paymentId: string;
    declaration: DeclarationView;
  }[];
}

export type OrderTransitionOutcome =
  'ANTICIPO_REGISTRADO' | 'DESACTIVADA_PENDIENTE_DEFINICION' | 'NO_APLICA';

export interface DeclarationResult {
  notice: string;
  payment: PaymentView;
  /**
   * Efecto sobre el pedido. Sin PAYMENTS_ADVANCE_CONFIRMED_BY la transicion
   * automatica del anticipo esta desactivada y el pedido no avanza.
   */
  orderTransition: OrderTransitionOutcome;
}

export interface PaymentDifferenceView {
  paymentId: string;
  orderId: string;
  concept: PaymentConcept;
  clientAmount: string;
  workerAmount: string;
  difference: string;
  createdAt: Date;
}

export const money = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(2);

export function toDeclarationView(declaration: {
  id: string;
  declaredBy: PaymentDeclarer;
  userId: string;
  method: PaymentMethod;
  amount: Prisma.Decimal;
  createdAt: Date;
}): DeclarationView {
  return {
    id: declaration.id,
    declaredBy: declaration.declaredBy,
    userId: declaration.userId,
    method: declaration.method,
    amount: declaration.amount.toFixed(2),
    createdAt: declaration.createdAt,
  };
}
