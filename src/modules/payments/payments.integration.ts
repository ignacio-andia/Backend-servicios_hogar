//=========================================================
// MODIFICADO: payments.integration.ts
// Fase B3 (cancelacion): registra en OrderLifecycleRegistry la captura de la
// fotografia economica (CancellationSummaryService) al evento CANCELADO.
// Necesario para guardarla en la misma transaccion de las dos rutas sin crear
// otro mecanismo de cancelacion ni que OrdersModule dependa de pagos.
// Regla: sin resumen no hay cancelacion; VENCIDO no genera resumen.
//=========================================================
import { Injectable, OnModuleInit } from '@nestjs/common';
import { OfferEventRegistry } from '../offers/offer-events.registry.js';
import { OffersService } from '../offers/offers.service.js';
import { AdvanceConfirmationRegistry } from '../orders/advance-confirmation.registry.js';
import { OrderLifecycleRegistry } from '../orders/order-lifecycle.registry.js';
import { OrdersService } from '../orders/orders.service.js';
import { VisitPaymentRegistry } from '../service-workflow/visit-payment.port.js';
import { CancellationSummaryService } from './cancellation-summary.service.js';
import { PaymentsService } from './payments.service.js';

/**
 * Puntos de integracion de PaymentsModule (se registran en onModuleInit, como
 * el resto del proyecto, para no crear dependencias circulares):
 *
 * 1. VisitPaymentRegistry (ServiceWorkflowModule): implementa el puerto del
 *    cobro de la visita. A registra el hecho operativo y llama a este
 *    registro; aqui se guarda el cobro y su constancia (RF-25, RF-41).
 * 2. OfferEventRegistry (OffersModule): al aceptarse una oferta, emite la
 *    constancia del servicio (RF-41) en la misma transaccion del acuerdo.
 * 3. AdvanceConfirmationRegistry (OrdersModule): responde si el trabajador
 *    asignado confirmo el anticipo; sin eso Orders no registra el anticipo.
 * 4. OrderLifecycleRegistry (OrdersModule): al cancelarse un pedido guarda su
 *    fotografia economica en la misma transaccion; si falla, no se cancela.
 */
@Injectable()
export class PaymentsIntegration implements OnModuleInit {
  constructor(
    private readonly payments: PaymentsService,
    private readonly offers: OffersService,
    private readonly orders: OrdersService,
    private readonly visitPayments: VisitPaymentRegistry,
    private readonly offerEvents: OfferEventRegistry,
    private readonly advanceConfirmations: AdvanceConfirmationRegistry,
    private readonly lifecycle: OrderLifecycleRegistry,
    private readonly cancellationSummaries: CancellationSummaryService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      name: 'payments:resumen-cancelacion',
      inTransaction: async (event, tx) => {
        if (event.type === 'CANCELADO') {
          await this.cancellationSummaries.capture(
            tx,
            event.orderId,
            event.fromStatus,
          );
        }
      },
    });
    this.advanceConfirmations.register({
      hasValidConfirmation: (tx, input) =>
        this.payments.hasValidAdvanceConfirmation(tx, input),
    });
    this.visitPayments.register({
      recordVisitPayment: (tx, payment) =>
        this.payments.recordVisitPayment(tx, payment),
    });
    this.offerEvents.register({
      name: 'payments:constancia-servicio',
      inTransaction: async (event, tx) => {
        if (event.type !== 'ACEPTADA') {
          return;
        }
        const terms = await this.offers.getAcceptedOfferTerms(
          tx,
          event.orderId,
        );
        if (!terms) {
          return;
        }
        // transition() ya asigno al trabajador antes de emitir el evento.
        const order = await this.orders.findOrderSummary(tx, event.orderId);
        if (!order) {
          return;
        }
        await this.payments.ensureServiceReceipt(
          tx,
          event.orderId,
          order,
          terms,
        );
      },
    });
  }
}
