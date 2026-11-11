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
