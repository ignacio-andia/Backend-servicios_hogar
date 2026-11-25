import { OrderStatus } from '../../generated/prisma/enums.js';
import type { AdvanceConfirmation } from './payments.config.js';
import type { PaymentConcept, PaymentDeclarer } from './payments.rules.js';

// Politicas de pagos aisladas de la logica de persistencia: estados en los que
// se puede declarar cada concepto y que confirmacion es obligatoria. Son las
// unicas reglas que hay que tocar si el docente define algo distinto.

const AFTER_ADVANCE: readonly OrderStatus[] = [
  OrderStatus.ANTICIPO_REGISTRADO,
  OrderStatus.VISITA_REALIZADA,
  OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
  OrderStatus.EN_EJECUCION,
  OrderStatus.TERMINADO,
  OrderStatus.EN_RECLAMO,
  OrderStatus.CERRADO,
];

/**
 * Estados del pedido en los que se acepta una declaracion de cada concepto.
 * - ANTICIPO: desde el acuerdo (CU-39: "El pedido esta Acordado").
 * - VISITA: despues de realizada la visita (CU-25: evalua y cobra).
 * - SALDO: con el trabajo terminado (RF-40: "un trabajo no terminado no
 *   permite confirmar el pago final").
 * Un pedido CANCELADO solo admite la VISITA ya realizada (se exige ademas su
 * registro y un costo): ni anticipo ni saldo; el tratamiento del anticipo al
 * cancelar esta pendiente del docente y aqui no se decide.
 */
export const DECLARABLE_STATUSES: Readonly<
  Record<PaymentConcept, readonly OrderStatus[]>
> = {
  ANTICIPO: [OrderStatus.ACORDADO, ...AFTER_ADVANCE],
  VISITA: [
    OrderStatus.VISITA_REALIZADA,
    OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
    OrderStatus.EN_EJECUCION,
    OrderStatus.TERMINADO,
    OrderStatus.EN_RECLAMO,
    OrderStatus.CERRADO,
    OrderStatus.CANCELADO,
  ],
  SALDO: [OrderStatus.TERMINADO, OrderStatus.EN_RECLAMO, OrderStatus.CERRADO],
};

/**
 * Confirmacion que cada concepto exige (RN-03, RN-04 y la decision funcional
 * del anticipo): siempre la del trabajador asignado. La del cliente ("Ya
 * pagué", RF-42) es complementaria y opcional.
 */
export type RequiredConfirmation = 'TRABAJADOR';

export function requiredConfirmationFor(
  concept: PaymentConcept,
  advanceConfirmedBy: AdvanceConfirmation,
): RequiredConfirmation {
  return concept === 'ANTICIPO' ? advanceConfirmedBy : 'TRABAJADOR';
}

/**
 * true si esta declaracion es la confirmacion de recepcion del anticipo por el
 * trabajador asignado. Una confirmacion debe coincidir con el monto esperado y
 * repetirla es idempotente.
 */
export function isAdvanceReceiptConfirmation(
  concept: PaymentConcept,
  declaredBy: PaymentDeclarer,
  policy: AdvanceConfirmation,
): boolean {
  return concept === 'ANTICIPO' && declaredBy === policy;
}

/** RN-04: la visita se paga en efectivo; el anticipo y el saldo, efectivo o QR. */
export function allowedMethods(
  concept: PaymentConcept,
): readonly ('EFECTIVO' | 'QR')[] {
  return concept === 'VISITA' ? ['EFECTIVO'] : ['EFECTIVO', 'QR'];
}

export const CONCEPT_LABELS: Readonly<Record<PaymentConcept, string>> = {
  ANTICIPO: 'anticipo',
  VISITA: 'visita',
  SALDO: 'saldo',
};
