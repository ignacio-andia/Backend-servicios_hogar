import { BadRequestException } from '@nestjs/common';
import { WeekDay } from '../../generated/prisma/enums.js';
import {
  isWithinSchedules,
  minuteOfWeek,
  normalizeSchedules,
  toMinutes,
} from './schedules.js';

// Casos de borde de la agenda (RF-29, RF-30, RF-31). Solo pruebas: no cambian
// la logica de schedules.ts. Referencia: America/La_Paz es UTC-4 todo el ano
// (Bolivia no usa horario de verano), asi que 08:00 local = 12:00 UTC.
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

describe('minuteOfWeek: zona horaria de Bolivia', () => {
  it('no cambia entre enero y julio (sin horario de verano)', () => {
    expect(minuteOfWeek(at('2026-01-05T12:00:00Z'))).toBe(8 * 60); // lunes
    expect(minuteOfWeek(at('2026-07-06T12:00:00Z'))).toBe(8 * 60); // lunes
  });

  it('el lunes local empieza a las 04:00 UTC', () => {
    expect(minuteOfWeek(at('2026-11-23T04:00:00Z'))).toBe(0);
    // Un minuto antes sigue siendo domingo local 23:59.
    expect(minuteOfWeek(at('2026-11-23T03:59:00Z'))).toBe(6 * 1440 + 1439);
  });

  it('el cambio de ano de UTC no afecta al dia local', () => {
    // 2027-01-01 02:00 UTC es 2026-12-31 22:00 en La Paz (jueves).
    expect(minuteOfWeek(at('2027-01-01T02:00:00Z'))).toBe(3 * 1440 + 22 * 60);
  });

  it('incluye la fraccion de segundos', () => {
    expect(minuteOfWeek(at('2026-11-23T12:00:30Z'))).toBeCloseTo(8 * 60 + 0.5);
    expect(minuteOfWeek(at('2026-11-23T12:00:00.500Z'))).toBeCloseTo(
      8 * 60 + 0.5 / 60,
    );
  });
});

describe('isWithinSchedules: limites exactos', () => {
  const lunes = [row(WeekDay.LUNES, '08:00', '18:00')];

  it('acepta un trabajo que empieza al abrir y termina al cerrar', () => {
    expect(isWithinSchedules(lunes, at('2026-11-23T12:00:00Z'), 600)).toBe(
      true,
    );
  });

  it('rechaza un trabajo que se pasa del cierre por un minuto', () => {
    expect(isWithinSchedules(lunes, at('2026-11-23T12:00:00Z'), 601)).toBe(
      false,
    );
  });

  it('rechaza empezar un segundo antes de abrir', () => {
    expect(isWithinSchedules(lunes, at('2026-11-23T11:59:59Z'), 60)).toBe(
      false,
    );
  });

  it('acepta un minuto justo antes del cierre y rechaza dos', () => {
    expect(isWithinSchedules(lunes, at('2026-11-23T21:59:00Z'), 1)).toBe(true);
    expect(isWithinSchedules(lunes, at('2026-11-23T21:59:00Z'), 2)).toBe(false);
  });

  it('rechaza una duracion negativa', () => {
    expect(isWithinSchedules(lunes, at('2026-11-23T12:00:00Z'), -30)).toBe(
      false,
    );
  });
});

describe('isWithinSchedules: medianoche y cambio de semana', () => {
  it('un trabajo que cruza la medianoche local exige ambos tramos contiguos', () => {
    const contiguo = [
      row(WeekDay.MIERCOLES, '18:00', '24:00'),
      row(WeekDay.JUEVES, '00:00', '06:00'),
    ];
    // Miercoles 2026-11-25 22:00 local = jueves 02:00 UTC; 4 h -> jueves 02:00 local.
    expect(isWithinSchedules(contiguo, at('2026-11-26T02:00:00Z'), 240)).toBe(
      true,
    );
    const conHueco = [
      row(WeekDay.MIERCOLES, '18:00', '24:00'),
      row(WeekDay.JUEVES, '00:01', '06:00'),
    ];
    expect(isWithinSchedules(conHueco, at('2026-11-26T02:00:00Z'), 240)).toBe(
      false,
    );
  });

  it('un tramo hasta las 24:00 no cubre el dia siguiente sin tramo propio', () => {
    const soloMiercoles = [row(WeekDay.MIERCOLES, '18:00', '24:00')];
    expect(
      isWithinSchedules(soloMiercoles, at('2026-11-26T02:00:00Z'), 240),
    ).toBe(false);
    // Hasta las 24:00 si cabe: 22:00 local + 120 min.
    expect(
      isWithinSchedules(soloMiercoles, at('2026-11-26T02:00:00Z'), 120),
    ).toBe(true);
  });

  it('une DOMINGO con LUNES al terminar la semana', () => {
    const rows = [
      row(WeekDay.DOMINGO, '20:00', '24:00'),
      row(WeekDay.LUNES, '00:00', '08:00'),
    ];
    // Domingo 2026-11-29 22:00 local = lunes 02:00 UTC; 6 h -> lunes 04:00 local.
    expect(isWithinSchedules(rows, at('2026-11-30T02:00:00Z'), 360)).toBe(true);
    expect(isWithinSchedules(rows, at('2026-11-30T02:00:00Z'), 600)).toBe(
      true,
    );
    expect(isWithinSchedules(rows, at('2026-11-30T02:00:00Z'), 601)).toBe(
      false,
    );
  });

  it('un trabajo de varios dias cabe si toda la franja es continua', () => {
    const rows = [
      row(WeekDay.VIERNES, '00:00', '24:00'),
      row(WeekDay.SABADO, '00:00', '24:00'),
    ];
    // Viernes 2026-11-27 12:00 local: quedan 12 h de viernes + 24 h de sabado.
    expect(isWithinSchedules(rows, at('2026-11-27T16:00:00Z'), 36 * 60)).toBe(
      true,
    );
    expect(isWithinSchedules(rows, at('2026-11-27T16:00:00Z'), 37 * 60)).toBe(
      false,
    );
  });

  it('usa el dia local, no el dia UTC: 03:00 UTC del martes es lunes por la noche', () => {
    const lunesNoche = [row(WeekDay.LUNES, '22:00', '24:00')];
    expect(isWithinSchedules(lunesNoche, at('2026-11-24T03:00:00Z'), 60)).toBe(
      true,
    );
    const martes = [row(WeekDay.MARTES, '00:00', '24:00')];
    expect(isWithinSchedules(martes, at('2026-11-24T03:00:00Z'), 60)).toBe(
      false,
    );
  });
});

describe('isWithinSchedules: varios intervalos y estado activo', () => {
  it('un intervalo inactivo en medio rompe la continuidad', () => {
    const rows = [
      row(WeekDay.LUNES, '08:00', '12:00'),
      row(WeekDay.LUNES, '12:00', '14:00', false),
      row(WeekDay.LUNES, '14:00', '18:00'),
    ];
    // 11:00 local por 4 h cruza la pausa inactiva.
    expect(isWithinSchedules(rows, at('2026-11-23T15:00:00Z'), 240)).toBe(
      false,
    );
    // 14:00 local por 4 h cabe en el ultimo tramo.
    expect(isWithinSchedules(rows, at('2026-11-23T18:00:00Z'), 240)).toBe(true);
  });

  it('no depende del orden en que llegan los intervalos', () => {
    const rows = [
      row(WeekDay.LUNES, '12:00', '18:00'),
      row(WeekDay.LUNES, '08:00', '12:00'),
    ];
    expect(isWithinSchedules(rows, at('2026-11-23T15:00:00Z'), 120)).toBe(true);
  });

  it('el horario se repite cada semana', () => {
    const lunes = [row(WeekDay.LUNES, '08:00', '18:00')];
    expect(isWithinSchedules(lunes, at('2026-11-30T12:00:00Z'), 60)).toBe(true);
    expect(isWithinSchedules(lunes, at('2026-12-07T12:00:00Z'), 60)).toBe(true);
  });
});

describe('normalizeSchedules: limites', () => {
  it('acepta un dia completo 00:00-24:00', () => {
    expect(
      normalizeSchedules([
        { dayOfWeek: WeekDay.SABADO, startTime: '00:00', endTime: '24:00' },
      ]),
    ).toEqual([
      {
        dayOfWeek: WeekDay.SABADO,
        startMinutes: 0,
        endMinutes: 1440,
        isActive: true,
      },
    ]);
  });

  it('el mismo rango en dias distintos no es una superposicion', () => {
    expect(() =>
      normalizeSchedules([
        { dayOfWeek: WeekDay.LUNES, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: WeekDay.MARTES, startTime: '08:00', endTime: '12:00' },
      ]),
    ).not.toThrow();
  });

  it('un rango hasta 24:00 y otro del dia siguiente desde 00:00 son validos', () => {
    expect(() =>
      normalizeSchedules([
        { dayOfWeek: WeekDay.LUNES, startTime: '20:00', endTime: '24:00' },
        { dayOfWeek: WeekDay.MARTES, startTime: '00:00', endTime: '02:00' },
      ]),
    ).not.toThrow();
  });

  it('rechaza un rango escrito como cruce de medianoche (fin menor que inicio)', () => {
    expect(() =>
      normalizeSchedules([
        { dayOfWeek: WeekDay.LUNES, startTime: '22:00', endTime: '02:00' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('informa todos los problemas a la vez', () => {
    try {
      normalizeSchedules([
        { dayOfWeek: WeekDay.LUNES, startTime: '10:00', endTime: '09:00' },
        { dayOfWeek: WeekDay.MARTES, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: WeekDay.MARTES, startTime: '11:59', endTime: '13:00' },
      ]);
      expect.unreachable();
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(response.message).toHaveLength(2);
    }
  });

  it('dos intervalos contiguos (fin igual al inicio) no se superponen', () => {
    expect(() =>
      normalizeSchedules([
        { dayOfWeek: WeekDay.JUEVES, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: WeekDay.JUEVES, startTime: '12:00', endTime: '13:00' },
      ]),
    ).not.toThrow();
  });
});

describe('RF-31: el intervalo de un trabajo es [inicio, inicio + duracion)', () => {
  it('un minuto mas de duracion cambia el resultado en el borde', () => {
    const rows = [row(WeekDay.LUNES, '08:00', '10:00')];
    const start = at('2026-11-23T13:00:00Z'); // 09:00 local
    expect(isWithinSchedules(rows, start, 60)).toBe(true);
    expect(isWithinSchedules(rows, start, 61)).toBe(false);
  });
});
