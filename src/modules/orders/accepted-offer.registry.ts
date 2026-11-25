import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Puerto de OrdersModule hacia quien lleva las ofertas: responde si el
 * trabajador tiene la oferta ACEPTADA de ESE pedido.
 *
 * Contrato:
 * - Se llama dentro de la transaccion de OrdersService.transition(), con el
 *   trabajador y el pedido ya bloqueados: solo lecturas con `tx`.
 * - El llamador de transition() marca la oferta ACEPTADA antes de pedir
 *   ACORDADO, en la misma transaccion.
 */
export interface AcceptedOfferVerifier {
  hasAcceptedOffer(
    tx: Prisma.TransactionClient,
    input: { orderId: string; workerId: string },
  ): Promise<boolean>;
}

/**
 * OffersModule se registra en onModuleInit (mismo patron que los demas puntos
 * de extension): OrdersModule nunca lo importa, asi que no hay ciclos.
 * Mientras nadie se registre, ningun pedido pasa a ACORDADO.
 */
@Injectable()
export class AcceptedOfferRegistry {
  private verifier: AcceptedOfferVerifier | null = null;

  register(verifier: AcceptedOfferVerifier): void {
    if (this.verifier) {
      throw new Error('Ya hay un verificador de ofertas aceptadas');
    }
    this.verifier = verifier;
  }

  async has(
    tx: Prisma.TransactionClient,
    input: { orderId: string; workerId: string },
  ): Promise<boolean> {
    return (await this.verifier?.hasAcceptedOffer(tx, input)) ?? false;
  }
}
