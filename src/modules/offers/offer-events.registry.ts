import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Hechos de la negociacion que otros modulos pueden necesitar (RF-33: avisos
 * internos de nueva oferta, acuerdo, rechazo, retiro y vencimiento). Solo
 * identificadores, ronda y monto: nunca direccion ni telefono.
 */
export type OfferNegotiationEvent =
  | OfferEventBase<'PROPUESTA' | 'CONTRAOFERTA'>
  | OfferEventBase<'ACEPTADA' | 'RECHAZADA' | 'RETIRADA' | 'VENCIDA'>;

interface OfferEventBase<T extends string> {
  type: T;
  offerId: string;
  orderId: string;
  workerId: string;
  clientId: string;
  /** Quien provoco el hecho; null si fue un proceso del sistema (VENCIDA). */
  actorId: string | null;
  round: number;
  /** Monto vigente en PROPUESTA y CONTRAOFERTA; null en los cierres. */
  amount: string | null;
}

export interface OfferEventHooks {
  readonly name: string;
  /**
   * Dentro de la transaccion del hecho, con el pedido ya bloqueado: si falla,
   * se revierte todo, asi un aviso nunca queda sin su evento ni al reves.
   * Solo escrituras en la BD (con `tx`); NO debe hacer llamadas externas ni
   * llamar a lockWorker() (orden de bloqueos: trabajador antes que pedido).
   */
  inTransaction(
    event: OfferNegotiationEvent,
    tx: Prisma.TransactionClient,
  ): Promise<void>;
}

/**
 * Punto de integracion (mismo patron que OrderLifecycleRegistry): los modulos
 * interesados lo importan y registran sus hooks en onModuleInit; OffersModule
 * nunca los importa a ellos (sin ciclos). Sin hooks registrados no pasa nada.
 */
@Injectable()
export class OfferEventRegistry {
  private readonly hooks: OfferEventHooks[] = [];

  register(hooks: OfferEventHooks): void {
    if (this.hooks.some((existing) => existing.name === hooks.name)) {
      throw new Error(`Ya hay hooks registrados con el nombre ${hooks.name}`);
    }
    this.hooks.push(hooks);
  }

  get hasHooks(): boolean {
    return this.hooks.length > 0;
  }

  async runInTransaction(
    events: readonly OfferNegotiationEvent[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const event of events) {
      for (const hook of this.hooks) {
        await hook.inTransaction(event, tx);
      }
    }
  }
}
