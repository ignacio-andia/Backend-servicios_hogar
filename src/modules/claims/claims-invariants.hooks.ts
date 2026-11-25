import { ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { ClaimStatus, OrderStatus } from '../../generated/prisma/client.js';
import { OrderLifecycleRegistry } from '../orders/order-lifecycle.registry.js';

/**
 * Invariantes de reclamos para OrdersService.transition(): ningun llamador
 * puede dejar un pedido EN_RECLAMO sin reclamo, ni cerrarlo desde EN_RECLAMO
 * sin que el reclamo este RESUELTO (con su decision). ClaimsService escribe el
 * reclamo ANTES de llamar a transition().
 */
@Injectable()
export class ClaimsInvariantHooks implements OnModuleInit {
  constructor(private readonly lifecycle: OrderLifecycleRegistry) {}

  onModuleInit(): void {
    this.lifecycle.register({
      name: 'claims:invariantes',
      beforeTransition: async ({ orderId, fromStatus, toStatus }, tx) => {
        if (toStatus === OrderStatus.EN_RECLAMO) {
          const claim = await tx.claim.findUnique({
            where: { orderId },
            select: { status: true },
          });
          if (claim?.status !== ClaimStatus.ABIERTO) {
            throw new ConflictException(
              `No se puede pasar el pedido ${orderId} a EN_RECLAMO sin un reclamo abierto.`,
            );
          }
        } else if (
          fromStatus === OrderStatus.EN_RECLAMO &&
          toStatus === OrderStatus.CERRADO
        ) {
          const claim = await tx.claim.findUnique({
            where: { orderId },
            select: { status: true, decision: true },
          });
          if (claim?.status !== ClaimStatus.RESUELTO || !claim.decision) {
            throw new ConflictException(
              `No se puede cerrar el pedido ${orderId} en reclamo sin la decision del administrador.`,
            );
          }
        }
      },
    });
  }
}
