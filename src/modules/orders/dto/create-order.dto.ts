import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import {
  ORDER_ADDRESS_MAX_LENGTH,
  ORDER_DESCRIPTION_MAX_LENGTH,
  ORDER_DESCRIPTION_MIN_LENGTH,
} from '../orders.rules.js';

// Monto mayor que 0 con hasta 2 decimales. Se recibe como texto (multipart y
// Decimal sin flotantes). Sin maximo de negocio (decision del equipo); el
// limite de 8 digitos enteros es la precision de la columna Decimal(10,2).
export const BUDGET_AMOUNT_PATTERN =
  /^(?!0+(?:\.0{1,2})?$)\d{1,8}(?:\.\d{1,2})?$/;
export const BUDGET_AMOUNT_MESSAGE =
  'budgetAmount debe ser un monto mayor que 0, con hasta 8 dígitos enteros y 2 decimales';

export const toAmountString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' ? String(value) : value;

/**
 * Datos del pedido (RF-14). En multipart/form-data todos los campos llegan
 * como texto; las fotografias van en el campo "images".
 */
export class CreateOrderDto {
  @IsUUID()
  categoryId: string;

  @IsUUID()
  zoneId: string;

  @Trim()
  @IsString()
  @MinLength(ORDER_DESCRIPTION_MIN_LENGTH)
  @MaxLength(ORDER_DESCRIPTION_MAX_LENGTH)
  description: string;

  @Transform(toAmountString)
  @IsString()
  @Matches(BUDGET_AMOUNT_PATTERN, { message: BUDGET_AMOUNT_MESSAGE })
  budgetAmount: string;

  /** Direccion exacta del trabajo: dato privado (RF-55). */
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ORDER_ADDRESS_MAX_LENGTH)
  addressLine: string;

  /** Referencia para llegar (opcional, tambien privada). */
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(ORDER_ADDRESS_MAX_LENGTH)
  addressReference?: string;
}
