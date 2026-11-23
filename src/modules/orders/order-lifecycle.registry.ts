import { Injectable, Logger } from '@nestjs/common';
import type { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import type { OrderActor } from './order-history.js';

/** Cambios del pedido que pueden interesar a otros modulos. */
export type OrderLifecycleEvent =
  | { type: 'EDITADO'; orderId: string; revision: number; actor: OrderActor }
  | {
      type: 'CANCELADO';
      orderId: string;
      fromStatus: OrderStatus;
      actor: OrderActor;
      reason: string | null;
    }
  // fromStatus: PUBLICADO o EN_NEGOCIACION (T5.1: tambien vence en
  // negociacion; el modulo de ofertas lo usa para cerrar sus ofertas).
  | { type: 'VENCIDO'; orderId: string; fromStatus: OrderStatus };

/**
 * Lo que registra un modulo interesado (ofertas, notificaciones). Ninguno
 * existe todavia: este registro es el punto de integracion.
 */
export interface OrderLifecycleHooks {
  readonly name: string;
  /**
   * Dentro de la transaccion del pedido. Solo escrituras en la BD que deben
   * confirmarse junto con el cambio, por ejemplo dejar las ofertas SIN_EFECTO
   * al cancelar o guardar un aviso interno (RF-33). Si falla, se revierte todo
   * (en VENCIDO solo ese pedido: cada uno corre en su propio SAVEPOINT).
   * El pedido ya esta bloqueado: el hook NO debe llamar a lockWorker()
   * (orden de bloqueos del proyecto: trabajador antes que pedido).
   */
  inTransaction?(
    event: OrderLifecycleEvent,
    tx: Prisma.TransactionClient,
  ): Promise<void>;
  /**
   * Despues de confirmar: efectos fuera de la BD (canales externos futuros).
   * Nunca corre si la transaccion se revirtio. Un fallo se registra en el log
   * y no deshace el pedido.
   */
  afterCommit?(event: OrderLifecycleEvent): Promise<void>;
}

/**
 * Evita la dependencia circular: los modulos futuros importan OrdersModule y
 * registran aqui sus hooks (por ejemplo en onModuleInit); OrdersModule nunca
 * los importa a ellos.
 */
@Injectable()
export class OrderLifecycleRegistry {
  private readonly logger = new Logger(OrderLifecycleRegistry.name);
  private readonly hooks: OrderLifecycleHooks[] = [];

  register(hooks: OrderLifecycleHooks): void {
    if (this.hooks.some((existing) => existing.name === hooks.name)) {
      throw new Error(`Ya hay hooks registrados con el nombre ${hooks.name}`);
    }
    this.hooks.push(hooks);
  }

  async runInTransaction(
    events: OrderLifecycleEvent[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const event of events) {
      for (const hook of this.hooks) {
        await hook.inTransaction?.(event, tx);
      }
    }
  }

  async runAfterCommit(events: OrderLifecycleEvent[]): Promise<void> {
    for (const event of events) {
      for (const hook of this.hooks) {
        try {
          await hook.afterCommit?.(event);
        } catch (error) {
          this.logger.error(
            `Fallo el efecto posterior "${hook.name}" para ${event.type} del pedido ${event.orderId}`,
            error,
          );
        }
      }
    }
  }
}
