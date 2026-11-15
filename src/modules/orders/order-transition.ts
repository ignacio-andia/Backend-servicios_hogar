import { OrderStatus } from '../../generated/prisma/enums.js';
import type { OrderActor } from './order-history.js';
import type {
  OrderAgreedStatus,
  OrderAssignmentTarget,
  OrderInternalTarget,
} from './orders.rules.js';

/**
 * Contrato tipado de OrdersService.transition() para los modulos de flujo
 * (ofertas, pagos, visitas, agenda, reclamos). Las combinaciones invalidas no
 * compilan:
 * - CANCELADO y VENCIDO no son destinos publicos (cancel() y vencimiento).
 * - ACORDADO exige `assignWorkerId` (el trabajador se asigna al aceptar).
 * - Los demas estados con acuerdo conservan al trabajador ya asignado: no
 *   aceptan asignar ni liberar.
 * - Los estados sin acuerdo no aceptan asignar; pueden liberar.
 * Las reglas de negocio (transiciones permitidas, RN-14, concurrencia) se
 * validan en tiempo de ejecucion y responden 403/404/409.
 */
export type OrderTransitionTarget = Exclude<OrderStatus, OrderInternalTarget>;

interface OrderTransitionBase {
  orderId: string;
  /** Si se indica, el estado actual debe coincidir (si no, 409). */
  from?: OrderStatus;
  actor: OrderActor;
  reason?: string | null;
}

/** Al aceptar una oferta: asigna el trabajador en la misma operacion. */
export interface AssignWorkerTransition extends OrderTransitionBase {
  to: OrderAssignmentTarget;
  assignWorkerId: string;
  releaseWorker?: never;
}

/** Entre estados con acuerdo: el trabajador asignado se conserva. */
export interface KeepWorkerTransition extends OrderTransitionBase {
  to: Exclude<OrderAgreedStatus, OrderAssignmentTarget>;
  assignWorkerId?: never;
  releaseWorker?: never;
}

/** Hacia estados sin acuerdo: nunca asigna; puede liberar al trabajador. */
export interface WithoutWorkerTransition extends OrderTransitionBase {
  to: Exclude<OrderTransitionTarget, OrderAgreedStatus>;
  assignWorkerId?: never;
  releaseWorker?: boolean;
}

export type OrderTransitionRequest =
  AssignWorkerTransition | KeepWorkerTransition | WithoutWorkerTransition;

export interface OrderTransitionResult {
  fromStatus: OrderStatus;
  toStatus: OrderTransitionTarget;
  assignedWorkerId: string | null;
}

/**
 * Uso invalido de transition() por parte de otro modulo (un error de
 * programacion, no del usuario final). No es una HttpException a proposito:
 * termina como 500 y queda en el log para corregir al llamador. El tipado de
 * OrderTransitionRequest evita casi todos estos casos en compilacion; esta
 * clase cubre llamadas con conversiones de tipo o invariantes rotos.
 */
export class OrderTransitionUsageError extends Error {
  override readonly name = 'OrderTransitionUsageError';
}
