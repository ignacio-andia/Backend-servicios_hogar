/**
 * Calculo de la recomendacion de trabajadores: funciones puras, sin BD, para
 * probarlas y explicarlas por separado. Cada criterio da un puntaje de 0 a 100
 * y el total es el promedio ponderado con los pesos vigentes (suman 100).
 *
 * - Reputacion: promedio bayesiano de las calificaciones visibles de clientes.
 *   Se suman `reviewsForConfidence` calificaciones neutras de 3 estrellas, asi
 *   un trabajador con una sola calificacion de 5 no supera a uno con muchas
 *   calificaciones altas. 1 estrella = 0 puntos y 5 estrellas = 100.
 * - Servicios completados: trabajos terminados; con `completedServicesTarget`
 *   o mas se llega a 100.
 * - Disponibilidad: horas libres en los proximos 7 dias (horario semanal de
 *   atencion menos las horas de trabajos acordados en ese periodo, la misma
 *   fuente que la agenda RF-30); con `availabilityHoursTarget` horas libres o
 *   mas se llega a 100.
 */

/** Calificacion neutra que completa el promedio bayesiano. */
export const NEUTRAL_RATING = 3;
const MIN_RATING = 1;
const MAX_RATING = 5;

/** Periodo, en dias, en el que se mide la disponibilidad. */
export const AVAILABILITY_WINDOW_DAYS = 7;

/** Cuantos trabajadores se guardan y muestran en cada recomendacion. */
export const MAX_RECOMMENDED_WORKERS = 10;

/** Pesos (porcentajes enteros que suman 100) y parametros de cada criterio. */
export interface RecommendationCriteria {
  reputationWeight: number;
  completedServicesWeight: number;
  availabilityWeight: number;
  reviewsForConfidence: number;
  completedServicesTarget: number;
  availabilityHoursTarget: number;
}

/** Datos reales de un candidato, leidos de la BD al generar la recomendacion. */
export interface CandidateFacts {
  workerId: string;
  /** Calificaciones visibles (1 a 5) que le dieron los clientes. */
  ratings: readonly number[];
  completedServices: number;
  weeklyScheduleMinutes: number;
  /** Minutos de trabajos acordados dentro de los proximos 7 dias. */
  bookedMinutes: number;
}

export interface ReputationScore {
  reviewsCount: number;
  /** Promedio simple con 2 decimales; null sin calificaciones. */
  averageRating: number | null;
  /** Promedio bayesiano con 2 decimales (1 a 5). */
  adjustedRating: number;
  score: number;
}

export interface AvailabilityScore {
  freeMinutes: number;
  score: number;
}

export interface ScoredCandidate {
  workerId: string;
  rank: number;
  totalScore: number;
  reputation: ReputationScore;
  completedServices: number;
  completedServicesScore: number;
  weeklyScheduleMinutes: number;
  bookedMinutes: number;
  availability: AvailabilityScore;
}

/** Redondeo a 2 decimales, mitad hacia arriba. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Porcentaje (0 a 100) de un valor respecto de su meta, con tope en 100. */
function toPercent(value: number, target: number): number {
  if (target <= 0) {
    return 0;
  }
  return round2(Math.min(value / target, 1) * 100);
}

export function reputationScore(
  ratings: readonly number[],
  reviewsForConfidence: number,
): ReputationScore {
  for (const rating of ratings) {
    if (
      !Number.isInteger(rating) ||
      rating < MIN_RATING ||
      rating > MAX_RATING
    ) {
      throw new RangeError(`Calificacion invalida: ${rating}`);
    }
  }
  const count = ratings.length;
  const sum = ratings.reduce((total, rating) => total + rating, 0);
  const weight = reviewsForConfidence + count;
  const adjusted =
    weight === 0
      ? NEUTRAL_RATING
      : (reviewsForConfidence * NEUTRAL_RATING + sum) / weight;
  return {
    reviewsCount: count,
    averageRating: count === 0 ? null : round2(sum / count),
    adjustedRating: round2(adjusted),
    score: round2(((adjusted - MIN_RATING) / (MAX_RATING - MIN_RATING)) * 100),
  };
}

export function completedServicesScore(count: number, target: number): number {
  return toPercent(Math.max(count, 0), target);
}

export function availabilityScore(
  weeklyScheduleMinutes: number,
  bookedMinutes: number,
  availabilityHoursTarget: number,
): AvailabilityScore {
  const freeMinutes = Math.max(
    weeklyScheduleMinutes - Math.max(bookedMinutes, 0),
    0,
  );
  return {
    freeMinutes,
    score: toPercent(freeMinutes, availabilityHoursTarget * 60),
  };
}

/** Promedio ponderado de los tres puntajes (los pesos suman 100). */
export function weightedTotal(
  scores: {
    reputation: number;
    completedServices: number;
    availability: number;
  },
  criteria: RecommendationCriteria,
): number {
  return round2(
    (scores.reputation * criteria.reputationWeight +
      scores.completedServices * criteria.completedServicesWeight +
      scores.availability * criteria.availabilityWeight) /
      100,
  );
}

/** Puntos que aporta un criterio al total: puntaje x peso / 100. */
export function contribution(score: number, weight: number): number {
  return round2((score * weight) / 100);
}

/**
 * Puntua y ordena a los candidatos: mayor total primero; en empate, mejor
 * reputacion, mas servicios completados, mas horas libres y, por ultimo, el id
 * (orden estable y reproducible).
 */
export function rankCandidates(
  candidates: readonly CandidateFacts[],
  criteria: RecommendationCriteria,
): ScoredCandidate[] {
  const scored = candidates.map((candidate) => {
    const reputation = reputationScore(
      candidate.ratings,
      criteria.reviewsForConfidence,
    );
    const servicesScore = completedServicesScore(
      candidate.completedServices,
      criteria.completedServicesTarget,
    );
    const availability = availabilityScore(
      candidate.weeklyScheduleMinutes,
      candidate.bookedMinutes,
      criteria.availabilityHoursTarget,
    );
    return {
      workerId: candidate.workerId,
      rank: 0,
      totalScore: weightedTotal(
        {
          reputation: reputation.score,
          completedServices: servicesScore,
          availability: availability.score,
        },
        criteria,
      ),
      reputation,
      completedServices: Math.max(candidate.completedServices, 0),
      completedServicesScore: servicesScore,
      weeklyScheduleMinutes: candidate.weeklyScheduleMinutes,
      bookedMinutes: Math.max(candidate.bookedMinutes, 0),
      availability,
    };
  });
  scored.sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      b.reputation.score - a.reputation.score ||
      b.completedServices - a.completedServices ||
      b.availability.freeMinutes - a.availability.freeMinutes ||
      a.workerId.localeCompare(b.workerId),
  );
  return scored.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/**
 * Minutos de un trabajo [inicio, inicio + duracion) que caen dentro del
 * periodo [desde, hasta). Un trabajo fuera del periodo aporta 0.
 */
export function minutesWithin(
  job: { startAt: Date; durationMinutes: number },
  from: Date,
  to: Date,
): number {
  const start = Math.max(job.startAt.getTime(), from.getTime());
  const end = Math.min(
    job.startAt.getTime() + job.durationMinutes * 60_000,
    to.getTime(),
  );
  return end > start ? Math.round((end - start) / 60_000) : 0;
}
