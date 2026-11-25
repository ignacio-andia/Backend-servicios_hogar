import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import {
  BUDGET_AMOUNT_MESSAGE,
  BUDGET_AMOUNT_PATTERN,
  BUDGET_MATERIALS_MAX_LENGTH,
  BUDGET_REASON_MAX_LENGTH,
} from '../workflow.rules.js';

// Los montos se reciben como texto (Decimal sin flotantes); un numero JSON
// tambien se acepta y se convierte.
const toAmountString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' ? String(value) : value;

/** Presupuesto adicional (RF-26): monto, motivo y materiales. */
export class CreateAdditionalBudgetDto {
  /** Monto del costo adicional (> 0). No reemplaza el monto acordado. */
  @Transform(toAmountString)
  @IsString()
  @Matches(BUDGET_AMOUNT_PATTERN, { message: BUDGET_AMOUNT_MESSAGE })
  amount: string;

  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'reason es obligatorio' })
  @MaxLength(BUDGET_REASON_MAX_LENGTH)
  reason: string;

  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'materials es obligatorio' })
  @MaxLength(BUDGET_MATERIALS_MAX_LENGTH)
  materials: string;
}
