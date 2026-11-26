import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { RecommendationsController } from './recommendations.controller.js';
import { RecommendationsService } from './recommendations.service.js';

/**
 * Recomendacion de trabajadores por reputacion, servicios completados y
 * disponibilidad. Lee datos de los modulos duenos (perfiles, pedidos, ofertas)
 * con sus consultas publicas y guarda sus propias tablas. Ninguno lo importa:
 * no hay ciclos.
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    OrdersModule,
    OffersModule,
    WorkerProfileModule,
  ],
  controllers: [RecommendationsController],
  providers: [RecommendationsService],
})
export class RecommendationsModule {}
