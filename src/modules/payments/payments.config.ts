import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeclarer } from './payments.rules.js';

/**
 * Quien confirma la recepcion del anticipo para que el pedido pase a
 * ANTICIPO_REGISTRADO. DECISION FUNCIONAL DEFINITIVA: exclusivamente el
 * trabajador asignado.
 */
export type AdvanceConfirmation = Extract<PaymentDeclarer, 'TRABAJADOR'>;
export const DEFAULT_ADVANCE_CONFIRMATION: AdvanceConfirmation = 'TRABAJADOR';
export const ADVANCE_CONFIRMATION_VALUES: readonly AdvanceConfirmation[] = [
  DEFAULT_ADVANCE_CONFIRMATION,
];

/**
 * Configuracion de PaymentsModule.
 *
 * PAYMENTS_ADVANCE_CONFIRMED_BY: opcional; el unico valor permitido es
 * TRABAJADOR, que tambien es el predeterminado si no se define (o se deja
 * vacio). CLIENTE, AMBOS o cualquier otro valor contradicen la decision
 * funcional y detienen el arranque.
 */
@Injectable()
export class PaymentsConfig {
  readonly advanceConfirmedBy: AdvanceConfirmation;

  constructor(config: ConfigService) {
    this.advanceConfirmedBy = parseAdvanceConfirmation(
      config.get<string>('PAYMENTS_ADVANCE_CONFIRMED_BY'),
    );
  }
}

export function parseAdvanceConfirmation(
  raw: string | undefined,
): AdvanceConfirmation {
  const value = raw?.trim().toUpperCase();
  if (value === undefined || value === '') {
    return DEFAULT_ADVANCE_CONFIRMATION;
  }
  if (!ADVANCE_CONFIRMATION_VALUES.includes(value as AdvanceConfirmation)) {
    throw new Error(
      `PAYMENTS_ADVANCE_CONFIRMED_BY solo admite ${ADVANCE_CONFIRMATION_VALUES.join(', ')} (o no definirse): el anticipo lo confirma exclusivamente el trabajador asignado`,
    );
  }
  return value as AdvanceConfirmation;
}
