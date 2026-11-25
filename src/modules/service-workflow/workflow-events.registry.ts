import { Injectable, Logger } from '@nestjs/common';
import type { OrderStatus, Prisma } from '../../generated/prisma/client.js';

/**
 * Hechos del ciclo de vida del trabajo que otros modulos pueden necesitar
 * (por ejemplo, notificaciones internas, RF-33, o las constancias de B).
 * Los datos son identificadores y estados: nunca direccion ni telefono.
 */
export type WorkflowEvent =
  | { type: 'VISITA_REGISTRADA'; orderId: string; workerId: string }
  | { type: 'TRABAJO_INICIADO'; orderId: string; workerId: string }
  | {
      type: 'ADICIONAL_PROPUESTO';
      orderId: string;
      budgetId: string;
      workerId: string;
    }
  | { type: 'ADICIONAL_ACEPTADO'; orderId: string; budgetId: string }
  | { type: 'ADICIONAL_RECHAZADO'; orderId: string; budgetId: string }
  | {
      type: 'TRABAJO_TERMINADO';
      orderId: string;
      workerId: string;
      conformityDeadline: Date;
    }
  | { type: 'CONFORMIDAD_CONFIRMADA'; orderId: string }
  | { type: 'CIERRE_POR_PLAZO'; orderId: string }
  | { type: 'INASISTENCIA_REPORTADA'; orderId: string; workerId: string }
  | { type: 'RECLAMO_PRESENTADO'; orderId: string; claimId: string }
  | { type: 'RECLAMO_EN_REVISION'; orderId: string; claimId: string }
  | {
      type: 'RECLAMO_RESUELTO';
      orderId: string;
      claimId: string;
      closedFrom: OrderStatus;
    };

export interface WorkflowHooks {
  readonly name: string;
  /**
   * Dentro de la transaccion del hecho: si falla, se revierte todo (asi un
   * aviso nunca queda sin su evento ni al reves). El pedido ya esta
   * bloqueado: NO llamar a lockWorker().
   */
  inTransaction?(
    event: WorkflowEvent,
    tx: Prisma.TransactionClient,
  ): Promise<void>;
  /** Despues de confirmar; un fallo se registra y no deshace nada. */
  afterCommit?(event: WorkflowEvent): Promise<void>;
}

/**
 * Punto de integracion (mismo patron que OrderLifecycleRegistry): los modulos
 * interesados lo importan y registran sus hooks en onModuleInit;
 * ServiceWorkflowModule nunca los importa a ellos (sin ciclos). Mientras nadie
 * registre un hook de notificaciones, los eventos no generan avisos.
 */
@Injectable()
export class WorkflowEventRegistry {
  private readonly logger = new Logger(WorkflowEventRegistry.name);
  private readonly hooks: WorkflowHooks[] = [];

  register(hooks: WorkflowHooks): void {
    if (this.hooks.some((existing) => existing.name === hooks.name)) {
      throw new Error(`Ya hay hooks registrados con el nombre ${hooks.name}`);
    }
    this.hooks.push(hooks);
  }

  async runInTransaction(
    events: WorkflowEvent[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const event of events) {
      for (const hook of this.hooks) {
        await hook.inTransaction?.(event, tx);
      }
    }
  }

  async runAfterCommit(events: WorkflowEvent[]): Promise<void> {
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
