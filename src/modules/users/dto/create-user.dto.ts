import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';

export const PHONE_PATTERN = /^\+?[1-9]\d{6,14}$/;
export const PHONE_MESSAGE =
  'phone debe tener entre 7 y 15 dígitos, opcionalmente precedidos de +';

/**
 * Datos para crear una cuenta desde servicios internos (AuthModule).
 * La contraseña llega ya hasheada: UsersModule nunca recibe ni hashea
 * contraseñas en texto plano.
 */
export class CreateUserDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @Trim()
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  passwordHash: string;

  @Trim()
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string;
}
