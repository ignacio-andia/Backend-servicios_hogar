import {
  CONFORMITY_WINDOW_DAYS,
  computeConformityDeadline,
  isConformityWindowOver,
  isWithinConformityWindow,
} from './workflow.rules.js';
import { isNoShowReportAllowedAt } from './no-show-timing.policy.js';

const DAY = 24 * 60 * 60 * 1000;

describe('plazo de conformidad y reclamo (RN-10)', () => {
  const finishedAt = new Date('2026-11-30T15:00:00.000Z');
  const deadline = computeConformityDeadline(finishedAt);

  it('son 7 dias calendario exactos desde la finalizacion', () => {
    expect(CONFORMITY_WINDOW_DAYS).toBe(7);
    expect(deadline.getTime() - finishedAt.getTime()).toBe(7 * DAY);
  });

  it('el reclamo es valido hasta un instante antes del limite', () => {
    const justBefore = new Date(deadline.getTime() - 1);
    expect(isWithinConformityWindow(justBefore, deadline)).toBe(true);
    expect(isConformityWindowOver(justBefore, deadline)).toBe(false);
  });

  it('en el limite exacto y despues, el reclamo ya no es valido y el cierre procede', () => {
    for (const offset of [0, 1, DAY]) {
      const now = new Date(deadline.getTime() + offset);
      expect(isWithinConformityWindow(now, deadline)).toBe(false);
      expect(isConformityWindowOver(now, deadline)).toBe(true);
    }
  });

  it('reclamo y cierre nunca son validos a la vez ni se descartan a la vez', () => {
    for (const offset of [-DAY, -1, 0, 1, DAY]) {
      const now = new Date(deadline.getTime() + offset);
      expect(isWithinConformityWindow(now, deadline)).toBe(
        !isConformityWindowOver(now, deadline),
      );
    }
  });
});

describe('condicion de tiempo de la inasistencia (RF-36)', () => {
  it('esta aislada y NO restringe nada mientras el docente no la defina', () => {
    const proposedStartAt = new Date('2030-01-01T10:00:00Z');
    expect(
      isNoShowReportAllowedAt({
        now: new Date('2026-01-01T00:00:00Z'),
        proposedStartAt,
        estimatedDurationMinutes: 60,
      }),
    ).toBe(true);
  });
});
