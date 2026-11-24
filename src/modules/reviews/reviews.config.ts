import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '../../generated/prisma/enums.js';
import {
  type ReviewEligibilityPolicy,
  statusEligibilityPolicy,
} from './review-eligibility.policy.js';

/**
 * Estados que habilitan calificar (RF-45). REVIEWS_ELIGIBLE_STATUSES: lista
 * separada por comas de estados de pedido, por ejemplo "TERMINADO,CERRADO".
 * Sin valor las calificaciones quedan DESHABILITADAS: la definicion final
 * (CU-45 "Terminado o Cerrado" frente a CU-44 "Cerrado o con el pago final
 * confirmado") esta pendiente del docente y no se asume. Un estado desconocido
 * detiene el arranque.
 */
@Injectable()
export class ReviewsConfig {
  readonly policy: ReviewEligibilityPolicy;

  constructor(config: ConfigService) {
    this.policy = statusEligibilityPolicy(
      parseEligibleStatuses(config.get<string>('REVIEWS_ELIGIBLE_STATUSES')),
    );
  }
}

export function parseEligibleStatuses(raw: string | undefined): OrderStatus[] {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  const known = Object.values(OrderStatus) as string[];
  const unknown = values.filter((value) => !known.includes(value));
  if (unknown.length > 0) {
    throw new Error(
      `REVIEWS_ELIGIBLE_STATUSES tiene estados desconocidos: ${unknown.join(', ')}`,
    );
  }
  return [...new Set(values)] as OrderStatus[];
}
