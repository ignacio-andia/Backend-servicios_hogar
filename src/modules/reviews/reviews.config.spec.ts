import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '../../generated/prisma/enums.js';
import {
  REVIEW_DISABLED_MESSAGE,
  REVIEW_NOT_FINISHED_MESSAGE,
} from './review-eligibility.policy.js';
import { ReviewsConfig, parseEligibleStatuses } from './reviews.config.js';

describe('ReviewsConfig (estados que habilitan calificar, sin valores por defecto)', () => {
  it('sin configurar, las calificaciones estan deshabilitadas para todo estado', () => {
    const { policy } = new ReviewsConfig(new ConfigService({}));
    expect(policy.eligibleStatuses).toEqual([]);
    expect(policy.denialReason({ status: OrderStatus.TERMINADO })).toBe(
      REVIEW_DISABLED_MESSAGE,
    );
    expect(policy.denialReason({ status: OrderStatus.CERRADO })).toBe(
      REVIEW_DISABLED_MESSAGE,
    );
  });

  it('usa exactamente los estados configurados', () => {
    const { policy } = new ReviewsConfig(
      new ConfigService({ REVIEWS_ELIGIBLE_STATUSES: 'cerrado, TERMINADO' }),
    );
    expect(policy.denialReason({ status: OrderStatus.CERRADO })).toBeNull();
    expect(policy.denialReason({ status: OrderStatus.TERMINADO })).toBeNull();
    expect(policy.denialReason({ status: OrderStatus.EN_RECLAMO })).toBe(
      REVIEW_NOT_FINISHED_MESSAGE,
    );
    expect(policy.denialReason({ status: OrderStatus.CANCELADO })).toBe(
      REVIEW_NOT_FINISHED_MESSAGE,
    );
  });

  it('ignora vacios y repetidos y rechaza estados desconocidos', () => {
    expect(parseEligibleStatuses(' , TERMINADO,TERMINADO ,')).toEqual([
      'TERMINADO',
    ]);
    expect(parseEligibleStatuses(undefined)).toEqual([]);
    expect(() => parseEligibleStatuses('TERMINADO,FINALIZADO')).toThrow(
      /FINALIZADO/,
    );
  });
});
