import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from '../worker-profile/active-work.registry.js';
import { ACTIVE_ORDER_STATUSES } from './orders.rules.js';

/**
 * Aporta a WorkerProfileModule (RF-13) cuantos pedidos activos tiene asignados
 * un trabajador. "Activo" lo define OrdersModule en ACTIVE_ORDER_STATUSES
 * (PENDIENTE DE CONFIRMAR CON EL DOCENTE). Se registra aqui para no crear una
 * dependencia circular: OrdersModule importa WorkerProfileModule, no al reves.
 */
@Injectable()
export class OrdersActiveWorkSource implements OnModuleInit {
  constructor(private readonly registry: WorkerActiveWorkRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      kind: ActiveWorkKind.PEDIDOS,
      // Usa la transaccion del llamador: el conteo y la decision van juntos.
      countActive: (workerUserId, db) =>
        db.order.count({
          where: {
            assignedWorkerId: workerUserId,
            status: { in: [...ACTIVE_ORDER_STATUSES] },
          },
        }),
    });
  }
}
