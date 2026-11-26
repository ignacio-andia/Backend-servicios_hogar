import { describe, expect, it } from 'vitest';
import {
  type CandidateFacts,
  type RecommendationCriteria,
  availabilityScore,
  completedServicesScore,
  contribution,
  minutesWithin,
  rankCandidates,
  reputationScore,
  weightedTotal,
} from './recommendation-scoring.js';

const CRITERIA: RecommendationCriteria = {
  reputationWeight: 50,
  completedServicesWeight: 30,
  availabilityWeight: 20,
  reviewsForConfidence: 3,
  completedServicesTarget: 10,
  availabilityHoursTarget: 20,
};

const facts = (
  overrides: Partial<CandidateFacts> & { workerId: string },
): CandidateFacts => ({
  ratings: [],
  completedServices: 0,
  weeklyScheduleMinutes: 0,
  bookedMinutes: 0,
  ...overrides,
});

describe('reputationScore (promedio bayesiano)', () => {
  it('sin calificaciones usa la calificacion neutra de 3 estrellas (50 puntos)', () => {
    expect(reputationScore([], 3)).toEqual({
      reviewsCount: 0,
      averageRating: null,
      adjustedRating: 3,
      score: 50,
    });
  });

  it('suma calificaciones neutras: una sola de 5 no vale lo mismo que muchas de 5', () => {
    const one = reputationScore([5], 3);
    // (3*3 + 5) / 4 = 3.5 -> (3.5 - 1) / 4 * 100 = 62.5
    expect(one).toMatchObject({
      averageRating: 5,
      adjustedRating: 3.5,
      score: 62.5,
    });
    const many = reputationScore([5, 5, 5, 5, 5, 5, 5, 5, 5], 3);
    // (9 + 45) / 12 = 4.5 -> 87.5
    expect(many).toMatchObject({ adjustedRating: 4.5, score: 87.5 });
    expect(many.score).toBeGreaterThan(one.score);
  });

  it('con 0 calificaciones neutras es el promedio simple; 1 estrella = 0 y 5 = 100', () => {
    expect(reputationScore([1, 1], 0).score).toBe(0);
    expect(reputationScore([5], 0).score).toBe(100);
    expect(reputationScore([4, 5], 0)).toMatchObject({
      averageRating: 4.5,
      score: 87.5,
    });
  });

  it('rechaza calificaciones fuera de 1 a 5', () => {
    expect(() => reputationScore([6], 3)).toThrow(RangeError);
    expect(() => reputationScore([0], 3)).toThrow(RangeError);
    expect(() => reputationScore([4.5], 3)).toThrow(RangeError);
  });
});

describe('completedServicesScore', () => {
  it('es proporcional a la meta y tiene tope en 100', () => {
    expect(completedServicesScore(0, 10)).toBe(0);
    expect(completedServicesScore(4, 10)).toBe(40);
    expect(completedServicesScore(10, 10)).toBe(100);
    expect(completedServicesScore(25, 10)).toBe(100);
    expect(completedServicesScore(1, 3)).toBe(33.33);
  });
});

describe('availabilityScore', () => {
  it('horas libres = horario semanal - trabajos acordados, con tope en 100', () => {
    // 40 h de horario, 10 h ocupadas: 30 h libres >= 20 h -> 100.
    expect(availabilityScore(40 * 60, 10 * 60, 20)).toEqual({
      freeMinutes: 1800,
      score: 100,
    });
    // 10 h de horario, 5 h ocupadas: 5 h libres de 20 -> 25.
    expect(availabilityScore(10 * 60, 5 * 60, 20)).toEqual({
      freeMinutes: 300,
      score: 25,
    });
  });

  it('sin horario o con la semana llena no tiene horas libres', () => {
    expect(availabilityScore(0, 0, 20)).toEqual({ freeMinutes: 0, score: 0 });
    expect(availabilityScore(600, 900, 20)).toEqual({
      freeMinutes: 0,
      score: 0,
    });
  });
});

describe('weightedTotal y contribution', () => {
  it('el total es el promedio ponderado y los puntos de cada criterio lo suman', () => {
    const scores = {
      reputation: 87.5,
      completedServices: 40,
      availability: 25,
    };
    const total = weightedTotal(scores, CRITERIA);
    // 87.5*0.5 + 40*0.3 + 25*0.2 = 43.75 + 12 + 5 = 60.75
    expect(total).toBe(60.75);
    expect(
      contribution(87.5, 50) + contribution(40, 30) + contribution(25, 20),
    ).toBe(total);
  });
});

describe('rankCandidates', () => {
  it('ordena por total y numera desde 1', () => {
    const ranked = rankCandidates(
      [
        facts({ workerId: 'b', ratings: [3], weeklyScheduleMinutes: 600 }),
        facts({
          workerId: 'a',
          ratings: [5, 5, 4],
          completedServices: 6,
          weeklyScheduleMinutes: 2400,
        }),
        facts({ workerId: 'c' }),
      ],
      CRITERIA,
    );
    expect(ranked.map((c) => [c.workerId, c.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(ranked[0]).toMatchObject({
      completedServicesScore: 60,
      availability: { freeMinutes: 2400, score: 100 },
    });
  });

  it('los pesos cambian el orden: con 100 % de disponibilidad gana el mas libre', () => {
    const candidates = [
      facts({
        workerId: 'experto',
        ratings: [5, 5, 5],
        completedServices: 10,
        weeklyScheduleMinutes: 120,
        bookedMinutes: 120,
      }),
      facts({ workerId: 'libre', weeklyScheduleMinutes: 2400 }),
    ];
    expect(rankCandidates(candidates, CRITERIA)[0].workerId).toBe('experto');
    expect(
      rankCandidates(candidates, {
        ...CRITERIA,
        reputationWeight: 0,
        completedServicesWeight: 0,
        availabilityWeight: 100,
      })[0].workerId,
    ).toBe('libre');
  });

  it('en empate desempata por reputacion, servicios, horas libres y por ultimo el id', () => {
    const ranked = rankCandidates(
      [facts({ workerId: 'z' }), facts({ workerId: 'y' })],
      CRITERIA,
    );
    expect(ranked.map((c) => c.workerId)).toEqual(['y', 'z']);
  });

  it('sin candidatos devuelve una lista vacia', () => {
    expect(rankCandidates([], CRITERIA)).toEqual([]);
  });
});

describe('minutesWithin', () => {
  const from = new Date('2026-11-26T12:00:00Z');
  const to = new Date('2026-12-03T12:00:00Z');

  it('cuenta solo la parte del trabajo dentro del periodo', () => {
    expect(
      minutesWithin(
        { startAt: new Date('2026-11-27T12:00:00Z'), durationMinutes: 90 },
        from,
        to,
      ),
    ).toBe(90);
    // Empezo 30 min antes del periodo.
    expect(
      minutesWithin(
        { startAt: new Date('2026-11-26T11:30:00Z'), durationMinutes: 60 },
        from,
        to,
      ),
    ).toBe(30);
    // Termina 30 min despues del periodo.
    expect(
      minutesWithin(
        { startAt: new Date('2026-12-03T11:30:00Z'), durationMinutes: 60 },
        from,
        to,
      ),
    ).toBe(30);
  });

  it('un trabajo fuera del periodo aporta 0', () => {
    expect(
      minutesWithin(
        { startAt: new Date('2026-12-10T12:00:00Z'), durationMinutes: 60 },
        from,
        to,
      ),
    ).toBe(0);
    expect(
      minutesWithin(
        { startAt: new Date('2026-11-20T12:00:00Z'), durationMinutes: 60 },
        from,
        to,
      ),
    ).toBe(0);
  });
});
