import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, Matches } from 'class-validator';
import { OrderStatus } from '../../../generated/prisma/enums.js';
import { REPORT_FORMATS } from './report-query.dto.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property debe tener el formato AAAA-MM-DD';

/** `?status=A,B` o `?status=A&status=B` -> ['A', 'B']; vacio -> []. */
const toStatusList = ({ value }: { value: unknown }): unknown => {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : [item]))
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');
  return [...new Set(parts)];
};

/**
 * Reporte financiero: rango de fechas del acuerdo (hora de Bolivia, ambos
 * dias incluidos), estados actuales del pedido opcionales y formato.
 */
export class FinancialReportQueryDto {
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  from: string;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  to: string;

  @IsOptional()
  @Transform(toStatusList)
  @IsEnum(OrderStatus, {
    each: true,
    message: 'status solo admite estados de pedido válidos',
  })
  status: OrderStatus[] = [];

  @IsOptional()
  @IsIn(REPORT_FORMATS)
  format: (typeof REPORT_FORMATS)[number] = 'json';
}
