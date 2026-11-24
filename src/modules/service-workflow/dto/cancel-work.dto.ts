import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { CANCEL_WORK_REASON_MAX_LENGTH } from '../workflow.rules.js';

/** "Cancelar trabajo" (RF-34, CU-34): el motivo es obligatorio. */
export class CancelWorkDto {
  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'reason es obligatorio' })
  @MaxLength(CANCEL_WORK_REASON_MAX_LENGTH)
  reason: string;
}
