import { describe, expect, it } from 'vitest';
import { ClaimPriority, ClaimStatus } from '../../generated/prisma/client.js';
import {
  defaultDueAt,
  dueAtError,
  isOverdue,
  situationWhere,
} from './claims.rules.js';

const NOW = new Date('2026-12-01T12:00:00.000Z');
const HOUR = 3_600_000;

describe('claims.rules', () => {
  it('calcula el plazo segun la prioridad (RN-2)', () => {
    expect(defaultDueAt(ClaimPriority.URGENTE, NOW).getTime() - NOW.getTime()).toBe(24 * HOUR);
    expect(defaultDueAt(ClaimPriority.ALTA, NOW).getTime() - NOW.getTime()).toBe(48 * HOUR);
    expect(defaultDueAt(ClaimPriority.MEDIA, NOW).getTime() - NOW.getTime()).toBe(72 * HOUR);
    expect(defaultDueAt(ClaimPriority.BAJA, NOW).getTime() - NOW.getTime()).toBe(120 * HOUR);
  });

  it('rechaza fechas pasadas o a mas de 30 dias (RN-4)', () => {
    expect(dueAtError(new Date(NOW.getTime() - HOUR), NOW)).not.toBeNull();
    expect(dueAtError(new Date(NOW.getTime() + 31 * 24 * HOUR), NOW)).not.toBeNull();
    expect(dueAtError(new Date('fecha-invalida'), NOW)).not.toBeNull();
    expect(dueAtError(new Date(NOW.getTime() + HOUR), NOW)).toBeNull();
  });

  it('solo un pendiente con fecha pasada esta vencido (RN-6)', () => {
    const past = new Date(NOW.getTime() - HOUR);
    const future = new Date(NOW.getTime() + HOUR);
    expect(isOverdue({ status: ClaimStatus.ABIERTO, dueAt: past }, NOW)).toBe(true);
    expect(isOverdue({ status: ClaimStatus.EN_REVISION, dueAt: past }, NOW)).toBe(true);
    expect(isOverdue({ status: ClaimStatus.RESUELTO, dueAt: past }, NOW)).toBe(false);
    expect(isOverdue({ status: ClaimStatus.ABIERTO, dueAt: future }, NOW)).toBe(false);
  });

  it('traduce la situacion a filtros de Prisma (RN-6)', () => {
    const pending = { status: { in: [ClaimStatus.ABIERTO, ClaimStatus.EN_REVISION] } };
    expect(situationWhere('PENDIENTE', NOW)).toEqual(pending);
    expect(situationWhere('VENCIDO', NOW)).toEqual({ ...pending, dueAt: { lt: NOW } });
    expect(situationWhere('EN_PLAZO', NOW)).toEqual({ ...pending, dueAt: { gte: NOW } });
  });
});