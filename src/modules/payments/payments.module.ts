//=========================================================
// MODIFICADO: payments.module.ts
// Fase B3 (cancelacion): declara CancellationSummaryService, que captura la
// fotografia economica de un pedido cancelado. No cambia dependencias ni
// exportaciones. Regla: pagos solo registra; no procesa dinero.
//=========================================================
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ServiceWorkflowModule } from '../service-workflow/service-workflow.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { CancellationSummaryService } from './cancellation-summary.service.js';
import { PaymentsConfig } from './payments.config.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsIntegration } from './payments.integration.js';
import { PaymentsService } from './payments.service.js';

/**
 * Pagos y constancias (RF-39 a RF-43). La plataforma no procesa dinero: solo
 * registra las declaraciones de las partes. Usa servicios publicos de
 * OrdersModule (participantes y transition), OffersModule (oferta aceptada),
 * ServiceWorkflowModule (visita, monto con adicionales y puerto del cobro de
 * la visita), WorkerProfileModule y NotificationsModule. Ninguno lo importa:
 * no hay ciclos. Exporta PaymentsService para la linea de tiempo.
 */
@Module({
  imports: [
    PrismaModule,
    OrdersModule,
    OffersModule,
    ServiceWorkflowModule,
    WorkerProfileModule,
    NotificationsModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsConfig,
    PaymentsService,
    CancellationSummaryService,
    PaymentsIntegration,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
