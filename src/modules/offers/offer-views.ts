import {
  OfferEventType,
  OfferParty,
  OfferStatus,
  OrderActorType,
  RoleName,
} from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';

// Ninguna vista incluye la direccion exacta, las fotos ni los datos de
// contacto: solo la oferta, su historial y el pedido por su identificador.

/** Campos de la oferta que ven el trabajador y el cliente. */
export const OFFER_SELECT = {
  id: true,
  orderId: true,
  workerId: true,
  status: true,
  round: true,
  amount: true,
  turn: true,
  requiresVisit: true,
  visitCost: true,
  materialsIncluded: true,
  proposedStartAt: true,
  estimatedDurationMinutes: true,
  expiresAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OfferSelect;

/** Para el cliente: ademas, el nombre del trabajador (sin contacto). */
export const RECEIVED_OFFER_SELECT = {
  ...OFFER_SELECT,
  worker: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.OfferSelect;

export const OFFER_EVENT_SELECT = {
  type: true,
  round: true,
  amount: true,
  actorType: true,
  changedById: true,
  actorRole: true,
  systemProcess: true,
  reason: true,
  createdAt: true,
} satisfies Prisma.OfferEventSelect;

type OfferRow = Prisma.OfferGetPayload<{ select: typeof OFFER_SELECT }>;
type ReceivedOfferRow = Prisma.OfferGetPayload<{
  select: typeof RECEIVED_OFFER_SELECT;
}>;
type OfferEventRow = Prisma.OfferEventGetPayload<{
  select: typeof OFFER_EVENT_SELECT;
}>;

export interface OfferView {
  id: string;
  orderId: string;
  /** Estado efectivo: una VIGENTE con la vigencia cumplida es VENCIDA. */
  status: OfferStatus;
  round: number;
  amount: string;
  turn: OfferParty;
  requiresVisit: boolean;
  /** null si no requiere visita; "0.00" si la visita es gratis. */
  visitCost: string | null;
  materialsIncluded: boolean;
  proposedStartAt: Date;
  estimatedDurationMinutes: number;
  expiresAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReceivedOfferView extends OfferView {
  worker: { id: string; firstName: string; lastName: string };
}

export interface OfferEventView {
  type: OfferEventType;
  round: number;
  amount: string | null;
  actorType: OrderActorType;
  changedById: string | null;
  actorRole: RoleName | null;
  systemProcess: string | null;
  reason: string | null;
  createdAt: Date;
}

export type OfferDetail<T extends OfferView> = T & {
  /** RF-21: historial completo, del mas antiguo al mas reciente. */
  history: OfferEventView[];
};

export interface PaginatedOffers<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export function effectiveOfferStatus(
  offer: { status: OfferStatus; expiresAt: Date },
  now: Date,
): OfferStatus {
  return offer.status === OfferStatus.VIGENTE && offer.expiresAt <= now
    ? OfferStatus.VENCIDA
    : offer.status;
}

/**
 * Filtro por estado efectivo, coherente con effectiveOfferStatus: una VIGENTE
 * vencida se lista como VENCIDA y no como VIGENTE.
 */
export function offerStatusWhere(
  status: OfferStatus | undefined,
  now: Date,
): Prisma.OfferWhereInput {
  if (status === undefined) {
    return {};
  }
  if (status === OfferStatus.VIGENTE) {
    return { status, expiresAt: { gt: now } };
  }
  if (status === OfferStatus.VENCIDA) {
    return {
      OR: [
        { status },
        { status: OfferStatus.VIGENTE, expiresAt: { lte: now } },
      ],
    };
  }
  return { status };
}

export function toOfferView(offer: OfferRow, now: Date): OfferView {
  return {
    id: offer.id,
    orderId: offer.orderId,
    status: effectiveOfferStatus(offer, now),
    round: offer.round,
    amount: offer.amount.toFixed(2),
    turn: offer.turn,
    requiresVisit: offer.requiresVisit,
    visitCost: offer.visitCost === null ? null : offer.visitCost.toFixed(2),
    materialsIncluded: offer.materialsIncluded,
    proposedStartAt: offer.proposedStartAt,
    estimatedDurationMinutes: offer.estimatedDurationMinutes,
    expiresAt: offer.expiresAt,
    closedAt: offer.closedAt,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

export function toReceivedOfferView(
  offer: ReceivedOfferRow,
  now: Date,
): ReceivedOfferView {
  return { ...toOfferView(offer, now), worker: offer.worker };
}

export function toOfferEventView(event: OfferEventRow): OfferEventView {
  return {
    ...event,
    amount: event.amount === null ? null : event.amount.toFixed(2),
  };
}
