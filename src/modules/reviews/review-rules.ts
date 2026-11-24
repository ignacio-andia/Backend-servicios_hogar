import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { OrderStatus } from '../../generated/prisma/enums.js';
import type { ReviewEligibilityPolicy } from './review-eligibility.policy.js';

export const REVIEW_MIN_RATING = 1;
export const REVIEW_MAX_RATING = 5;
export const REVIEW_COMMENT_MAX_LENGTH = 1000;

export type ReviewAuthorRole = 'CLIENTE' | 'TRABAJADOR';

export interface ReviewableOrder {
  clientId: string;
  assignedWorkerId: string | null;
  status: OrderStatus;
}

export interface ReviewTarget {
  targetId: string;
  authorRole: ReviewAuthorRole;
}

/**
 * Reglas inmutables de RF-44 y RF-45, independientes de la politica de
 * elegibilidad:
 * - Solo el cliente o el trabajador asignado del pedido califican.
 * - Se califica a la otra parte; nunca a uno mismo (RN-14).
 * - Una calificacion por parte y pedido.
 * La elegibilidad por estado la decide `policy`.
 * Orden de los errores: 403 (no participa), 409 (estado o repetida).
 */
export function resolveReviewTarget(input: {
  authorId: string;
  order: ReviewableOrder;
  alreadyReviewed: boolean;
  policy: ReviewEligibilityPolicy;
}): ReviewTarget {
  const { authorId, order } = input;
  const { clientId, assignedWorkerId } = order;
  const isClient = authorId === clientId;
  const isWorker = assignedWorkerId !== null && authorId === assignedWorkerId;
  if (!isClient && !isWorker) {
    throw new ForbiddenException('No participa en este pedido.');
  }
  if (assignedWorkerId === null || assignedWorkerId === clientId) {
    // Pedido sin trabajador o con cliente y trabajador iguales: no hay otra
    // parte a la que calificar (sin autocalificacion).
    throw new ConflictException(
      'El pedido no tiene otra parte a la que calificar.',
    );
  }
  const denial = input.policy.denialReason(order);
  if (denial !== null) {
    throw new ConflictException(denial);
  }
  if (input.alreadyReviewed) {
    throw new ConflictException('Ya calificó este pedido.');
  }
  return isClient
    ? { targetId: assignedWorkerId, authorRole: 'CLIENTE' }
    : { targetId: clientId, authorRole: 'TRABAJADOR' };
}

/** Rating entero de 1 a 5 (RF-44). */
export function assertValidRating(rating: unknown): asserts rating is number {
  if (
    typeof rating !== 'number' ||
    !Number.isInteger(rating) ||
    rating < REVIEW_MIN_RATING ||
    rating > REVIEW_MAX_RATING
  ) {
    throw new BadRequestException(
      `La calificación debe ser un entero entre ${REVIEW_MIN_RATING} y ${REVIEW_MAX_RATING}.`,
    );
  }
}

export interface RatingSummary {
  /** null si aun no hay calificaciones (RF-46 criterio 2). */
  average: number | null;
  count: number;
}

/**
 * Promedio (2 decimales, mitad hacia arriba) y cantidad de las calificaciones
 * VISIBLES. Las opiniones ocultas por el administrador no cuentan (RF-46 A1).
 * Aritmetica entera: sin acumular errores de flotantes.
 */
export function summarizeRatings(
  reviews: readonly { rating: number; hidden: boolean }[],
): RatingSummary {
  const visible = reviews.filter((review) => !review.hidden);
  if (visible.length === 0) {
    return { average: null, count: 0 };
  }
  for (const review of visible) {
    assertValidRating(review.rating);
  }
  const sum = visible.reduce((total, review) => total + review.rating, 0);
  // average = sum / count con 2 decimales, mitad hacia arriba, en enteros.
  const hundredths = Math.floor((sum * 200 + visible.length) / (2 * visible.length));
  return { average: hundredths / 100, count: visible.length };
}
