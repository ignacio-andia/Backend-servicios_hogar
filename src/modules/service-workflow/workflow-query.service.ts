import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AdditionalBudgetStatus,
  type OrderStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OffersService } from '../offers/offers.service.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  AdditionalBudgetView,
  ExecutionView,
  NoShowView,
  toBudgetView,
  toExecutionView,
  toNoShowView,
  toVisitView,
  VisitView,
} from './workflow-views.js';

type Db = Prisma.TransactionClient;

/** Monto acordado del trabajo (RN-02, RN-05). Textos decimales. */
export interface AgreedAmount {
  /** Monto de la oferta aceptada. */
  baseAmount: string;
  /** Suma de los presupuestos adicionales ACEPTADOS. */
  acceptedAdditional: string;
  /** baseAmount + acceptedAdditional. */
  totalAmount: string;
}

export interface WorkflowView {
  orderId: string;
  status: OrderStatus;
  visit: VisitView | null;
  additionalBudgets: AdditionalBudgetView[];
  execution: ExecutionView | null;
  noShowReport: NoShowView | null;
}

/**
 * Consultas publicas de solo lectura de ServiceWorkflowModule. Es la API que
 * consumen otros modulos (pagos, calificaciones, agenda, seguimiento): nadie
 * debe leer las tablas de visita, adicionales o ejecucion directamente.
 * Todos los metodos aceptan el cliente `db` de la transaccion del llamador.
 */
@Injectable()
export class WorkflowQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: OffersService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Monto acordado = oferta aceptada + adicionales aceptados. El trabajador
   * no puede cambiarlo (RN-05). Null si el pedido no tiene oferta aceptada.
   * Nota para pagos (RN-02): la base del anticipo del 25% es el "monto
   * acordado"; si debe incluir o no los adicionales lo confirma el docente
   * (el anticipo se registra antes de que exista un adicional).
   */
  async getAgreedAmount(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<AgreedAmount | null> {
    const terms = await this.offers.getAcceptedOfferTerms(db, orderId);
    if (!terms) {
      return null;
    }
    const { _sum } = await db.additionalBudget.aggregate({
      where: { orderId, status: AdditionalBudgetStatus.ACEPTADO },
      _sum: { amount: true },
    });
    const additional = _sum.amount ?? new Prisma.Decimal(0);
    return {
      baseAmount: terms.amount.toFixed(2),
      acceptedAdditional: additional.toFixed(2),
      totalAmount: terms.amount.plus(additional).toFixed(2),
    };
  }

  async getVisit(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<VisitView | null> {
    const visit = await db.orderVisit.findUnique({ where: { orderId } });
    return visit ? toVisitView(visit) : null;
  }

  async listAdditionalBudgets(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<AdditionalBudgetView[]> {
    const budgets = await db.additionalBudget.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return budgets.map(toBudgetView);
  }

  /**
   * RF-27: el pedido se cerro porque el cliente rechazo un presupuesto
   * adicional (el trabajo no se termino).
   */
  async hasRejectedBudget(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<boolean> {
    return (
      (await db.additionalBudget.count({
        where: { orderId, status: AdditionalBudgetStatus.RECHAZADO },
      })) > 0
    );
  }

  async getExecution(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<ExecutionView | null> {
    const execution = await db.orderExecution.findUnique({
      where: { orderId },
    });
    return execution ? toExecutionView(execution) : null;
  }

  /**
   * Reporte de inasistencia del pedido (RF-36), para TimelineModule. Solo
   * lectura; el llamador ya decidio el permiso.
   */
  async getNoShowReport(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<NoShowView | null> {
    const report = await db.noShowReport.findUnique({ where: { orderId } });
    return report ? toNoShowView(report) : null;
  }

  /** El trabajo se marco como terminado alguna vez (aunque luego se cierre o reclame). */
  async hasWorkFinished(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const execution = await db.orderExecution.findUnique({
      where: { orderId },
      select: { finishedAt: true },
    });
    return execution?.finishedAt != null;
  }

  /** Fin del plazo de conformidad o reclamo; null si aun no termino. */
  async getConformityDeadline(
    orderId: string,
    db: Db = this.prisma,
  ): Promise<Date | null> {
    const execution = await db.orderExecution.findUnique({
      where: { orderId },
      select: { conformityDeadline: true },
    });
    return execution?.conformityDeadline ?? null;
  }

  /**
   * Estado del flujo de un pedido para su cliente o su trabajador asignado.
   * Cualquier otro usuario (o un pedido inexistente) recibe 404.
   */
  async getWorkflowFor(userId: string, orderId: string): Promise<WorkflowView> {
    const participation = await this.orders.findParticipation(
      this.prisma,
      userId,
      orderId,
    );
    if (!participation) {
      throw new NotFoundException('El pedido no existe');
    }
    const [visit, additionalBudgets, execution, noShow] = await Promise.all([
      this.getVisit(orderId),
      this.listAdditionalBudgets(orderId),
      this.getExecution(orderId),
      this.prisma.noShowReport.findUnique({ where: { orderId } }),
    ]);
    return {
      orderId,
      status: participation.status,
      visit,
      additionalBudgets,
      execution,
      noShowReport: noShow ? toNoShowView(noShow) : null,
    };
  }
}
