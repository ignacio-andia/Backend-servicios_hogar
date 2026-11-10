import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { PHONE_MESSAGE, PHONE_PATTERN } from './create-user.dto.js';

const isPresent = (_dto: object, value: unknown): boolean =>
  value !== undefined;

/**
 * Datos personales modificables. El id, el correo, los roles, el estado y
 * el hash de contraseña quedan fuera a propósito: el ValidationPipe global
 * (forbidNonWhitelisted) rechaza cualquier otra propiedad.
 */
export class UpdateUserDto {
  @Trim()
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @Trim()
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  /** `null` elimina el teléfono registrado. */
  @Trim()
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string | null;
}
