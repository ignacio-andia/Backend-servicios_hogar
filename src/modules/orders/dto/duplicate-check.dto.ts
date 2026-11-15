import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import {
  ORDER_DESCRIPTION_MAX_LENGTH,
  ORDER_DESCRIPTION_MIN_LENGTH,
} from '../orders.rules.js';

/** Consulta previa de posibles duplicados (orientativa, nunca bloquea). */
export class DuplicateCheckDto {
  @IsUUID()
  categoryId: string;

  @IsUUID()
  zoneId: string;

  @Trim()
  @IsString()
  @MinLength(ORDER_DESCRIPTION_MIN_LENGTH)
  @MaxLength(ORDER_DESCRIPTION_MAX_LENGTH)
  description: string;
}
