import {
  IsByteLength,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import {
  PHONE_MESSAGE,
  PHONE_PATTERN,
} from '../../users/dto/create-user.dto.js';

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt ignora todo lo que exceda los 72 bytes. */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Registro público. No admite roles ni estado: el ValidationPipe global
 * (forbidNonWhitelisted) rechaza cualquier propiedad no declarada aquí.
 */
export class RegisterDto {
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
  @MinLength(PASSWORD_MIN_LENGTH)
  @IsByteLength(0, PASSWORD_MAX_BYTES, {
    message: `password no puede superar los ${PASSWORD_MAX_BYTES} bytes`,
  })
  @Matches(/(?=.*\p{L})(?=.*\d)/u, {
    message: 'password debe contener al menos una letra y un número',
  })
  password: string;

  @Trim()
  @IsOptional()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string;
}
