import type { Prisma } from '../../generated/prisma/client.js';
import {
  computeAdvanceAmount,
  roundMoney,
  toMoney,
  type MoneyInput,
} from './payments.rules.js';

/**
 * Saldo esperado informativo (RN-02, RN-03):
 *   monto acordado + presupuestos adicionales aceptados - anticipo esperado.
 *
 * Mientras no exista el contrato real de Persona A para los presupuestos
 * adicionales (`additionalBudgetsTotal` es null), NO se calcula un saldo
 * parcial: se informa PENDIENTE_INTEGRACION. Un saldo sin los adicionales
 * seria incorrecto, y mostrarlo como esperado enganaria a las partes.
 */
export type ExpectedBalance =
  | {
      status: 'CALCULADO';
      amount: Prisma.Decimal;
      advanceAmount: Prisma.Decimal;
      additionalBudgetsTotal: Prisma.Decimal;
    }
  | { status: 'PENDIENTE_INTEGRACION'; amount: null; reason: string };

export function computeExpectedBalance(input: {
  agreedAmount: MoneyInput;
  /** Suma de presupuestos adicionales ACEPTADOS; null = lector no disponible. */
  additionalBudgetsTotal: MoneyInput | null;
}): ExpectedBalance {
  if (input.additionalBudgetsTotal === null) {
    return {
      status: 'PENDIENTE_INTEGRACION',
      amount: null,
      reason:
        'El total de presupuestos adicionales aceptados todavia no esta disponible.',
    };
  }
  const additional = toMoney(input.additionalBudgetsTotal);
  if (additional.isNegative()) {
    throw new RangeError('El total de presupuestos adicionales es negativo');
  }
  const agreed = toMoney(input.agreedAmount);
  const advanceAmount = computeAdvanceAmount(agreed);
  return {
    status: 'CALCULADO',
    amount: roundMoney(agreed.plus(additional).minus(advanceAmount)),
    advanceAmount,
    additionalBudgetsTotal: roundMoney(additional),
  };
}
