import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Puerto hacia el registro FINANCIERO de la visita (RF-25, RF-41): lo
 * implementa PaymentsModule (Persona B). ServiceWorkflowModule es dueno del
 * hecho operativo (visita realizada, costo acordado) y de la accion del
 * trabajador "Pago confirmado"; B es dueno del registro del cobro y su
 * constancia (fecha, hora, usuario, monto y metodo EFECTIVO).
 *
 * Contrato:
 * - Se llama DENTRO de la transaccion de A, con el pedido bloqueado.
 * - Debe ser idempotente por pedido: si la visita ya tiene un cobro
 *   registrado, devuelve el existente sin crear otro.
 * - El monto lo fija A (copia del costo de la oferta aceptada): el cliente
 *   no lo envia.
 *
 * PaymentsModule se registra en VisitPaymentRegistry (onModuleInit), igual que
 * los demas puntos de extension del proyecto: asi no hay dependencia circular.
 * Mientras nadie se registre, el endpoint de confirmacion
 * responde 501: no existe una integracion simulada.
 */
export interface VisitPaymentRecorder {
  recordVisitPayment(
    tx: Prisma.TransactionClient,
    payment: {
      orderId: string;
      /** Monto de la visita, en texto decimal (por ejemplo "30.00"). */
      amount: string;
      confirmedByUserId: string;
    },
  ): Promise<void>;
}

@Injectable()
export class VisitPaymentRegistry {
  private recorder: VisitPaymentRecorder | null = null;

  register(recorder: VisitPaymentRecorder): void {
    if (this.recorder) {
      throw new Error('Ya hay un registrador de cobros de visita');
    }
    this.recorder = recorder;
  }

  get(): VisitPaymentRecorder | null {
    return this.recorder;
  }
}
