import { OfferEventType, OfferStatus } from '../../generated/prisma/enums.js';

// Reglas centrales de OffersModule (T6.1, decisiones aprobadas). La BD
// refuerza las que puede (CHECK, indices parciales y triggers de la
// migracion 20261124000000_create_offers).

/** Vigencia de una oferta: 24 horas, reiniciadas con cada contraoferta. */
export const OFFER_VALIDITY_HOURS = 24;

/**
 * Maximo de rondas: propuesta inicial, primera y segunda contraoferta. Igual
 * que el CHECK offers_round_check de la BD.
 */
export const OFFER_MAX_ROUNDS = 3;

/** Unico estado abierto: se puede contraofertar, aceptar, rechazar o retirar. */
export const OFFER_OPEN_STATUS = OfferStatus.VIGENTE;

/**
 * Estados finales. Una oferta cerrada no se reabre ni se modifica (trigger
 * offers_guard). RETIRADA ademas impide volver a ofertar por el mismo pedido.
 */
export const OFFER_CLOSED_STATUSES: readonly OfferStatus[] = [
  OfferStatus.ACEPTADA,
  OfferStatus.RECHAZADA,
  OfferStatus.RETIRADA,
  OfferStatus.VENCIDA,
  OfferStatus.SIN_EFECTO,
];

/** Eventos que abren una ronda y llevan monto. */
export const OFFER_ROUND_EVENTS: readonly OfferEventType[] = [
  OfferEventType.PROPUESTA,
  OfferEventType.CONTRAOFERTA,
];

/** Evento del historial que registra cada cierre (uno por oferta). */
export const OFFER_CLOSING_EVENT: Readonly<
  Record<Exclude<OfferStatus, 'VIGENTE'>, OfferEventType>
> = {
  [OfferStatus.ACEPTADA]: OfferEventType.ACEPTADA,
  [OfferStatus.RECHAZADA]: OfferEventType.RECHAZADA,
  [OfferStatus.RETIRADA]: OfferEventType.RETIRADA,
  [OfferStatus.VENCIDA]: OfferEventType.VENCIDA,
  [OfferStatus.SIN_EFECTO]: OfferEventType.SIN_EFECTO,
};
