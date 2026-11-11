import {
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';

export class CreateZoneChangeRequestDto {
  /** Nueva zona solicitada; debe estar activa. */
  @IsUUID()
  toZoneId: string;

  /** Motivo del cambio (CU-13, paso 3). */
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}
