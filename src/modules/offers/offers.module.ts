import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { CatalogsModule } from '../catalogs/catalogs.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { UsersModule } from '../users/users.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { OfferEventRegistry } from './offer-events.registry.js';
import { OfferExpirationService } from './offer-expiration.service.js';
import { OffersClosureHooks } from './offers-closure.hooks.js';
import { OffersController } from './offers.controller.js';
import { OffersService } from './offers.service.js';

/**
 * Ofertas y negociacion (RF-19 a RF-24). T6.2: creacion y consultas; T6.3:
 * contraofertas; T6.4: rechazo, retiro y aceptacion; T6.5.1: vencimiento
 * automatico (OfferExpirationService); T6.5.2: cierres por pedido cancelado o
 * vencido y por suspension de cuenta o perfil (OffersClosureHooks). Usa los servicios publicos de OrdersModule (visibilidad y
 * bloqueo del pedido), WorkerProfileModule (ApprovedWorkerGuard y
 * lockApprovedWorker), UsersModule (cuenta del cliente) y CatalogsModule. Ninguno de ellos
 * importa este modulo: no hay ciclos. La fuente OFERTAS de
 * WorkerActiveWorkRegistry no se registra (no debe habilitar cambios de zona).
 */
@Module({
  imports: [
    PrismaModule,
    UsersModule,
    CatalogsModule,
    OrdersModule,
    WorkerProfileModule,
  ],
  controllers: [OffersController],
  providers: [
    OffersService,
    OfferExpirationService,
    OffersClosureHooks,
    OfferEventRegistry,
  ],
  exports: [OffersService, OfferEventRegistry],
})
export class OffersModule {}
