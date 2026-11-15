import {
  OrderActorType,
  OrderStatus,
  RoleName,
} from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';

/** Quien provoca un cambio de estado: un usuario o un proceso del sistema. */
export type OrderActor =
  | { type: 'USUARIO'; userId: string; role: RoleName }
  | { type: 'SISTEMA'; process: string };

export function clientActor(userId: string): OrderActor {
  return { type: 'USUARIO', userId, role: RoleName.CLIENTE };
}

/** Datos del historial segun el actor (el CHECK de la BD exige esta forma). */
export function historyActorData(actor: OrderActor) {
  return actor.type === 'USUARIO'
    ? {
        actorType: OrderActorType.USUARIO,
        changedById: actor.userId,
        actorRole: actor.role,
        systemProcess: null,
      }
    : {
        actorType: OrderActorType.SISTEMA,
        changedById: null,
        actorRole: null,
        systemProcess: actor.process,
      };
}

export async function recordStatusChange(
  tx: Prisma.TransactionClient,
  change: {
    orderId: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    actor: OrderActor;
    reason?: string | null;
  },
): Promise<void> {
  await tx.orderStatusHistory.create({
    data: {
      orderId: change.orderId,
      fromStatus: change.fromStatus,
      toStatus: change.toStatus,
      reason: change.reason ?? null,
      ...historyActorData(change.actor),
    },
  });
}
