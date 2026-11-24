import { Prisma } from '../../generated/prisma/client.js';

// Reglas de dinero del modulo de pagos. La plataforma NO procesa, recibe,
// retiene ni garantiza dinero (RN-01, RF-43): aqui solo se calculan montos de
// referencia y se registran declaraciones de las partes.

/**
 * Conceptos de pago de un trabajo. Los tipos locales se reemplazaran por los
 * enums generados de Prisma cuando se autorice el schema (ver
 * docs/persona-b/CONTRATOS_Y_PRISMA.md).
 */
export const PAYMENT_CONCEPTS = ['VISITA', 'ANTICIPO', 'SALDO'] as const;
export type PaymentConcept = (typeof PAYMENT_CONCEPTS)[number];

/** RN-01: efectivo o QR acordado entre las partes. */
export const PAYMENT_METHODS = ['EFECTIVO', 'QR'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Quien hace la declaracion (RF-40 trabajador, RF-42 cliente). */
export const PAYMENT_DECLARERS = ['CLIENTE', 'TRABAJADOR'] as const;
export type PaymentDeclarer = (typeof PAYMENT_DECLARERS)[number];

/** RN-02: el anticipo es el 25% del monto acordado del trabajo. */
export const ADVANCE_RATE = new Prisma.Decimal('0.25');

/** Escala de los montos: Decimal(10, 2) en la BD. */
export const MONEY_SCALE = 2;

/**
 * Redondeo de los montos derivados: a 2 decimales, mitad hacia arriba
 * (ROUND_HALF_UP). Es una decision tecnica documentada; si el docente define
 * otro criterio, se cambia solo aqui.
 */
export const MONEY_ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

export type MoneyInput = Prisma.Decimal | string;

/** Convierte a Decimal sin pasar nunca por `number`. */
export function toMoney(value: MoneyInput): Prisma.Decimal {
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite()) {
    throw new RangeError('El monto no es un numero finito');
  }
  return decimal;
}

/** Redondea un monto a la escala de la BD con la regla del proyecto. */
export function roundMoney(value: MoneyInput): Prisma.Decimal {
  return toMoney(value).toDecimalPlaces(MONEY_SCALE, MONEY_ROUNDING);
}

/**
 * RF-39 / RN-02: anticipo = 25% del monto ACORDADO, es decir el monto de la
 * oferta aceptada (no el presupuesto del pedido). Los presupuestos adicionales
 * no cambian el anticipo: la base es el monto acordado.
 */
export function computeAdvanceAmount(agreedAmount: MoneyInput): Prisma.Decimal {
  const agreed = toMoney(agreedAmount);
  if (agreed.isNegative() || agreed.isZero()) {
    throw new RangeError('El monto acordado debe ser mayor que 0');
  }
  return roundMoney(agreed.mul(ADVANCE_RATE));
}

/** Texto fijo de RF-43: se incluye en toda respuesta de pagos. */
export const DIRECT_PAYMENT_NOTICE =
  'El pago se realiza directamente al trabajador, en efectivo o por un QR acordado entre ambos. La plataforma solo registra las declaraciones de las partes: no recibe, retiene ni garantiza dinero.';

/** Un comprobante subido es solo una referencia (RF-41, RF-39 A2). */
export const RECEIPT_REFERENCE_NOTICE =
  'El comprobante adjunto es solo una referencia; no es prueba de que el dinero haya llegado.';

// Montos recibidos como texto (Decimal sin flotantes), mayores que 0 y con la
// precision de Decimal(10, 2).
export const PAYMENT_AMOUNT_PATTERN =
  /^(?!0+(?:\.0{1,2})?$)\d{1,8}(?:\.\d{1,2})?$/;
export const PAYMENT_AMOUNT_MESSAGE =
  'amount debe ser un monto mayor que 0, con hasta 8 dígitos enteros y 2 decimales';
