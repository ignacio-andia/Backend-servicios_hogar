import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ServiceWorkflowModule } from '../service-workflow/service-workflow.module.js';
import { OrderNotificationsIntegration } from './order-notifications.integration.js';

/**
 * Avisos internos de los eventos de pedidos, ofertas y flujo de trabajo
 * (RF-33). Solo registra hooks en los puntos de extension de OrdersModule,
 * OffersModule y ServiceWorkflowModule, que nunca lo importan: no hay ciclos.
 * Sin endpoints propios: se consultan con NotificationsModule.
 */
@Module({
  imports: [
    NotificationsModule,
    OrdersModule,
    OffersModule,
    ServiceWorkflowModule,
  ],
  providers: [OrderNotificationsIntegration],
})
export class OrderNotificationsModule {}
