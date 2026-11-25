import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ServiceWorkflowModule } from '../service-workflow/service-workflow.module.js';
import { TimelineController } from './timeline.controller.js';
import { TimelineSourceRegistry } from './timeline-source.registry.js';
import { TimelineService } from './timeline.service.js';
import {
  ClaimsTimelineSource,
  OffersTimelineSource,
  OrdersTimelineSource,
  PaymentsTimelineSource,
  TimelineSourcesIntegration,
  WorkflowTimelineSource,
} from './timeline.sources.js';

/**
 * Seguimiento del pedido (RF-32). Consume los servicios publicos de
 * OrdersModule (historial de estados), OffersModule (negociacion),
 * ServiceWorkflowModule (visita, adicionales, ejecucion) y PaymentsModule
 * (constancias). Los reclamos se derivan del historial del pedido. Ninguno lo
 * importa: no hay ciclos. No lee tablas de otros modulos.
 */
@Module({
  imports: [
    PrismaModule,
    OrdersModule,
    OffersModule,
    ServiceWorkflowModule,
    PaymentsModule,
  ],
  controllers: [TimelineController],
  providers: [
    TimelineSourceRegistry,
    TimelineService,
    OrdersTimelineSource,
    ClaimsTimelineSource,
    OffersTimelineSource,
    WorkflowTimelineSource,
    PaymentsTimelineSource,
    TimelineSourcesIntegration,
  ],
  exports: [TimelineSourceRegistry],
})
export class TimelineModule {}
