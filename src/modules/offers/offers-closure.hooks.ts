import { Injectable, OnModuleInit } from '@nestjs/common';
import { OfferStatus } from '../../generated/prisma/enums.js';
import { OrderLifecycleRegistry } from '../orders/order-lifecycle.registry.js';
import { AccountStatusRegistry } from '../users/account-status.registry.js';
import { WorkerProfileStatusRegistry } from '../worker-profile/profile-status.registry.js';
import { OfferClosureReason } from './offers.rules.js';
import { OffersService } from './offers.service.js';

/**
 * T6.5.2: cierra las ofertas que un cambio externo deja sin validez, dentro
 * de la transaccion de ese cambio (si el cierre falla, el cambio se revierte):
 * - pedido CANCELADO: sus ofertas VIGENTE quedan SIN_EFECTO;
 * - pedido VENCIDO: sus ofertas VIGENTE quedan VENCIDA;
 * - cuenta suspendida: sus ofertas como trabajador y las recibidas como
 *   cliente quedan SIN_EFECTO;
 * - perfil de trabajador suspendido: sus ofertas quedan SIN_EFECTO.
 *
 * Se registra en los puntos de extension de cada modulo dueno (OrdersModule,
 * UsersModule y WorkerProfileModule), que nunca importan OffersModule: no hay
 * ciclos. Los hooks del pedido no cambian su estado ni bloquean al
 * trabajador (el pedido ya esta bloqueado).
 */
@Injectable()
export class OffersClosureHooks implements OnModuleInit {
  constructor(
    private readonly offers: OffersService,
    private readonly lifecycle: OrderLifecycleRegistry,
    private readonly accountStatus: AccountStatusRegistry,
    private readonly profileStatus: WorkerProfileStatusRegistry,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      name: 'offers:cierre-por-pedido',
      inTransaction: async (event, tx) => {
        if (event.type === 'CANCELADO') {
          await this.offers.closeOpenOffersOfOrder(
            tx,
            event.orderId,
            OfferStatus.SIN_EFECTO,
            OfferClosureReason.PEDIDO_CANCELADO,
          );
        } else if (event.type === 'VENCIDO') {
          await this.offers.closeOpenOffersOfOrder(
            tx,
            event.orderId,
            OfferStatus.VENCIDA,
            OfferClosureReason.PEDIDO_VENCIDO,
          );
        }
      },
    });
    this.accountStatus.register({
      name: 'offers:cuenta-suspendida',
      onSuspended: async (tx, { userId }) => {
        await this.offers.closeOffersOfSuspendedAccount(tx, userId);
      },
    });
    this.profileStatus.register({
      name: 'offers:perfil-suspendido',
      onSuspended: async (tx, { userId }) => {
        await this.offers.closeOffersOfSuspendedProfile(tx, userId);
      },
    });
  }
}
