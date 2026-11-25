import type { OrderStatus } from '../../generated/prisma/enums.js';

/**
 * Politica de elegibilidad para calificar (RF-45). Esta aislada a proposito:
 * los documentos dicen "Terminado o Cerrado" (CU-45) y "Cerrado o con el pago
 * final confirmado" (CU-44), y la definicion final esta pendiente del docente.
 * NO hay un conjunto de estados por defecto: se configura de forma explicita
 * (REVIEWS_ELIGIBLE_STATUSES) y, mientras no se configure, las calificaciones
 * quedan deshabilitadas. Cambiarlo no toca las reglas inmutables (una por
 * parte y pedido, sin autocalificacion).
 */
export interface ReviewEligibilityPolicy {
  /** Estados habilitantes configurados (vacio: calificaciones deshabilitadas). */
  readonly eligibleStatuses: readonly OrderStatus[];
  /** null si el pedido puede calificarse; si no, el motivo para mostrar. */
  denialReason(order: { status: OrderStatus }): string | null;
}

export const REVIEW_DISABLED_MESSAGE =
  'Las calificaciones todavía no están habilitadas.';
export const REVIEW_NOT_FINISHED_MESSAGE =
  'Solo se puede calificar un trabajo terminado.';

/** Politica basada en una lista explicita de estados que habilitan calificar. */
export function statusEligibilityPolicy(
  eligibleStatuses: readonly OrderStatus[],
): ReviewEligibilityPolicy {
  const eligible = new Set<OrderStatus>(eligibleStatuses);
  return {
    eligibleStatuses: [...eligible],
    denialReason: (order) => {
      if (eligible.size === 0) {
        return REVIEW_DISABLED_MESSAGE;
      }
      return eligible.has(order.status) ? null : REVIEW_NOT_FINISHED_MESSAGE;
    },
  };
}
