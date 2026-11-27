//=========================================================
// MODIFICADO: cancel-order.dto.ts
// Fase B1 (cancelacion): el motivo pasa a ser OBLIGATORIO tambien al cancelar
// un pedido sin acuerdo (decision D1). Es la unica validacion HTTP del motivo:
// CancelWorkDto la hereda, asi las dos rutas no pueden divergir.
// Regla: motivo recortado, no vacio y de hasta 500 caracteres.
//=========================================================
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { ORDER_STATUS_REASON_MAX_LENGTH } from '../orders.rules.js';

/** Cancelacion por el cliente (RF-18 y, por herencia, RF-34). */
export class CancelOrderDto {
  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'reason es obligatorio' })
  @MaxLength(ORDER_STATUS_REASON_MAX_LENGTH)
  reason: string;
}
