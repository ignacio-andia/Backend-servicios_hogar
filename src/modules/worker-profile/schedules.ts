import { BadRequestException } from '@nestjs/common';
import type { WeekDay } from '../../generated/prisma/enums.js';

// Formato HH:mm en 24 horas; 24:00 solo tiene sentido como hora de fin.
export const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const MAX_SCHEDULES = 50;

export interface ScheduleInput {
  dayOfWeek: WeekDay;
  startTime: string;
  endTime: string;
  isActive?: boolean;
}

export interface ScheduleRow {
  dayOfWeek: WeekDay;
  startMinutes: number;
  endMinutes: number;
  isActive: boolean;
}

export function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function toTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Convierte y valida los intervalos: el fin debe ser posterior al inicio y
 * los intervalos de un mismo dia no pueden superponerse (activos o no, para
 * evitar horarios contradictorios). Lanza 400 con todos los problemas.
 */
export function normalizeSchedules(items: ScheduleInput[]): ScheduleRow[] {
  const rows = items.map((item) => ({
    dayOfWeek: item.dayOfWeek,
    startMinutes: toMinutes(item.startTime),
    endMinutes: toMinutes(item.endTime),
    isActive: item.isActive ?? true,
  }));

  const problems: string[] = [];
  rows.forEach((row, index) => {
    if (row.endMinutes <= row.startMinutes) {
      problems.push(
        `Horario ${index + 1} (${row.dayOfWeek}): la hora de fin debe ser posterior a la de inicio`,
      );
    }
  });

  const byDay = new Map<WeekDay, ScheduleRow[]>();
  for (const row of rows.filter((r) => r.endMinutes > r.startMinutes)) {
    byDay.set(row.dayOfWeek, [...(byDay.get(row.dayOfWeek) ?? []), row]);
  }
  for (const [day, dayRows] of byDay) {
    const sorted = [...dayRows].sort((a, b) => a.startMinutes - b.startMinutes);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (current.startMinutes < previous.endMinutes) {
        problems.push(
          `${day}: el horario ${toTime(current.startMinutes)}-${toTime(current.endMinutes)} se superpone con ${toTime(previous.startMinutes)}-${toTime(previous.endMinutes)}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new BadRequestException(problems);
  }
  return rows;
}

/**
 * Zona horaria del proyecto: los horarios de atencion (HH:mm sin zona) se
 * interpretan en hora de Bolivia.
 */
export const SCHEDULE_TIME_ZONE = 'America/La_Paz';

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
// Indice del dia en la semana del modelo (LUNES = 0), segun Intl en ingles.
const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};
const DAY_INDEX: Readonly<Record<WeekDay, number>> = {
  LUNES: 0,
  MARTES: 1,
  MIERCOLES: 2,
  JUEVES: 3,
  VIERNES: 4,
  SABADO: 5,
  DOMINGO: 6,
};

/**
 * Minuto de la semana (LUNES 00:00 = 0, con fraccion por los segundos) de un
 * instante en la zona horaria indicada.
 */
export function minuteOfWeek(
  instant: Date,
  timeZone: string = SCHEDULE_TIME_ZONE,
): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const day = WEEKDAY_INDEX[value('weekday')];
  return (
    day * MINUTES_PER_DAY +
    Number(value('hour')) * 60 +
    Number(value('minute')) +
    (Number(value('second')) + instant.getUTCMilliseconds() / 1000) / 60
  );
}

/**
 * true si el trabajo [inicio, inicio + duracion) queda completamente dentro
 * de los horarios activos. Los intervalos contiguos se unen, tambien entre
 * dias consecutivos (por ejemplo LUNES 20:00-24:00 y MARTES 00:00-02:00) y
 * de DOMINGO a LUNES: asi un trabajo puede cruzar la medianoche si el
 * trabajador atiende sin corte. Un intervalo por si solo no cruza la
 * medianoche (normalizeSchedules exige fin posterior al inicio).
 */
export function isWithinSchedules(
  rows: readonly ScheduleRow[],
  start: Date,
  durationMinutes: number,
  timeZone: string = SCHEDULE_TIME_ZONE,
): boolean {
  if (durationMinutes <= 0) {
    return false;
  }
  const weekly = rows
    .filter((row) => row.isActive && row.endMinutes > row.startMinutes)
    .map((row) => {
      const base = DAY_INDEX[row.dayOfWeek] * MINUTES_PER_DAY;
      return [base + row.startMinutes, base + row.endMinutes] as const;
    });
  // Dos semanas seguidas: un trabajo que empieza esta semana puede terminar
  // en la siguiente.
  const intervals = [
    ...weekly,
    ...weekly.map(
      ([from, to]) => [from + MINUTES_PER_WEEK, to + MINUTES_PER_WEEK] as const,
    ),
  ].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of intervals) {
    const last = merged.at(-1);
    if (last && from <= last[1]) {
      last[1] = Math.max(last[1], to);
    } else {
      merged.push([from, to]);
    }
  }
  // Atiende toda la semana sin cortes: cualquier duracion cabe.
  if (merged.some(([from, to]) => from <= 0 && to >= 2 * MINUTES_PER_WEEK)) {
    return true;
  }
  const from = minuteOfWeek(start, timeZone);
  const to = from + durationMinutes;
  return merged.some(([a, b]) => a <= from && to <= b);
}
