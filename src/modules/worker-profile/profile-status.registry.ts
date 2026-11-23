import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/** Suspension administrativa de un perfil de trabajador (APROBADO -> SUSPENDIDO). */
export interface ProfileSuspendedEvent {
  profileId: string;
  userId: string;
  actorId: string;
}

/**
 * Efecto de otro modulo al suspender un perfil. Corre dentro de la
 * transaccion del cambio de estado: si falla, la suspension se revierte.
 */
export interface ProfileSuspensionHook {
  readonly name: string;
  onSuspended(
    tx: Prisma.TransactionClient,
    event: ProfileSuspendedEvent,
  ): Promise<void>;
}

/**
 * T6.5.2: punto de integracion para la suspension del perfil, igual que
 * AccountStatusRegistry para la cuenta. WorkerProfileModule no conoce a los
 * modulos que dependen de el (ofertas): son ellos los que registran aqui sus
 * efectos, por ejemplo en onModuleInit. No agrega estados: solo avisa del
 * cambio APROBADO -> SUSPENDIDO que ya existe.
 *
 * Orden de bloqueos: al llegar a los hooks la fila del perfil (el
 * trabajador) ya esta bloqueada; un hook puede bloquear despues pedidos y
 * ofertas, nunca antes.
 */
@Injectable()
export class WorkerProfileStatusRegistry {
  private readonly hooks = new Map<string, ProfileSuspensionHook>();

  register(hook: ProfileSuspensionHook): void {
    if (this.hooks.has(hook.name)) {
      throw new Error(`Ya hay un efecto registrado con el nombre ${hook.name}`);
    }
    this.hooks.set(hook.name, hook);
  }

  /** De a uno y en orden de registro, con la transaccion del llamador. */
  async runSuspended(
    tx: Prisma.TransactionClient,
    event: ProfileSuspendedEvent,
  ): Promise<void> {
    for (const hook of this.hooks.values()) {
      await hook.onSuspended(tx, event);
    }
  }
}
