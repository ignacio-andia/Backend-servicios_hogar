import { OfferEventType, OfferStatus } from '../../generated/prisma/enums.js';
import {
  OFFER_CLOSED_STATUSES,
  OFFER_CLOSING_EVENT,
  OFFER_MAX_ROUNDS,
  OFFER_OPEN_STATUS,
  OFFER_ROUND_EVENTS,
  OFFER_VALIDITY_HOURS,
} from './offers.rules.js';

describe('offers.rules (T6.1)', () => {
  it('aplica las decisiones aprobadas: 24 horas y 3 rondas', () => {
    expect(OFFER_VALIDITY_HOURS).toBe(24);
    expect(OFFER_MAX_ROUNDS).toBe(3);
  });

  it('VIGENTE es el unico estado abierto y todos los demas son finales', () => {
    expect([OFFER_OPEN_STATUS, ...OFFER_CLOSED_STATUSES].sort()).toEqual(
      Object.values(OfferStatus).sort(),
    );
    expect(OFFER_CLOSED_STATUSES).not.toContain(OfferStatus.VIGENTE);
  });

  it('cada cierre tiene su evento y los eventos cubren rondas y cierres', () => {
    for (const status of OFFER_CLOSED_STATUSES) {
      expect(
        OFFER_CLOSING_EVENT[status as keyof typeof OFFER_CLOSING_EVENT],
      ).toBe(status);
    }
    expect(
      [...OFFER_ROUND_EVENTS, ...Object.values(OFFER_CLOSING_EVENT)].sort(),
    ).toEqual(Object.values(OfferEventType).sort());
  });
});
