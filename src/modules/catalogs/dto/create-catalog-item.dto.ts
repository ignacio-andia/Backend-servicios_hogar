import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';

export const CATALOG_NAME_MIN_LENGTH = 2;
export const CATALOG_NAME_MAX_LENGTH = 100;
export const CATALOG_DESCRIPTION_MAX_LENGTH = 500;

/** Datos para crear una categoría de servicio o una zona. */
export class CreateCatalogItemDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MinLength(CATALOG_NAME_MIN_LENGTH)
  @MaxLength(CATALOG_NAME_MAX_LENGTH)
  name: string;

  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(CATALOG_DESCRIPTION_MAX_LENGTH)
  description?: string;
}
