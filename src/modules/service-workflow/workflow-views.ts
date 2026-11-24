import type {
  AdditionalBudget,
  AdditionalBudgetStatus,
  NoShowReport,
  OrderExecution,
  OrderVisit,
} from '../../generated/prisma/client.js';

// Vistas HTTP del ciclo de vida del trabajo. Montos como texto decimal; nunca
// incluyen direccion, telefono ni datos privados.

export interface VisitView {
  orderId: string;
  performedAt: Date;
  /** Costo acordado en la oferta (null o "0.00": visita sin costo). */
  visitCost: string | null;
}

export interface AdditionalBudgetView {
  id: string;
  orderId: string;
  amount: string;
  reason: string;
  materials: string;
  status: AdditionalBudgetStatus;
  respondedAt: Date | null;
  createdAt: Date;
}

export interface ExecutionView {
  orderId: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Fin del plazo de 7 dias para confirmar o reclamar (RN-10). */
  conformityDeadline: Date | null;
  conformedAt: Date | null;
}

export interface NoShowView {
  id: string;
  orderId: string;
  description: string | null;
  reportedAt: Date;
}

export function toVisitView(visit: OrderVisit): VisitView {
  return {
    orderId: visit.orderId,
    performedAt: visit.performedAt,
    visitCost: visit.visitCost?.toFixed(2) ?? null,
  };
}

export function toBudgetView(budget: AdditionalBudget): AdditionalBudgetView {
  return {
    id: budget.id,
    orderId: budget.orderId,
    amount: budget.amount.toFixed(2),
    reason: budget.reason,
    materials: budget.materials,
    status: budget.status,
    respondedAt: budget.respondedAt,
    createdAt: budget.createdAt,
  };
}

export function toExecutionView(execution: OrderExecution): ExecutionView {
  return {
    orderId: execution.orderId,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    conformityDeadline: execution.conformityDeadline,
    conformedAt: execution.conformedAt,
  };
}

export function toNoShowView(report: NoShowReport): NoShowView {
  return {
    id: report.id,
    orderId: report.orderId,
    description: report.description,
    reportedAt: report.reportedAt,
  };
}
