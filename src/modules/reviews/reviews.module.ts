import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ServiceWorkflowModule } from '../service-workflow/service-workflow.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { ReviewsConfig } from './reviews.config.js';
import { ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

/**
 * Calificaciones mutuas y perfil publico del trabajador (RF-44 a RF-46). Usa
 * servicios publicos de OrdersModule (participantes del pedido),
 * WorkerProfileModule (perfil publico) y NotificationsModule. Ninguno lo
 * importa: no hay ciclos. Los estados que habilitan calificar son
 * configurables (REVIEWS_ELIGIBLE_STATUSES) y no tienen valor por defecto.
 */
@Module({
  imports: [
    PrismaModule,
    OrdersModule,
    ServiceWorkflowModule,
    WorkerProfileModule,
    NotificationsModule,
  ],
  controllers: [ReviewsController],
  providers: [ReviewsConfig, ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
