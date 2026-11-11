import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import {
  CATALOG_DESCRIPTION_MAX_LENGTH,
  CATALOG_NAME_MAX_LENGTH,
  CATALOG_NAME_MIN_LENGTH,
} from './create-catalog-item.dto.js';

/**
 * Solo se editan nombre y descripción. El estado cambia únicamente con el
 * endpoint de desactivación; el ValidationPipe global rechaza otras propiedades.
 */
export class UpdateCatalogItemDto {
  @Trim()
  @ValidateIf((_dto: object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MinLength(CATALOG_NAME_MIN_LENGTH)
  @MaxLength(CATALOG_NAME_MAX_LENGTH)
  name?: string;

  /** `null` o una cadena vacía eliminan la descripción. */
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_DESCRIPTION_MAX_LENGTH)
  description?: string | null;
}
