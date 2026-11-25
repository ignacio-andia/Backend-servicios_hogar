import { slotsOverlap } from './offer-negotiation.js';

// Casos de borde de RF-30 y RF-31. Solo pruebas: no cambian slotsOverlap ni
// las reglas de cruces de la aceptacion de ofertas.
const MINUTE = 60_000;
const BASE = Date.parse('2026-11-30T14:00:00.000Z');
const slot = (offsetMinutes: number, minutes: number) => ({
  proposedStartAt: new Date(BASE + offsetMinutes * MINUTE),
  estimatedDurationMinutes: minutes,
});

describe('slotsOverlap: intervalos [inicio, inicio + duracion)', () => {
  it('es simetrico', () => {
    const pairs = [
      [slot(0, 60), slot(30, 60)],
      [slot(0, 60), slot(60, 60)],
      [slot(0, 60), slot(-60, 60)],
      [slot(0, 60), slot(-59, 60)],
    ] as const;
    for (const [a, b] of pairs) {
      expect(slotsOverlap(a, b)).toBe(slotsOverlap(b, a));
    }
  });

  it('un trabajo que termina cuando empieza el otro no se cruza', () => {
    expect(slotsOverlap(slot(0, 60), slot(60, 60))).toBe(false);
    expect(slotsOverlap(slot(60, 60), slot(0, 60))).toBe(false);
  });

  it('un minuto de solapamiento ya es un cruce', () => {
    expect(slotsOverlap(slot(0, 60), slot(59, 60))).toBe(true);
    expect(slotsOverlap(slot(59, 60), slot(0, 60))).toBe(true);
  });

  it('dos trabajos identicos se cruzan', () => {
    expect(slotsOverlap(slot(0, 90), slot(0, 90))).toBe(true);
  });

  it('un trabajo dentro de otro se cruza', () => {
    expect(slotsOverlap(slot(0, 240), slot(60, 30))).toBe(true);
    expect(slotsOverlap(slot(60, 30), slot(0, 240))).toBe(true);
  });

  it('trabajos separados por un minuto libre no se cruzan', () => {
    expect(slotsOverlap(slot(0, 60), slot(61, 60))).toBe(false);
  });

  it('cruzan la medianoche local sin problema (se compara en instantes)', () => {
    // Lunes 23:00 local (martes 03:00 UTC) por 2 horas.
    const noche = {
      proposedStartAt: new Date('2026-11-24T03:00:00.000Z'),
      estimatedDurationMinutes: 120,
    };
    const madrugada = {
      proposedStartAt: new Date('2026-11-24T04:30:00.000Z'),
      estimatedDurationMinutes: 30,
    };
    expect(slotsOverlap(noche, madrugada)).toBe(true);
    const despues = {
      proposedStartAt: new Date('2026-11-24T05:00:00.000Z'),
      estimatedDurationMinutes: 30,
    };
    expect(slotsOverlap(noche, despues)).toBe(false);
  });

  it('el mismo instante en otra zona es el mismo horario', () => {
    const utc = {
      proposedStartAt: new Date('2026-11-30T14:00:00Z'),
      estimatedDurationMinutes: 60,
    };
    const laPaz = {
      proposedStartAt: new Date('2026-11-30T10:00:00-04:00'),
      estimatedDurationMinutes: 60,
    };
    expect(slotsOverlap(utc, laPaz)).toBe(true);
  });

  it('un trabajo de varios dias se cruza solo si llega al siguiente', () => {
    const largo = slot(0, 8 * 24 * 60);
    expect(slotsOverlap(largo, slot(7 * 24 * 60, 60))).toBe(true);
    expect(slotsOverlap(largo, slot(8 * 24 * 60, 60))).toBe(false);
  });
});
