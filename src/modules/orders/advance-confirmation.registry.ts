import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Puerto de OrdersModule hacia quien registra los pagos: responde si el
 * trabajador asignado confirmo la recepcion del anticipo de ESE pedido.
 *
 * Contrato:
 * - Se llama dentro de la transaccion de OrdersService.transition(), con el
 *   pedido ya bloqueado: solo lecturas con `tx`, sin llamar a lockWorker().
 * - true solo si existe, para ese pedido, una confirmacion de ese trabajador
 *   por el monto que corresponde al anticipo.
 */
export interface AdvanceConfirmationVerifier {
  hasValidConfirmation(
    tx: Prisma.TransactionClient,
    input: { orderId: string; workerId: string },
  ): Promise<boolean>;
}

/**
 * PaymentsModule se registra en onModuleInit (mismo patron que los demas
 * puntos de extension): OrdersModule nunca lo importa, asi que no hay ciclos.
 * Mientras nadie se registre, ACORDADO -> ANTICIPO_REGISTRADO se rechaza.
 */
@Injectable()
export class AdvanceConfirmationRegistry {
  private verifier: AdvanceConfirmationVerifier | null = null;

  register(verifier: AdvanceConfirmationVerifier): void {
    if (this.verifier) {
      throw new Error('Ya hay un verificador de confirmaciones de anticipo');
    }
    this.verifier = verifier;
  }

  get(): AdvanceConfirmationVerifier | null {
    return this.verifier;
  }
}
