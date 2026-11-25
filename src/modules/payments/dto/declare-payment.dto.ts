import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches } from 'class-validator';
import {
  PAYMENT_AMOUNT_MESSAGE,
  PAYMENT_AMOUNT_PATTERN,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '../payments.rules.js';

// Los montos se reciben como texto (Decimal sin flotantes); un numero JSON
// tambien se acepta y se convierte.
const toAmountString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' ? String(value) : value;

/**
 * Declaracion de un pago ("Ya pagué" del cliente o "Confirmo que me pagaron"
 * del trabajador). El usuario y su rol salen del token, nunca del cuerpo. El
 * concepto va en la ruta.
 */
export class DeclarePaymentDto {
  @Transform(toAmountString)
  @IsString()
  @Matches(PAYMENT_AMOUNT_PATTERN, { message: PAYMENT_AMOUNT_MESSAGE })
  amount: string;

  @IsIn(PAYMENT_METHODS)
  method: PaymentMethod;
}
