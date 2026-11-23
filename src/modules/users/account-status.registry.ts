import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/** Suspension de una cuenta por un administrador (PATCH /users/:id/status). */
export interface AccountSuspendedEvent {
  userId: string;
  actorId: string;
}

/**
 * Efecto de otro modulo al suspender una cuenta. Se ejecuta dentro de la
 * transaccion del cambio de estado: si falla, la suspension se revierte.
 */
export interface AccountSuspensionHook {
  readonly name: string;
  onSuspended(
    tx: Prisma.TransactionClient,
    event: AccountSuspendedEvent,
  ): Promise<void>;
}

/**
 * Punto de integracion sin dependencias circulares: UsersModule no conoce a
 * los modulos que dependen de el (perfiles de trabajador, pedidos); son ellos
 * los que registran aqui sus efectos, por ejemplo en onModuleInit (T4-F3).
 *
 * Orden de bloqueos del proyecto: la cuenta (users) va primero. Al llegar a
 * los hooks la fila de la cuenta ya esta bloqueada por el UPDATE de estado;
 * un hook puede bloquear despues al trabajador, el pedido y los catalogos.
 */
@Injectable()
export class AccountStatusRegistry {
  private readonly hooks = new Map<string, AccountSuspensionHook>();

  register(hook: AccountSuspensionHook): void {
    if (this.hooks.has(hook.name)) {
      throw new Error(`Ya hay un efecto registrado con el nombre ${hook.name}`);
    }
    this.hooks.set(hook.name, hook);
  }

  /** De a uno y en orden de registro, con la transaccion del llamador. */
  async runSuspended(
    tx: Prisma.TransactionClient,
    event: AccountSuspendedEvent,
  ): Promise<void> {
    for (const hook of this.hooks.values()) {
      await hook.onSuspended(tx, event);
    }
  }
}
