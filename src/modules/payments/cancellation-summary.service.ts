//=========================================================
// NUEVO: cancellation-summary.service.ts
// Fase B3 (cancelacion): captura y guarda la fotografia economica de un pedido
// DENTRO de la transaccion que lo cancela, con el pedido ya bloqueado. Todas
// las escrituras de pagos, adicionales y ofertas bloquean antes el pedido, asi
// que lo leido no puede cambiar hasta confirmar.
// Si algo falla (o los datos no son coherentes) lanza y se revierte toda la
// cancelacion.
// Reglas: la oferta debe ser de este pedido y estar ACEPTADA; las formulas
// estan en cancellation-summary.ts. Solo lee y registra: no modifica pagos ni
// mueve dinero.
//=========================================================
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import {
  OfferEventType,
  type OrderStatus,
} from '../../generated/prisma/enums.js';
import { OffersService } from '../offers/offers.service.js';
import { ORDER_AGREED_STATUSES } from '../orders/orders.rules.js';
import { OrdersService } from '../orders/orders.service.js';
import { WorkflowQueryService } from '../service-workflow/workflow-query.service.js';
import {
  type CancellationSummaryData,
  summaryWithAgreement,
  summaryWithoutAgreement,
} from './cancellation-summary.js';

type Db = Prisma.TransactionClient;

@Injectable()
export class CancellationSummaryService {
  constructor(
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly workflow: WorkflowQueryService,
  ) {}

  /**
   * Guarda la fotografia del pedido `orderId`, cancelado desde `fromStatus`.
   * Una por pedido (clave primaria): un segundo intento falla.
   */
  async capture(
    tx: Db,
    orderId: string,
    fromStatus: OrderStatus,
  ): Promise<void> {
    const { details, ...amounts } = await this.build(tx, orderId, fromStatus);
    await tx.orderCancellationSummary.create({
      data: {
        orderId,
        ...amounts,
        details: details as unknown as Prisma.InputJsonObject,
      },
    });
  }

  private async build(
    tx: Db,
    orderId: string,
    fromStatus: OrderStatus,
  ): Promise<CancellationSummaryData> {
    // Solo devuelve la oferta de ESTE pedido en estado ACEPTADA.
    const terms = await this.offers.getAcceptedOfferTerms(tx, orderId);
    if (!ORDER_AGREED_STATUSES.includes(fromStatus)) {
      if (terms) {
        throw inconsistent('un pedido sin acuerdo tiene una oferta aceptada');
      }
      return summaryWithoutAgreement();
    }
    if (!terms) {
      throw inconsistent('el pedido con acuerdo no tiene una oferta aceptada');
    }
    const order = await this.orders.findOrderSummary(tx, orderId);
    if (order?.assignedWorkerId !== terms.workerId) {
      throw inconsistent(
        'la oferta aceptada no es del trabajador asignado al pedido',
      );
    }
    const events = await this.offers.listNegotiationEvents(tx, orderId);
    const acceptance = events.find(
      (event) =>
        event.offerId === terms.offerId &&
        event.type === OfferEventType.ACEPTADA,
    );
    const visit = await this.workflow.getVisit(orderId, tx);
    const additionalBudgets = await this.workflow.listAdditionalBudgets(
      orderId,
      tx,
    );
    const payments = await tx.payment.findMany({
      where: { orderId },
      select: {
        id: true,
        concept: true,
        expectedAmount: true,
        declarations: {
          select: {
            id: true,
            declaredBy: true,
            userId: true,
            amount: true,
            method: true,
            createdAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return summaryWithAgreement({
      offerId: terms.offerId,
      workerId: terms.workerId,
      agreedAmount: terms.amount,
      agreedAt: acceptance?.createdAt ?? null,
      agreedVisitCost: terms.requiresVisit ? terms.visitCost : null,
      visit,
      additionalBudgets,
      payments,
    });
  }
}

function inconsistent(detail: string): ConflictException {
  return new ConflictException(
    `No se puede cancelar: ${detail}. No se registró ningún cambio.`,
  );
}
