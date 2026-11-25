// Reglas del ciclo de vida del trabajo (RF-25 a RF-28, RF-34, RF-36).
// Las marcadas como PENDIENTE no deben cambiarse sin confirmacion del docente.

import { OrderStatus } from '../../generated/prisma/enums.js';

/** RN-10 y RF-28: el cliente tiene 7 dias calendario tras el trabajo terminado. */
export const CONFORMITY_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fin del plazo de conformidad y de reclamo. Se calcula una sola vez al marcar
 * el trabajo como terminado y se guarda (no se recalcula).
 * PENDIENTE DE CONFIRMAR CON EL DOCENTE: "dias calendario" se interpreta como
 * 7 x 24 horas exactas desde `finishedAt` (igual que el vencimiento del
 * pedido, ORDER_EXPIRATION_DAYS). Si significara "hasta el fin del septimo
 * dia en America/La_Paz", solo cambia esta funcion.
 */
export function computeConformityDeadline(finishedAt: Date): Date {
  return new Date(finishedAt.getTime() + CONFORMITY_WINDOW_DAYS * DAY_MS);
}

/** El reclamo es valido mientras ahora < limite. */
export function isWithinConformityWindow(now: Date, deadline: Date): boolean {
  return now.getTime() < deadline.getTime();
}

/** El cierre automatico solo ocurre desde el limite: ahora >= limite. */
export function isConformityWindowOver(now: Date, deadline: Date): boolean {
  return !isWithinConformityWindow(now, deadline);
}

// Longitudes (columnas de la BD).
export const BUDGET_REASON_MAX_LENGTH = 1000;
export const BUDGET_MATERIALS_MAX_LENGTH = 1000;
export const NO_SHOW_DESCRIPTION_MAX_LENGTH = 1000;
export const CANCEL_WORK_REASON_MAX_LENGTH = 500;

/** Monto con hasta 8 enteros y 2 decimales (Decimal(10,2)); > 0 se valida aparte. */
export const BUDGET_AMOUNT_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;
export const BUDGET_AMOUNT_MESSAGE =
  'amount debe ser un monto positivo con hasta 2 decimales';

/** Estados en los que el trabajador puede proponer un adicional (CU-26). */
export const ADDITIONAL_BUDGET_ORIGIN_STATUSES: readonly OrderStatus[] = [
  OrderStatus.VISITA_REALIZADA,
  OrderStatus.EN_EJECUCION,
];

/**
 * Estados en los que el cliente puede reportar que el trabajador no llego
 * (RF-36): hay acuerdo y todavia no hubo visita ni inicio de la ejecucion.
 */
export const NO_SHOW_REPORTABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.ACORDADO,
  OrderStatus.ANTICIPO_REGISTRADO,
];
