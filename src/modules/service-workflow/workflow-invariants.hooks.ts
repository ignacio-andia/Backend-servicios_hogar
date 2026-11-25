import { ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import {
  AdditionalBudgetStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import {
  OrderActorType,
  OrderStatus,
  RoleName,
} from '../../generated/prisma/enums.js';
import { OffersService } from '../offers/offers.service.js';
import {
  OrderLifecycleRegistry,
  type OrderTransitionAttempt,
} from '../orders/order-lifecycle.registry.js';
import { OrdersService } from '../orders/orders.service.js';
import { CONFORMITY_CLOSURE_PROCESS, dbClock } from './workflow-support.js';
import { isConformityWindowOver } from './workflow.rules.js';

type Db = Prisma.TransactionClient;

/**
 * Invariantes del ciclo de vida del trabajo que NINGUN llamador de
 * OrdersService.transition() puede saltarse (por ejemplo PaymentsModule), y
 * limpieza de presupuestos adicionales al cancelar. Se registra en
 * OrderLifecycleRegistry (OrdersModule nunca importa este modulo).
 *
 * - VISITA_REALIZADA exige el registro de la visita y una oferta con visita.
 * - EN_EJECUCION: desde ANTICIPO_REGISTRADO solo si la oferta NO requiere
 *   visita; desde VISITA_REALIZADA exige la visita registrada; desde
 *   PRESUPUESTO_ADICIONAL_PENDIENTE exige que el adicional ya este respondido.
 * - PRESUPUESTO_ADICIONAL_PENDIENTE exige exactamente un adicional PENDIENTE.
 * - TERMINADO exige el registro de ejecucion con su fecha de fin y plazo,
 *   ningun adicional pendiente y que lo declare el trabajador asignado.
 * - CERRADO desde PRESUPUESTO_ADICIONAL_PENDIENTE (RF-27) exige un adicional
 *   RECHAZADO, ninguno pendiente y que lo declare el cliente del pedido.
 * - CERRADO desde TERMINADO exige que el trabajo haya terminado y una de dos
 *   (RF-28): la conformidad registrada y declarada por el cliente del pedido, o
 *   el cierre automatico del sistema con el plazo vencido y sin conformidad.
 *
 * Las transiciones que cumplen sus invariantes (las de este modulo) escriben
 * su registro ANTES de llamar a transition(). La confirmacion del anticipo la
 * exige OrdersService. Las de otros modulos (por
 * ejemplo ACORDADO -> ANTICIPO_REGISTRADO de pagos) no tienen restriccion
 * adicional.
 */
@Injectable()
export class WorkflowInvariantHooks implements OnModuleInit {
  constructor(
    private readonly lifecycle: OrderLifecycleRegistry,
    private readonly offers: OffersService,
    private readonly orders: OrdersService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      name: 'workflow:invariantes',
      beforeTransition: (attempt, tx) => this.check(attempt, tx),
      // Cancelar el trabajo deja sin efecto un adicional pendiente: ya no
      // puede aceptarse. El pedido esta bloqueado: no se bloquea al trabajador.
      inTransaction: async (event, tx) => {
        if (event.type === 'CANCELADO') {
          await tx.additionalBudget.updateMany({
            where: {
              orderId: event.orderId,
              status: AdditionalBudgetStatus.PENDIENTE,
            },
            data: { status: AdditionalBudgetStatus.SIN_EFECTO_POR_CANCELACION },
          });
        }
      },
    });
  }

  private async check(
    { orderId, fromStatus, toStatus, actor }: OrderTransitionAttempt,
    tx: Db,
  ): Promise<void> {
    switch (toStatus) {
      case OrderStatus.VISITA_REALIZADA: {
        this.assert(
          orderId,
          toStatus,
          (await this.requiresVisit(tx, orderId)) &&
            (await tx.orderVisit.count({ where: { orderId } })) === 1,
          'la oferta debe requerir visita y la visita debe estar registrada',
        );
        return;
      }
      case OrderStatus.EN_EJECUCION: {
        if (fromStatus === OrderStatus.ANTICIPO_REGISTRADO) {
          this.assert(
            orderId,
            toStatus,
            !(await this.requiresVisit(tx, orderId)),
            'la oferta requiere visita: debe registrarse antes de iniciar',
          );
        } else if (fromStatus === OrderStatus.VISITA_REALIZADA) {
          this.assert(
            orderId,
            toStatus,
            (await tx.orderVisit.count({ where: { orderId } })) === 1,
            'la visita no esta registrada',
          );
        } else if (fromStatus === OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE) {
          this.assert(
            orderId,
            toStatus,
            (await this.pendingBudgets(tx, orderId)) === 0,
            'el presupuesto adicional todavia esta pendiente',
          );
        }
        return;
      }
      case OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE:
        this.assert(
          orderId,
          toStatus,
          (await this.pendingBudgets(tx, orderId)) === 1,
          'debe existir exactamente un presupuesto adicional pendiente',
        );
        return;
      case OrderStatus.TERMINADO: {
        const execution = await tx.orderExecution.findUnique({
          where: { orderId },
          select: { finishedAt: true, conformityDeadline: true },
        });
        this.assert(
          orderId,
          toStatus,
          execution?.finishedAt != null &&
            execution.conformityDeadline != null &&
            (await this.pendingBudgets(tx, orderId)) === 0,
          'falta el registro de ejecucion con su fecha de fin y plazo, o hay un adicional pendiente',
        );
        const order = await this.orders.findOrderSummary(tx, orderId);
        this.assert(
          orderId,
          toStatus,
          actor.type === OrderActorType.USUARIO &&
            actor.role === RoleName.TRABAJADOR &&
            actor.userId === order?.assignedWorkerId,
          'solo el trabajador asignado declara el trabajo terminado',
        );
        return;
      }
      case OrderStatus.CERRADO: {
        if (fromStatus === OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE) {
          const order = await this.orders.findOrderSummary(tx, orderId);
          const rejected = await tx.additionalBudget.count({
            where: { orderId, status: AdditionalBudgetStatus.RECHAZADO },
          });
          this.assert(
            orderId,
            toStatus,
            actor.type === OrderActorType.USUARIO &&
              actor.role === RoleName.CLIENTE &&
              actor.userId === order?.clientId &&
              rejected > 0 &&
              (await this.pendingBudgets(tx, orderId)) === 0,
            'falta el rechazo del presupuesto adicional por el cliente',
          );
        } else if (fromStatus === OrderStatus.TERMINADO) {
          const execution = await tx.orderExecution.findUnique({
            where: { orderId },
            select: {
              finishedAt: true,
              conformityDeadline: true,
              conformedAt: true,
            },
          });
          this.assert(
            orderId,
            toStatus,
            execution?.finishedAt != null,
            'el trabajo no tiene registro de ejecucion terminada',
          );
          let closable = false;
          if (actor.type === OrderActorType.USUARIO) {
            const order = await this.orders.findOrderSummary(tx, orderId);
            closable =
              execution?.conformedAt != null &&
              actor.role === RoleName.CLIENTE &&
              actor.userId === order?.clientId;
          } else if (
            actor.process === CONFORMITY_CLOSURE_PROCESS &&
            execution?.conformedAt == null &&
            execution?.conformityDeadline != null
          ) {
            closable = isConformityWindowOver(
              await dbClock(tx),
              execution.conformityDeadline,
            );
          }
          this.assert(
            orderId,
            toStatus,
            closable,
            'falta la conformidad del cliente o el cierre automatico con el plazo vencido',
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private assert(
    orderId: string,
    toStatus: OrderStatus,
    condition: boolean,
    reason: string,
  ): void {
    if (!condition) {
      throw new ConflictException(
        `No se puede pasar el pedido ${orderId} a ${toStatus}: ${reason}.`,
      );
    }
  }

  private async requiresVisit(tx: Db, orderId: string): Promise<boolean> {
    const terms = await this.offers.getAcceptedOfferTerms(tx, orderId);
    return terms?.requiresVisit ?? false;
  }

  private pendingBudgets(tx: Db, orderId: string): Promise<number> {
    return tx.additionalBudget.count({
      where: { orderId, status: AdditionalBudgetStatus.PENDIENTE },
    });
  }
}
