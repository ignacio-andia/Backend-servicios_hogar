import { RoleName } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderActor } from '../orders/order-history.js';

/**
 * Hora de la BD en este instante (clock_timestamp, no la de inicio de la
 * transaccion): todas las ventanas de tiempo se deciden DENTRO del bloqueo del
 * pedido y con este reloj, para que reclamo y cierre no se pisen.
 */
export async function dbClock(db: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`
    SELECT clock_timestamp() AS now`;
  return now;
}

export function workerActor(userId: string): OrderActor {
  return { type: 'USUARIO', userId, role: RoleName.TRABAJADOR };
}

export function adminActor(userId: string): OrderActor {
  return { type: 'USUARIO', userId, role: RoleName.ADMINISTRADOR };
}

/** Proceso del sistema que cierra el pedido al vencer el plazo (RF-28). */
export const CONFORMITY_CLOSURE_PROCESS = 'CIERRE_CONFORMIDAD';
