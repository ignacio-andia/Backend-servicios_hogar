import { BadRequestException } from '@nestjs/common';
import { WeekDay } from '../../generated/prisma/enums.js';
import {
  isWithinSchedules,
  minuteOfWeek,
  normalizeSchedules,
  SCHEDULE_TIME_ZONE,
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

describe('isWithinSchedules (T6.2, America/La_Paz)', () => {
  // LUNES 2026-11-23: en La Paz (UTC-4) las 08:00 locales son las 12:00 UTC.
  const at = (iso: string) => new Date(iso);
  const row = (
    dayOfWeek: WeekDay,
    start: string,
    end: string,
    isActive = true,
  ) => ({
    dayOfWeek,
    startMinutes: toMinutes(start),
    endMinutes: toMinutes(end),
    isActive,
  });
  const lunes = [row(WeekDay.LUNES, '08:00', '18:00')];

  it('usa la zona horaria America/La_Paz', () => {
    expect(SCHEDULE_TIME_ZONE).toBe('America/La_Paz');
    expect(minuteOfWeek(at('2026-11-23T12:00:00Z'))).toBe(8 * 60);
    // 03:30 UTC del martes es todavia lunes 23:30 en La Paz.
    expect(minuteOfWeek(at('2026-11-24T03:30:00Z'))).toBe(23 * 60 + 30);
    expect(minuteOfWeek(at('2026-11-29T12:00:00Z'))).toBe(6 * 1440 + 8 * 60);
  });

  it('acepta un trabajo completo dentro del horario, incluidos los bordes', () => {
    expect(isWithinSchedules(lunes, at('2026-11-23T12:00:00Z'), 60)).toBe(true);
    // 17:00 mas 60 minutos termina justo a las 18:00.
    expect(isWithinSchedules(lunes, at('2026-11-23T21:00:00Z'), 60)).toBe(true);
  });

  it('rechaza un trabajo fuera del horario o en otro dia', () => {
    // 07:00 en La Paz (11:00 UTC).
    expect(isWithinSchedules(lunes, at('2026-11-23T11:00:00Z'), 30)).toBe(
      false,
    );
    // Martes 10:00.
    expect(isWithinSchedules(lunes, at('2026-11-24T14:00:00Z'), 30)).toBe(
      false,
    );
    // Las 09:00 UTC caerian dentro de 08:00-18:00 si se leyeran en UTC, pero
    // en La Paz son las 05:00.
    expect(isWithinSchedules(lunes, at('2026-11-23T09:00:00Z'), 30)).toBe(
      false,
    );
  });

  it('rechaza un trabajo que empieza dentro y termina fuera', () => {
    expect(isWithinSchedules(lunes, at('2026-11-23T21:30:00Z'), 60)).toBe(
      false,
    );
  });

  it('ignora horarios inactivos y une intervalos contiguos del mismo dia', () => {
    expect(
      isWithinSchedules(
        [row(WeekDay.LUNES, '08:00', '18:00', false)],
        at('2026-11-23T12:00:00Z'),
        30,
      ),
    ).toBe(false);
    const partido = [
      row(WeekDay.LUNES, '08:00', '12:00'),
      row(WeekDay.LUNES, '12:00', '18:00'),
    ];
    expect(isWithinSchedules(partido, at('2026-11-23T15:00:00Z'), 120)).toBe(
      true,
    );
    const conPausa = [
      row(WeekDay.LUNES, '08:00', '12:00'),
      row(WeekDay.LUNES, '13:00', '18:00'),
    ];
    expect(isWithinSchedules(conPausa, at('2026-11-23T15:00:00Z'), 120)).toBe(
      false,
    );
  });

  it('cruza la medianoche solo si el trabajador atiende sin corte en dias consecutivos', () => {
    const nocturno = [
      row(WeekDay.LUNES, '20:00', '24:00'),
      row(WeekDay.MARTES, '00:00', '02:00'),
    ];
    // Lunes 23:00 local (martes 03:00 UTC) por 2 horas: termina martes 01:00.
    expect(isWithinSchedules(nocturno, at('2026-11-24T03:00:00Z'), 120)).toBe(
      true,
    );
    expect(isWithinSchedules(nocturno, at('2026-11-24T03:00:00Z'), 240)).toBe(
      false,
    );
    expect(
      isWithinSchedules(
        [row(WeekDay.LUNES, '20:00', '24:00')],
        at('2026-11-24T03:00:00Z'),
        120,
      ),
    ).toBe(false);
    // De DOMINGO a LUNES: domingo 23:00 local = lunes 03:00 UTC.
    const domingoLunes = [
      row(WeekDay.DOMINGO, '22:00', '24:00'),
      row(WeekDay.LUNES, '00:00', '01:00'),
    ];
    expect(
      isWithinSchedules(domingoLunes, at('2026-11-30T03:00:00Z'), 90),
    ).toBe(true);
  });

  it('sin horarios o con duracion no positiva no hay disponibilidad', () => {
    expect(isWithinSchedules([], at('2026-11-23T12:00:00Z'), 30)).toBe(false);
    expect(isWithinSchedules(lunes, at('2026-11-23T12:00:00Z'), 0)).toBe(false);
  });

  it('con atencion continua toda la semana cualquier duracion cabe', () => {
    const siempre = Object.values(WeekDay).map((day) =>
      row(day, '00:00', '24:00'),
    );
    expect(
      isWithinSchedules(siempre, at('2026-11-23T12:00:00Z'), 60 * 24 * 30),
    ).toBe(true);
  });
});
