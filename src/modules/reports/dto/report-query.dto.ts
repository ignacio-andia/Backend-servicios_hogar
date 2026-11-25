import { IsIn, IsOptional, Matches } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property debe tener el formato AAAA-MM-DD';

export const REPORT_FORMATS = ['json', 'csv'] as const;

/** Rango de fechas (hora de Bolivia, ambos dias incluidos) y formato. */
export class ReportQueryDto {
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  from: string;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  to: string;

  @IsOptional()
  @IsIn(REPORT_FORMATS)
  format: (typeof REPORT_FORMATS)[number] = 'json';
}
