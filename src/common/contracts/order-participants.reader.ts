import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderStatus } from '../../generated/prisma/enums.js';

type Db = Prisma.TransactionClient;

// Contrato compartido por pagos, resenas y linea de tiempo. Lo implementa su
// propietario (OrdersModule, Persona A); aqui solo existe la interfaz y el
// token de inyeccion. No hay implementacion por defecto ni simulada: si no
// esta registrada, la inyeccion falla en lugar de inventar permisos.

/** Participantes y estado del pedido. */
export interface OrderParticipants {
  orderId: string;
  clientId: string;
  assignedWorkerId: string | null;
  status: OrderStatus;
}

export interface OrderParticipantsReader {
  /** null si el pedido no existe. Solo lectura, con la transaccion del llamador. */
  findParticipants(db: Db, orderId: string): Promise<OrderParticipants | null>;
}

export const ORDER_PARTICIPANTS_READER = Symbol('ORDER_PARTICIPANTS_READER');
