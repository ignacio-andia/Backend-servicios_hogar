import {
  ClaimPriority,
  ClaimStatus,
  type Prisma,
} from '../../generated/prisma/client.js';

const HOUR_MS = 60 * 60 * 1000;

/** RN-2: horas de plazo por prioridad. */
export const PRIORITY_SLA_HOURS: Readonly<Record<ClaimPriority, number>> = {
  URGENTE: 24,
  ALTA: 48,
  MEDIA: 72,
  BAJA: 120,
};

/** RN-4: tope de una fecha limite manual. */
export const MAX_DUE_DAYS = 30;

/** RN-6: estados que cuentan como pendientes. */
export const PENDING_CLAIM_STATUSES: ClaimStatus[] = [
  ClaimStatus.ABIERTO,
  ClaimStatus.EN_REVISION,
];

export const CLAIM_SITUATIONS = ['PENDIENTE', 'VENCIDO', 'EN_PLAZO'] as const;
export type ClaimSituation = (typeof CLAIM_SITUATIONS)[number];

export function defaultDueAt(priority: ClaimPriority, from: Date): Date {
  return new Date(from.getTime() + PRIORITY_SLA_HOURS[priority] * HOUR_MS);
}

/** RN-4: null si la fecha es valida; si no, el mensaje de error. */
export function dueAtError(dueAt: Date, now: Date): string | null {
  if (Number.isNaN(dueAt.getTime())) {
    return 'dueAt no es una fecha valida.';
  }
  if (dueAt.getTime() <= now.getTime()) {
    return 'La fecha limite debe ser posterior a la fecha actual.';
  }
  if (dueAt.getTime() > now.getTime() + MAX_DUE_DAYS * 24 * HOUR_MS) {
    return `La fecha limite no puede superar los ${MAX_DUE_DAYS} dias.`;
  }
  return null;
}

/** RN-6: un reclamo resuelto nunca esta vencido. */
export function isOverdue(
  claim: { status: ClaimStatus; dueAt: Date },
  now: Date,
): boolean {
  return (
    PENDING_CLAIM_STATUSES.includes(claim.status) &&
    claim.dueAt.getTime() < now.getTime()
  );
}

/** RN-6 traducida a un filtro de Prisma. */
export function situationWhere(
  situation: ClaimSituation,
  now: Date,
): Prisma.ClaimWhereInput {
  const pending = { status: { in: PENDING_CLAIM_STATUSES } };
  switch (situation) {
    case 'PENDIENTE':
      return pending;
    case 'VENCIDO':
      return { ...pending, dueAt: { lt: now } };
    case 'EN_PLAZO':
      return { ...pending, dueAt: { gte: now } };
  }
}