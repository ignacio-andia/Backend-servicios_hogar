import type { Prisma } from '../../generated/prisma/client.js';
import {
  type PaymentDeclarer,
  type PaymentMethod,
  toMoney,
  type MoneyInput,
} from './payments.rules.js';

/**
 * Declaracion de una parte sobre un pago. Cada una es una afirmacion
 * independiente (RF-40, RF-42): una no completa ni sustituye a la otra.
 */
export interface DeclarationFact {
  declaredBy: PaymentDeclarer;
  amount: MoneyInput;
  method: PaymentMethod;
}

/**
 * Comparacion INFORMATIVA de las declaraciones. No es una regla de
 * conciliacion ni habilita ningun cambio de estado: las reglas definitivas
 * (pagos parciales, quien confirma el anticipo, diferencias) estan pendientes
 * de definicion. Los nombres evitan "conciliado" a proposito.
 */
export type DeclarationComparison =
  | 'SIN_DECLARACIONES'
  | 'SOLO_CLIENTE'
  | 'SOLO_TRABAJADOR'
  | 'MONTOS_COINCIDEN'
  | 'MONTOS_DIFERENTES';

export interface DeclarationSummary {
  comparison: DeclarationComparison;
  clientAmount: Prisma.Decimal | null;
  workerAmount: Prisma.Decimal | null;
  /** worker - client; solo si ambas declararon. Informativo. */
  difference: Prisma.Decimal | null;
  /** Solo si ambas declararon; informativo. */
  methodsMatch: boolean | null;
}

/**
 * Resume las declaraciones de un pago. Lanza si hay mas de una por parte: la
 * BD lo impide (unica por pago y parte) y aqui se vuelve a verificar.
 */
export function summarizeDeclarations(
  declarations: readonly DeclarationFact[],
): DeclarationSummary {
  const byParty = new Map<PaymentDeclarer, DeclarationFact>();
  for (const declaration of declarations) {
    if (byParty.has(declaration.declaredBy)) {
      throw new Error(
        `Hay mas de una declaracion de ${declaration.declaredBy} para el mismo pago`,
      );
    }
    byParty.set(declaration.declaredBy, declaration);
  }
  const client = byParty.get('CLIENTE');
  const worker = byParty.get('TRABAJADOR');
  const clientAmount = client ? toMoney(client.amount) : null;
  const workerAmount = worker ? toMoney(worker.amount) : null;

  if (!client && !worker) {
    return {
      comparison: 'SIN_DECLARACIONES',
      clientAmount,
      workerAmount,
      difference: null,
      methodsMatch: null,
    };
  }
  if (client && !worker) {
    return {
      comparison: 'SOLO_CLIENTE',
      clientAmount,
      workerAmount,
      difference: null,
      methodsMatch: null,
    };
  }
  if (worker && !client) {
    return {
      comparison: 'SOLO_TRABAJADOR',
      clientAmount,
      workerAmount,
      difference: null,
      methodsMatch: null,
    };
  }
  const difference = workerAmount!.minus(clientAmount!);
  return {
    comparison: difference.isZero() ? 'MONTOS_COINCIDEN' : 'MONTOS_DIFERENTES',
    clientAmount,
    workerAmount,
    difference,
    methodsMatch: client!.method === worker!.method,
  };
}
