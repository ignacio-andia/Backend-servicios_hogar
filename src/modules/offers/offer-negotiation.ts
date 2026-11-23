import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  OfferParty,
  OfferStatus,
  type Prisma,
} from '../../generated/prisma/client.js';
import { OFFER_MAX_ROUNDS } from './offers.rules.js';

// Reglas de la negociacion sobre una oferta ya bloqueada (T6.3).

export interface LockedOffer {
  status: OfferStatus;
  round: number;
  turn: OfferParty;
  expiresAt: Date;
}

/**
 * Bloquea la fila de la oferta (SELECT ... FOR UPDATE). Orden de bloqueos:
 * despues de la cuenta, el trabajador y el pedido; antes de los catalogos.
 */
export async function lockOffer(
  tx: Prisma.TransactionClient,
  offerId: string,
): Promise<LockedOffer | null> {
  const [offer] = await tx.$queryRaw<LockedOffer[]>`
    SELECT "status", "round", "turn", "expires_at" AS "expiresAt"
    FROM "offers"
    WHERE "id" = ${offerId}::uuid
    FOR UPDATE`;
  return offer ?? null;
}

/** Parte de la negociacion que corresponde al usuario, o null si no participa. */
export function partyOf(
  offer: { workerId: string; order: { clientId: string } },
  userId: string,
): OfferParty | null {
  if (offer.workerId === userId) {
    return OfferParty.TRABAJADOR;
  }
  if (offer.order.clientId === userId) {
    return OfferParty.CLIENTE;
  }
  return null;
}

export function otherParty(party: OfferParty): OfferParty {
  return party === OfferParty.CLIENTE
    ? OfferParty.TRABAJADOR
    : OfferParty.CLIENTE;
}

/**
 * Una contraoferta exige oferta VIGENTE y sin vencer (reloj de la BD), que
 * sea el turno de quien responde y que quede una ronda (maximo 3). 409 si no.
 */
export function assertCanCounter(
  offer: LockedOffer,
  party: OfferParty,
  now: Date,
): void {
  if (offer.status !== OfferStatus.VIGENTE) {
    throw new ConflictException(
      `La oferta está cerrada (${offer.status}) y no admite contraofertas.`,
    );
  }
  if (offer.expiresAt <= now) {
    throw new ConflictException('La oferta venció y no admite contraofertas.');
  }
  if (offer.turn !== party) {
    throw new ConflictException(
      offer.turn === OfferParty.CLIENTE
        ? 'Ahora le toca responder al cliente.'
        : 'Ahora le toca responder al trabajador.',
    );
  }
  if (offer.round >= OFFER_MAX_ROUNDS) {
    throw new ConflictException(
      `Se alcanzó el máximo de ${OFFER_MAX_ROUNDS} rondas: la oferta ya no admite contraofertas.`,
    );
  }
}

/**
 * Rechazo o retiro (T6.4.1): la oferta debe estar VIGENTE y sin vencer
 * (reloj de la BD). El rechazo ademas exige el turno del cliente; el retiro
 * no depende del turno. 409 si no.
 */
export function assertCanClose(
  offer: LockedOffer,
  party: OfferParty,
  now: Date,
): void {
  const action = party === OfferParty.CLIENTE ? 'rechazar' : 'retirar';
  if (offer.status !== OfferStatus.VIGENTE) {
    throw new ConflictException(
      `La oferta ya está cerrada (${offer.status}): no se puede ${action}.`,
    );
  }
  if (offer.expiresAt <= now) {
    throw new ConflictException(`La oferta venció: no se puede ${action}.`);
  }
  if (party === OfferParty.CLIENTE && offer.turn !== OfferParty.CLIENTE) {
    throw new ConflictException(
      'Ahora le toca responder al trabajador: no puede rechazar la oferta todavía.',
    );
  }
}

export function offerNotFound(): NotFoundException {
  return new NotFoundException('Oferta no encontrada');
}
