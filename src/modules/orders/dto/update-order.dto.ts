import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import {
  ORDER_ADDRESS_MAX_LENGTH,
  ORDER_DESCRIPTION_MAX_LENGTH,
  ORDER_DESCRIPTION_MIN_LENGTH,
} from '../orders.rules.js';
import {
  BUDGET_AMOUNT_MESSAGE,
  BUDGET_AMOUNT_PATTERN,
  toAmountString,
} from './create-order.dto.js';

const isPresent = (_dto: object, value: unknown): boolean =>
  value !== undefined;

/**
 * Datos editables del pedido (RF-18; especificacion v1.0 §3, T5.2): categoria,
 * descripcion, presupuesto y direccion. La zona NO se edita: para otra zona se
 * cancela el pedido y se crea uno nuevo. Tampoco el estado, el dueno, las
 * fechas de publicacion y vencimiento ni los campos internos: el
 * ValidationPipe global rechaza cualquier otra propiedad (400). Las fotos se
 * editan con sus rutas.
 */
export class UpdateOrderDto {
  /** Nueva categoria: debe existir (404) y estar activa (400). */
  @ValidateIf(isPresent)
  @IsUUID()
  categoryId?: string;

  @Trim()
  @ValidateIf(isPresent)
  @IsString()
  @MinLength(ORDER_DESCRIPTION_MIN_LENGTH)
  @MaxLength(ORDER_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @Transform(toAmountString)
  @ValidateIf(isPresent)
  @IsString()
  @Matches(BUDGET_AMOUNT_PATTERN, { message: BUDGET_AMOUNT_MESSAGE })
  budgetAmount?: string;

  @Trim()
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ORDER_ADDRESS_MAX_LENGTH)
  addressLine?: string;

  /** `null` o cadena vacia eliminan la referencia. */
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(ORDER_ADDRESS_MAX_LENGTH)
  addressReference?: string | null;
}
