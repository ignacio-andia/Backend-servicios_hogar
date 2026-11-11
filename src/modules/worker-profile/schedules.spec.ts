import { BadRequestException } from '@nestjs/common';
import { WeekDay } from '../../generated/prisma/enums.js';
import {
  normalizeSchedules,
  TIME_PATTERN,
  toMinutes,
  toTime,
} from './schedules.js';

describe('schedules', () => {
  it('convierte entre HH:mm y minutos', () => {
    expect(toMinutes('08:30')).toBe(510);
    expect(toMinutes('24:00')).toBe(1440);
    expect(toTime(510)).toBe('08:30');
    expect(toTime(1440)).toBe('24:00');
  });

  it.each(['8:00', '25:00', '12:60', '24:01', 'ab:cd'])(
    'rechaza el formato %s',
    (value) => {
      expect(TIME_PATTERN.test(value)).toBe(false);
    },
  );

  it('acepta varios intervalos que no se superponen en el mismo dia', () => {
    const rows = normalizeSchedules([
      { dayOfWeek: WeekDay.LUNES, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: WeekDay.LUNES, startTime: '12:00', endTime: '18:00' },
      {
        dayOfWeek: WeekDay.MARTES,
        startTime: '08:00',
        endTime: '24:00',
        isActive: false,
      },
    ]);

    expect(rows).toEqual([
      {
        dayOfWeek: WeekDay.LUNES,
        startMinutes: 480,
        endMinutes: 720,
        isActive: true,
      },
      {
        dayOfWeek: WeekDay.LUNES,
        startMinutes: 720,
        endMinutes: 1080,
        isActive: true,
      },
      {
        dayOfWeek: WeekDay.MARTES,
        startMinutes: 480,
        endMinutes: 1440,
        isActive: false,
      },
    ]);
  });

  it('exige que el fin sea posterior al inicio', () => {
    expect(() =>
      normalizeSchedules([
        { dayOfWeek: WeekDay.LUNES, startTime: '10:00', endTime: '10:00' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rechaza intervalos superpuestos del mismo dia, aunque uno este inactivo', () => {
    try {
      normalizeSchedules([
        { dayOfWeek: WeekDay.JUEVES, startTime: '08:00', endTime: '12:00' },
        {
          dayOfWeek: WeekDay.JUEVES,
          startTime: '11:00',
          endTime: '14:00',
          isActive: false,
        },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: [
          'JUEVES: el horario 11:00-14:00 se superpone con 08:00-12:00',
        ],
      });
    }
  });

  it('permite una lista vacia', () => {
    expect(normalizeSchedules([])).toEqual([]);
  });
});
