import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Puerto de OrdersModule hacia quien lleva las negociaciones: en que pedidos
 * tiene el trabajador una negociacion abierta (RF-13).
 *
 * Contrato:
 * - Solo lecturas con el `db` recibido, sin bloqueos.
 * - hasOpenNegotiation se llama dentro de la transaccion de
 *   OrdersService.transition(), con el trabajador y el pedido ya bloqueados.
 */
export interface OpenNegotiationChecker {
  hasOpenNegotiation(
    tx: Prisma.TransactionClient,
    input: { orderId: string; workerId: string },
  ): Promise<boolean>;
  findOpenOrderIds(
    db: Prisma.TransactionClient,
    workerId: string,
  ): Promise<string[]>;
}

/**
 * OffersModule se registra en onModuleInit (mismo patron que los demas puntos
 * de extension): OrdersModule nunca lo importa, asi que no hay ciclos.
 * Mientras nadie se registre, no hay negociaciones abiertas: toda asignacion
 * cuenta como trabajo nuevo.
 */
@Injectable()
export class OpenNegotiationRegistry {
  private checker: OpenNegotiationChecker | null = null;

  register(checker: OpenNegotiationChecker): void {
    if (this.checker) {
      throw new Error('Ya hay un verificador de negociaciones abiertas');
    }
    this.checker = checker;
  }

  async has(
    tx: Prisma.TransactionClient,
    input: { orderId: string; workerId: string },
  ): Promise<boolean> {
    return (await this.checker?.hasOpenNegotiation(tx, input)) ?? false;
  }

  async openOrderIds(
    db: Prisma.TransactionClient,
    workerId: string,
  ): Promise<string[]> {
    return (await this.checker?.findOpenOrderIds(db, workerId)) ?? [];
  }
}
