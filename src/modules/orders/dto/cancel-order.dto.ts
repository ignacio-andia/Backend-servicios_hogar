import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { ORDER_STATUS_REASON_MAX_LENGTH } from '../orders.rules.js';

/** Cancelacion por el cliente (RF-18). El motivo es opcional. */
export class CancelOrderDto {
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(ORDER_STATUS_REASON_MAX_LENGTH)
  reason?: string;
}
