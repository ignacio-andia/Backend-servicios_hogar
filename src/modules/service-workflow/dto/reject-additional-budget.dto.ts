import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TrimEmptyAs } from '../../../common/decorators/trim.decorator.js';

export const REJECT_BUDGET_REASON_MAX_LENGTH = 400;

/** Rechazo del presupuesto adicional (RF-27, CU-27 paso 2): motivo opcional. */
export class RejectAdditionalBudgetDto {
  /** "" o solo espacios se tratan como ausente. */
  @TrimEmptyAs(undefined)
  @IsOptional()
  @IsString()
  @MaxLength(REJECT_BUDGET_REASON_MAX_LENGTH)
  reason?: string;
}
