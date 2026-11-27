import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client.js';

/** Porcentaje de comision por defecto (decision del equipo, 26/11/2026). */
export const DEFAULT_COMMISSION_PERCENT = '15';

const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * Lee el porcentaje de comision del reporte financiero. Es INFORMATIVO: la
 * plataforma no cobra comision ni procesa dinero (requerimientos, 4.2); solo
 * se calcula para mostrar cuanto representaria. Se configura con
 * FINANCIAL_COMMISSION_PERCENT (0 a 100, hasta 2 decimales). Un valor
 * invalido detiene el arranque con un mensaje claro.
 */
export function readCommissionPercent(raw: string | undefined): Prisma.Decimal {
  const text =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_COMMISSION_PERCENT
      : raw.trim();
  if (!PERCENT_PATTERN.test(text) || new Prisma.Decimal(text).gt(100)) {
    throw new Error(
      'FINANCIAL_COMMISSION_PERCENT debe ser un numero entre 0 y 100 con hasta 2 decimales',
    );
  }
  return new Prisma.Decimal(text);
}

@Injectable()
export class FinancialReportConfig {
  readonly commissionPercent: Prisma.Decimal;

  constructor(config: ConfigService) {
    this.commissionPercent = readCommissionPercent(
      config.get<string>('FINANCIAL_COMMISSION_PERCENT'),
    );
  }
}
