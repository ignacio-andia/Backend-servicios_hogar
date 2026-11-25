import { Injectable, OnModuleInit } from '@nestjs/common';
import { OpenNegotiationRegistry } from '../orders/open-negotiation.registry.js';
import { countOpenOffers, findOpenOfferOrderIds } from './open-offers.js';

/**
 * Responde a OrdersModule (RF-13) en que pedidos tiene el trabajador una
 * negociacion abierta, es decir, una oferta vigente. Asi aceptar una oferta
 * existente no se confunde con recibir trabajo nuevo, y el pedido que esta
 * negociando se le sigue mostrando.
 */
@Injectable()
export class OffersOpenNegotiationSource implements OnModuleInit {
  constructor(private readonly registry: OpenNegotiationRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      hasOpenNegotiation: async (tx, { orderId, workerId }) =>
        (await countOpenOffers(tx, { orderId, workerId })) > 0,
      findOpenOrderIds: findOpenOfferOrderIds,
    });
  }
}
