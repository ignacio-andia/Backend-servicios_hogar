import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeclarer } from './payments.rules.js';

/** Quien debe declarar el anticipo para que el pedido pase a ANTICIPO_REGISTRADO. */
export type AdvanceConfirmation = PaymentDeclarer | 'AMBOS';
export const ADVANCE_CONFIRMATION_VALUES: readonly AdvanceConfirmation[] = [
  'TRABAJADOR',
  'CLIENTE',
  'AMBOS',
];

/**
 * Configuracion de PaymentsModule.
 *
 * PAYMENTS_ADVANCE_CONFIRMED_BY (TRABAJADOR | CLIENTE | AMBOS): quien confirma
 * la recepcion del anticipo. PENDIENTE DE CONFIRMAR CON EL DOCENTE: CU-39 dice
 * "se registra el anticipo en el sistema quien lo confirma" sin completar la
 * frase y RN-03 solo regula el saldo, asi que NO se asume. Sin valor, la
 * transicion automatica ACORDADO -> ANTICIPO_REGISTRADO queda DESACTIVADA: el
 * anticipo se registra igual, pero el pedido no avanza. Un valor invalido
 * detiene el arranque.
 */
@Injectable()
export class PaymentsConfig {
  readonly advanceConfirmedBy: AdvanceConfirmation | null;

  constructor(config: ConfigService) {
    this.advanceConfirmedBy = parseAdvanceConfirmation(
      config.get<string>('PAYMENTS_ADVANCE_CONFIRMED_BY'),
    );
  }
}

export function parseAdvanceConfirmation(
  raw: string | undefined,
): AdvanceConfirmation | null {
  const value = raw?.trim().toUpperCase();
  if (value === undefined || value === '') {
    return null;
  }
  if (!ADVANCE_CONFIRMATION_VALUES.includes(value as AdvanceConfirmation)) {
    throw new Error(
      `PAYMENTS_ADVANCE_CONFIRMED_BY debe ser ${ADVANCE_CONFIRMATION_VALUES.join(', ')} (o no definirse)`,
    );
  }
  return value as AdvanceConfirmation;
}
