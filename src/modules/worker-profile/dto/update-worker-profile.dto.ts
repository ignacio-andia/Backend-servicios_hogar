import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_YEARS_OF_EXPERIENCE,
} from './create-worker-profile.dto.js';

/**
 * Datos editables del perfil. El estado no se acepta (el ValidationPipe
 * global rechaza propiedades no declaradas). La zona solo se cambia aqui
 * mientras el perfil es BORRADOR; despues se usa una solicitud de cambio.
 */
export class UpdateWorkerProfileDto {
  @ValidateIf((_dto: object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_YEARS_OF_EXPERIENCE)
  yearsOfExperience?: number;

  /** `null` o cadena vacia eliminan la descripcion. */
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_DESCRIPTION_LENGTH)
  description?: string | null;

  @ValidateIf((_dto: object, value: unknown) => value !== undefined)
  @IsUUID()
  zoneId?: string;
}
