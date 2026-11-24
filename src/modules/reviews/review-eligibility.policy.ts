import type { OrderStatus } from '../../generated/prisma/enums.js';

/**
 * Politica de elegibilidad para calificar (RF-45). Esta aislada a proposito:
 * los documentos dicen "Terminado o Cerrado" (CU-45) y "Cerrado o con el pago
 * final confirmado" (CU-44), y la definicion final esta pendiente. NO hay un
 * conjunto de estados por defecto: quien arme el modulo debe elegirlo de forma
 * explicita (configuracion o la politica que se defina), y cambiarlo no toca
 * la logica de las reglas inmutables (una por parte y pedido, sin
 * autocalificacion).
 */
export interface ReviewEligibilityPolicy {
  /** null si el pedido puede calificarse; si no, el motivo para mostrar. */
  denialReason(order: { status: OrderStatus }): string | null;
}
export const REVIEW_ELIGIBILITY_POLICY = Symbol('REVIEW_ELIGIBILITY_POLICY');

/** Politica basada en una lista explicita de estados que habilitan calificar. */
export function statusEligibilityPolicy(
  eligibleStatuses: readonly OrderStatus[],
): ReviewEligibilityPolicy {
  if (eligibleStatuses.length === 0) {
    throw new Error(
      'La politica de calificaciones necesita al menos un estado habilitante',
    );
  }
  const eligible = new Set<OrderStatus>(eligibleStatuses);
  return {
    denialReason: (order) =>
      eligible.has(order.status)
        ? null
        : 'Solo se puede calificar un trabajo terminado.',
  };
}
