import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountStatusRegistry } from '../users/account-status.registry.js';
import { ZoneChangeRequestsService } from './zone-change-requests.service.js';

/**
 * T4-F3: al suspender una cuenta de usuario se cancela su solicitud de cambio
 * de zona pendiente, en la misma transaccion que la suspension. Se registra
 * aqui para no crear una dependencia circular: WorkerProfileModule importa
 * UsersModule, no al reves.
 */
@Injectable()
export class ZoneRequestsAccountSuspensionHook implements OnModuleInit {
  constructor(
    private readonly accountStatus: AccountStatusRegistry,
    private readonly zoneRequests: ZoneChangeRequestsService,
  ) {}

  onModuleInit(): void {
    this.accountStatus.register({
      name: 'worker-profile:solicitudes-de-cambio-de-zona',
      onSuspended: async (tx, { userId, actorId }) => {
        await this.zoneRequests.cancelPendingOnAccountSuspension(
          tx,
          actorId,
          userId,
        );
      },
    });
  }
}
