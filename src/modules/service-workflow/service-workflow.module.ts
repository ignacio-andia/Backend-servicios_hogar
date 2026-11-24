import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { ConformityClosureService } from './conformity-closure.service.js';
import { ServiceWorkflowController } from './service-workflow.controller.js';
import { ServiceWorkflowService } from './service-workflow.service.js';
import { VisitPaymentRegistry } from './visit-payment.port.js';
import { WorkflowInvariantHooks } from './workflow-invariants.hooks.js';
import { WorkflowEventRegistry } from './workflow-events.registry.js';
import { WorkflowQueryService } from './workflow-query.service.js';

/**
 * Ciclo de vida del trabajo: visita, presupuesto adicional, ejecucion,
 * conformidad, cancelacion e inasistencia (RF-25 a RF-28, RF-34, RF-36).
 * Usa servicios publicos de OrdersModule (transition, cancelAgreedWork),
 * OffersModule (condiciones de la oferta aceptada) y WorkerProfileModule.
 * Ninguno lo importa: no hay ciclos. Exporta WorkflowQueryService (consultas)
 * y WorkflowEventRegistry (hooks transaccionales para notificaciones y
 * constancias). PaymentsModule registra su implementacion en VisitPaymentRegistry.
 */
@Module({
  imports: [PrismaModule, OrdersModule, OffersModule, WorkerProfileModule],
  controllers: [ServiceWorkflowController],
  providers: [
    ServiceWorkflowService,
    WorkflowQueryService,
    WorkflowEventRegistry,
    VisitPaymentRegistry,
    ConformityClosureService,
    WorkflowInvariantHooks,
  ],
  exports: [WorkflowQueryService, WorkflowEventRegistry, VisitPaymentRegistry],
})
export class ServiceWorkflowModule {}
