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
 * Un pedido CANCELADO no admite declaraciones: el tratamiento del anticipo al
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
  ],
  SALDO: [OrderStatus.TERMINADO, OrderStatus.EN_RECLAMO, OrderStatus.CERRADO],
};

/**
 * Confirmacion que cada concepto exige (RN-03, RN-04). La del cliente
 * ("Ya pagué", RF-42) es siempre complementaria y opcional. Para el anticipo
 * la definicion esta pendiente del docente.
 */
export type RequiredConfirmation = 'TRABAJADOR' | 'PENDIENTE_DEFINICION';

export function requiredConfirmationFor(
  concept: PaymentConcept,
  advanceConfirmedBy: AdvanceConfirmation | null,
): RequiredConfirmation | 'CLIENTE' | 'AMBOS' {
  if (concept === 'ANTICIPO') {
    return advanceConfirmedBy ?? 'PENDIENTE_DEFINICION';
  }
  return 'TRABAJADOR';
}

/**
 * true si, con las declaraciones existentes, la politica configurada considera
 * recibido el anticipo. Sin politica (null) nunca: la transicion automatica
 * esta desactivada hasta que el docente defina quien confirma.
 */
export function advanceConfirmationSatisfied(
  policy: AdvanceConfirmation | null,
  declaredBy: readonly PaymentDeclarer[],
): boolean {
  if (policy === null) {
    return false;
  }
  if (policy === 'AMBOS') {
    return declaredBy.includes('CLIENTE') && declaredBy.includes('TRABAJADOR');
  }
  return declaredBy.includes(policy);
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
