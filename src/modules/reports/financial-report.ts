// Reglas puras del reporte financiero: que se espera cobrar, que confirmo el
// trabajador, que queda pendiente y la comision informativa.

import { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import type { FinancialReportRecord } from '../payments/payments.service.js';
import type { ReportCell } from './report-format.js';

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);
/** Bolivia no usa horario de verano: America/La_Paz es siempre UTC-4. */
const LA_PAZ_OFFSET_MS = -4 * 60 * 60 * 1000;

export const FINANCIAL_COLUMNS = [
  'pedido',
  'fecha_acuerdo',
  'categoria',
  'zona',
  'estado',
  'monto_oferta',
  'adicionales_aceptados',
  'costo_visita',
  'total_esperado',
  'ingresos_confirmados',
  'pendiente',
  'comision',
] as const;

export interface FinancialAmounts {
  /** Oferta aceptada + adicionales aceptados + visita registrada con costo. */
  expected: Prisma.Decimal;
  /** Lo que confirmo el trabajador (anticipo, visita y saldo). */
  income: Prisma.Decimal;
  /** Lo que falta confirmar; nunca negativo. */
  pending: Prisma.Decimal;
  /** Comision informativa sobre los ingresos confirmados. */
  commission: Prisma.Decimal;
}

/**
 * Montos de un pedido:
 * - Ingresos: suma de las confirmaciones del trabajador.
 * - Pendiente: lo esperado menos lo confirmado, nunca menor que 0.
 *   - Cancelado: 0 (el tratamiento del anticipo no esta definido; no se
 *     inventa una deuda).
 *   - Cerrado por rechazo de un adicional (RF-27): solo queda el cobro de la
 *     visita, si tiene costo.
 * - Comision: ingresos x porcentaje / 100, redondeada a 2 decimales.
 */
export function computeAmounts(
  record: FinancialReportRecord,
  commissionPercent: Prisma.Decimal,
): FinancialAmounts {
  const base = record.baseAmount ?? ZERO;
  const visit = record.visitCost ?? ZERO;
  const expected = base.plus(record.acceptedAdditional).plus(visit);
  const { ANTICIPO, VISITA, SALDO } = record.confirmed;
  const income = ANTICIPO.plus(VISITA).plus(SALDO);
  let pending: Prisma.Decimal;
  if (record.status === OrderStatus.CANCELADO) {
    pending = ZERO;
  } else if (record.closedByRejection) {
    pending = Prisma.Decimal.max(ZERO, visit.minus(VISITA));
  } else {
    pending = Prisma.Decimal.max(ZERO, expected.minus(income));
  }
  const commission = income
    .times(commissionPercent)
    .dividedBy(HUNDRED)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { expected, income, pending, commission };
}

/** Fecha y hora en Bolivia, `AAAA-MM-DD HH:mm`. */
export function toLaPazDateTime(date: Date): string {
  return new Date(date.getTime() + LA_PAZ_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

export interface FinancialTotals {
  orders: number;
  expected: string;
  income: string;
  pending: string;
  commission: string;
}

/** Filas del reporte (una por pedido) y totales, con montos en texto decimal. */
export function buildFinancialTable(
  records: readonly FinancialReportRecord[],
  commissionPercent: Prisma.Decimal,
  names: (record: FinancialReportRecord) => [string, string],
): { rows: ReportCell[][]; totals: FinancialTotals } {
  let expected = ZERO;
  let income = ZERO;
  let pending = ZERO;
  let commission = ZERO;
  const rows = records.map((record) => {
    const amounts = computeAmounts(record, commissionPercent);
    expected = expected.plus(amounts.expected);
    income = income.plus(amounts.income);
    pending = pending.plus(amounts.pending);
    commission = commission.plus(amounts.commission);
    const [category, zone] = names(record);
    return [
      record.orderId,
      toLaPazDateTime(record.agreedAt),
      category,
      zone,
      record.status,
      (record.baseAmount ?? ZERO).toFixed(2),
      record.acceptedAdditional.toFixed(2),
      (record.visitCost ?? ZERO).toFixed(2),
      amounts.expected.toFixed(2),
      amounts.income.toFixed(2),
      amounts.pending.toFixed(2),
      amounts.commission.toFixed(2),
    ];
  });
  return {
    rows,
    totals: {
      orders: records.length,
      expected: expected.toFixed(2),
      income: income.toFixed(2),
      pending: pending.toFixed(2),
      commission: commission.toFixed(2),
    },
  };
}
