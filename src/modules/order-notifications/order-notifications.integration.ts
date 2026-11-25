import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  NotificationResourceType,
  NotificationType,
  OfferEventType,
  RoleName,
} from '../../generated/prisma/enums.js';
import {
  type NewNotification,
  NotificationsService,
} from '../notifications/notifications.service.js';
import {
  OfferEventRegistry,
  type OfferNegotiationEvent,
} from '../offers/offer-events.registry.js';
import { OffersService } from '../offers/offers.service.js';
import { OfferClosureReason } from '../offers/offers.rules.js';
import {
  OrderLifecycleRegistry,
  type OrderLifecycleEvent,
} from '../orders/order-lifecycle.registry.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  type WorkflowEvent,
  WorkflowEventRegistry,
} from '../service-workflow/workflow-events.registry.js';

type Db = Prisma.TransactionClient;

const CLOSING_OFFER_EVENTS: readonly OfferEventType[] = [
  OfferEventType.ACEPTADA,
  OfferEventType.RECHAZADA,
  OfferEventType.RETIRADA,
  OfferEventType.VENCIDA,
  // Por ejemplo, las ofertas que perdieron al aceptarse otra.
  OfferEventType.SIN_EFECTO,
];

// Cierres que provoca el propio evento del pedido: el hook de OffersModule
// corre antes que este, en la misma transaccion, y esas ofertas seguian
// abiertas cuando el pedido se cancelo o vencio.
const ORDER_EVENT_CLOSURE_REASONS: readonly string[] = [
  OfferClosureReason.PEDIDO_CANCELADO,
  OfferClosureReason.PEDIDO_VENCIDO,
];

const pedido = (id: string) => ({
  type: NotificationResourceType.PEDIDO,
  id,
});

/**
 * Avisos internos de los eventos reales (RF-33; especificacion v1.0 §6). Se
 * registra en los puntos de extension de OrdersModule, ServiceWorkflowModule
 * y OffersModule al iniciar, y NO queda ningun evento sin hook:
 *
 * - OrderLifecycleRegistry: CANCELADO, VENCIDO.
 * - WorkflowEventRegistry: los 11 eventos del ciclo de vida y los reclamos.
 * - OfferEventRegistry: oferta nueva, contraoferta, aceptada, rechazada,
 *   retirada y vencida.
 * Los avisos de pagos y calificaciones los crean PaymentsService y
 * ReviewsService en su propia transaccion.
 *
 * Todos los hooks son `inTransaction`: guardan el aviso con el `tx` del hecho
 * (si falla, se revierte el hecho entero) y no hacen llamadas externas ni
 * llaman a lockWorker(): el pedido ya esta bloqueado. Los textos no incluyen
 * direccion, telefono ni datos privados.
 */
@Injectable()
export class OrderNotificationsIntegration implements OnModuleInit {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly lifecycle: OrderLifecycleRegistry,
    private readonly workflowEvents: WorkflowEventRegistry,
    private readonly offerEvents: OfferEventRegistry,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      name: 'notifications:pedido',
      inTransaction: (event, tx) => this.onOrderEvent(event, tx),
    });
    this.workflowEvents.register({
      name: 'notifications:flujo-de-trabajo',
      inTransaction: (event, tx) => this.onWorkflowEvent(event, tx),
    });
    this.offerEvents.register({
      name: 'notifications:ofertas',
      inTransaction: (event, tx) => this.onOfferEvent(event, tx),
    });
  }

  // --- Pedido: cancelacion y vencimiento -------------------------------------

  async onOrderEvent(event: OrderLifecycleEvent, tx: Db): Promise<void> {
    if (event.type !== 'CANCELADO' && event.type !== 'VENCIDO') {
      return;
    }
    const order = await this.orders.findOrderSummary(tx, event.orderId);
    if (!order) {
      return;
    }
    const actorId =
      event.type === 'CANCELADO' && event.actor.type === 'USUARIO'
        ? event.actor.userId
        : null;
    // Trabajadores con una oferta que seguia abierta o ya aceptada, y el
    // trabajador asignado.
    const workers = new Set<string>(
      await this.openOfferWorkers(tx, event.orderId),
    );
    if (order.assignedWorkerId) {
      workers.add(order.assignedWorkerId);
    }
    const cancelled = event.type === 'CANCELADO';
    const resource = pedido(event.orderId);
    const recipients: [string, NewNotification][] = [
      ...[...workers].map((workerId): [string, NewNotification] => [
        workerId,
        {
          type: cancelled
            ? NotificationType.PEDIDO_CANCELADO
            : NotificationType.PEDIDO_VENCIDO,
          title: cancelled ? 'Pedido cancelado' : 'Pedido vencido',
          message: cancelled
            ? 'El cliente canceló un pedido en el que participabas.'
            : 'Venció un pedido en el que participabas.',
          resource,
        },
      ]),
      [
        order.clientId,
        {
          type: cancelled
            ? NotificationType.PEDIDO_CANCELADO
            : NotificationType.PEDIDO_VENCIDO,
          title: cancelled ? 'Pedido cancelado' : 'Pedido vencido',
          message: cancelled
            ? 'Tu pedido fue cancelado.'
            : 'Tu pedido venció sin acuerdo.',
          resource,
        },
      ],
    ];
    await this.send(tx, recipients, actorId);
  }

  /** Trabajadores cuya oferta seguia abierta cuando ocurrio el evento del pedido. */
  private async openOfferWorkers(tx: Db, orderId: string): Promise<string[]> {
    const events = await this.offers.listNegotiationEvents(tx, orderId);
    const byOffer = new Map<string, { workerId: string; closed: boolean }>();
    for (const event of events) {
      const entry = byOffer.get(event.offerId) ?? {
        workerId: event.workerId,
        closed: false,
      };
      if (
        CLOSING_OFFER_EVENTS.includes(event.type) &&
        !ORDER_EVENT_CLOSURE_REASONS.includes(event.reason ?? '')
      ) {
        entry.closed = true;
      }
      byOffer.set(event.offerId, entry);
    }
    return [
      ...new Set(
        [...byOffer.values()]
          .filter((entry) => !entry.closed)
          .map((entry) => entry.workerId),
      ),
    ];
  }

  // --- Ciclo de vida del trabajo y reclamos -----------------------------------

  async onWorkflowEvent(event: WorkflowEvent, tx: Db): Promise<void> {
    const order = await this.orders.findOrderSummary(tx, event.orderId);
    if (!order) {
      return;
    }
    const { clientId } = order;
    const workerId = order.assignedWorkerId;
    const resource = pedido(event.orderId);
    const toClient = (
      type: NotificationType,
      title: string,
      message: string,
    ): [string, NewNotification][] => [
      [clientId, { type, title, message, resource }],
    ];
    const toWorker = (
      type: NotificationType,
      title: string,
      message: string,
    ): [string, NewNotification][] =>
      workerId ? [[workerId, { type, title, message, resource }]] : [];

    switch (event.type) {
      case 'VISITA_REGISTRADA':
        return this.send(
          tx,
          toClient(
            NotificationType.VISITA_REGISTRADA,
            'Visita realizada',
            'El trabajador registró la visita a tu pedido.',
          ),
          null,
        );
      case 'TRABAJO_INICIADO':
        return this.send(
          tx,
          toClient(
            NotificationType.TRABAJO_INICIADO,
            'Trabajo iniciado',
            'El trabajador inició la ejecución de tu pedido.',
          ),
          null,
        );
      case 'ADICIONAL_PROPUESTO':
        return this.send(
          tx,
          toClient(
            NotificationType.PRESUPUESTO_ADICIONAL_PROPUESTO,
            'Presupuesto adicional',
            'El trabajador propuso un presupuesto adicional. Debes aceptarlo para que el trabajo continúe.',
          ),
          null,
        );
      case 'ADICIONAL_ACEPTADO':
        return this.send(
          tx,
          toWorker(
            NotificationType.PRESUPUESTO_ADICIONAL_ACEPTADO,
            'Presupuesto adicional aceptado',
            'El cliente aceptó tu presupuesto adicional. Puedes continuar el trabajo.',
          ),
          null,
        );
      case 'ADICIONAL_RECHAZADO':
        return this.send(
          tx,
          toWorker(
            NotificationType.PRESUPUESTO_ADICIONAL_RECHAZADO,
            'Presupuesto adicional rechazado',
            'El cliente rechazó tu presupuesto adicional: el trabajo se detuvo y el pedido se cerró. Solo queda pendiente el cobro de la visita, si corresponde.',
          ),
          null,
        );
      case 'TRABAJO_TERMINADO':
        return this.send(
          tx,
          toClient(
            NotificationType.TRABAJO_TERMINADO,
            'Trabajo terminado',
            `El trabajador marcó el trabajo como terminado. Tienes hasta el ${event.conformityDeadline.toISOString().slice(0, 10)} para confirmar la conformidad o presentar un reclamo.`,
          ),
          null,
        );
      case 'CONFORMIDAD_CONFIRMADA':
        return this.send(
          tx,
          toWorker(
            NotificationType.CONFORMIDAD_CONFIRMADA,
            'Conformidad confirmada',
            'El cliente confirmó la conformidad del trabajo.',
          ),
          null,
        );
      case 'CIERRE_POR_PLAZO':
        return this.send(
          tx,
          [
            ...toClient(
              NotificationType.PEDIDO_CERRADO_POR_PLAZO,
              'Pedido cerrado',
              'Se cumplió el plazo de 7 días y el pedido se cerró.',
            ),
            ...toWorker(
              NotificationType.PEDIDO_CERRADO_POR_PLAZO,
              'Pedido cerrado',
              'Se cumplió el plazo de 7 días sin reclamo y el pedido se cerró.',
            ),
          ],
          null,
        );
      case 'INASISTENCIA_REPORTADA':
        await this.send(
          tx,
          toWorker(
            NotificationType.INASISTENCIA_REPORTADA,
            'Inasistencia reportada',
            'El cliente reportó que no asististe al trabajo. Solo se registra el hecho.',
          ),
          null,
        );
        await this.notifyAdmins(tx, {
          type: NotificationType.INASISTENCIA_REPORTADA,
          title: 'Inasistencia reportada',
          message:
            'Un cliente reportó la inasistencia del trabajador de un pedido.',
          resource,
        });
        return;
      case 'RECLAMO_PRESENTADO':
        await this.send(
          tx,
          toWorker(
            NotificationType.RECLAMO_PRESENTADO,
            'Reclamo presentado',
            'El cliente presentó un reclamo sobre el trabajo. Un administrador lo revisará.',
          ),
          null,
        );
        await this.notifyAdmins(tx, {
          type: NotificationType.RECLAMO_PRESENTADO,
          title: 'Nuevo reclamo',
          message: 'Hay un nuevo reclamo pendiente de revisión.',
          resource: {
            type: NotificationResourceType.RECLAMO,
            id: event.claimId,
          },
        });
        return;
      case 'RECLAMO_EN_REVISION':
        return this.send(
          tx,
          toClient(
            NotificationType.RECLAMO_EN_REVISION,
            'Reclamo en revisión',
            'Un administrador está revisando tu reclamo.',
          ),
          null,
        );
      case 'RECLAMO_RESUELTO':
        return this.send(
          tx,
          [
            ...toClient(
              NotificationType.RECLAMO_RESUELTO,
              'Reclamo resuelto',
              'Un administrador registró la decisión sobre el reclamo.',
            ),
            ...toWorker(
              NotificationType.RECLAMO_RESUELTO,
              'Reclamo resuelto',
              'Un administrador registró la decisión sobre el reclamo del pedido.',
            ),
          ],
          null,
        );
    }
  }

  // --- Ofertas y negociacion --------------------------------------------------

  async onOfferEvent(event: OfferNegotiationEvent, tx: Db): Promise<void> {
    const resource = {
      type: NotificationResourceType.OFERTA,
      id: event.offerId,
    };
    const amount = event.amount ? ` (Bs ${event.amount})` : '';
    const note = (
      userId: string,
      type: NotificationType,
      title: string,
      message: string,
    ): [string, NewNotification][] => [
      [userId, { type, title, message, resource }],
    ];
    switch (event.type) {
      case 'PROPUESTA':
        return this.send(
          tx,
          note(
            event.clientId,
            NotificationType.OFERTA_RECIBIDA,
            'Nueva oferta',
            `Recibiste una nueva oferta para tu pedido${amount}.`,
          ),
          event.actorId,
        );
      case 'CONTRAOFERTA': {
        const toClient = event.actorId !== event.clientId;
        return this.send(
          tx,
          note(
            toClient ? event.clientId : event.workerId,
            NotificationType.CONTRAOFERTA_RECIBIDA,
            'Nueva contraoferta',
            `${toClient ? 'El trabajador' : 'El cliente'} respondió con una contraoferta${amount}.`,
          ),
          event.actorId,
        );
      }
      case 'ACEPTADA':
        return this.send(
          tx,
          note(
            event.workerId,
            NotificationType.OFERTA_ACEPTADA,
            'Oferta aceptada',
            'El cliente aceptó tu oferta. El trabajo quedó acordado.',
          ),
          event.actorId,
        );
      case 'RECHAZADA':
        return this.send(
          tx,
          note(
            event.workerId,
            NotificationType.OFERTA_RECHAZADA,
            'Oferta rechazada',
            'El cliente rechazó tu oferta.',
          ),
          event.actorId,
        );
      case 'RETIRADA':
        return this.send(
          tx,
          note(
            event.clientId,
            NotificationType.OFERTA_RETIRADA,
            'Oferta retirada',
            'Un trabajador retiró su oferta.',
          ),
          event.actorId,
        );
      case 'VENCIDA':
        return this.send(
          tx,
          [
            ...note(
              event.clientId,
              NotificationType.OFERTA_VENCIDA,
              'Oferta vencida',
              'Una oferta de tu pedido venció sin respuesta.',
            ),
            ...note(
              event.workerId,
              NotificationType.OFERTA_VENCIDA,
              'Oferta vencida',
              'Tu oferta venció sin respuesta.',
            ),
          ],
          null,
        );
    }
  }

  // --- Envio ------------------------------------------------------------------

  /** Guarda los avisos con el `tx` del hecho; quien origino el hecho no recibe uno. */
  private async send(
    tx: Db,
    recipients: readonly [string, NewNotification][],
    actorId: string | null,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const [userId, notification] of recipients) {
      if (userId === actorId || seen.has(userId)) {
        continue;
      }
      seen.add(userId);
      await this.notifications.create(userId, notification, tx);
    }
  }

  private async notifyAdmins(
    tx: Db,
    notification: NewNotification,
  ): Promise<void> {
    await this.notifications.createForRole(
      RoleName.ADMINISTRADOR,
      notification,
      {},
      tx,
    );
  }
}
