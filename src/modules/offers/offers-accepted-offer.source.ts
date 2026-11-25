import { Injectable, OnModuleInit } from '@nestjs/common';
import { OfferStatus } from '../../generated/prisma/enums.js';
import { AcceptedOfferRegistry } from '../orders/accepted-offer.registry.js';

/**
 * Responde a OrdersModule si el trabajador tiene la oferta ACEPTADA de un
 * pedido: es la condicion para asignarlo y pasar el pedido a ACORDADO.
 */
@Injectable()
export class OffersAcceptedOfferSource implements OnModuleInit {
  constructor(private readonly registry: AcceptedOfferRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      hasAcceptedOffer: async (tx, { orderId, workerId }) =>
        (await tx.offer.count({
          where: { orderId, workerId, status: OfferStatus.ACEPTADA },
        })) > 0,
    });
  }
}
