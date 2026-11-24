import type { Prisma } from '../../../generated/prisma/client.js';

// Contratos que PaymentsModule NECESITA de otros modulos. Son solo interfaces
// y tokens de inyeccion: NO hay implementacion por defecto ni simulada. Cada
// contrato lo implementa su modulo propietario (ver
// docs/persona-b/CONTRATOS_Y_PRISMA.md). Si un lector no esta registrado, la
// funcionalidad que lo necesita responde PENDIENTE_INTEGRACION o falla; nunca
// inventa un valor. El contrato de participantes del pedido es compartido y
// vive en src/common/contracts/order-participants.reader.ts.

type Db = Prisma.TransactionClient;

/** Contrato 3: terminos de la oferta aceptada (propietario: OffersModule). */
export interface AcceptedAgreement {
  orderId: string;
  workerId: string;
  /** Monto de la oferta aceptada: base del anticipo del 25%. */
  amount: Prisma.Decimal;
  requiresVisit: boolean;
  /** null si no hay visita; 0 es una visita gratis. */
  visitCost: Prisma.Decimal | null;
}
export interface AcceptedAgreementReader {
  /** null si el pedido no tiene oferta aceptada. */
  findAcceptedAgreement(
    db: Db,
    orderId: string,
  ): Promise<AcceptedAgreement | null>;
}
export const ACCEPTED_AGREEMENT_READER = Symbol('ACCEPTED_AGREEMENT_READER');

/** Contrato 4: presupuestos adicionales (propietario: Persona A). */
export interface AdditionalBudgetsReader {
  /** Suma de los presupuestos adicionales ACEPTADOS por el cliente. */
  sumAcceptedAmounts(db: Db, orderId: string): Promise<Prisma.Decimal>;
}
export const ADDITIONAL_BUDGETS_READER = Symbol('ADDITIONAL_BUDGETS_READER');
