import { countBy, toCsv, toReportRange } from './report-format.js';

describe('toReportRange (RF-52)', () => {
  it('cubre ambos dias completos en hora de Bolivia', () => {
    expect(toReportRange('2026-11-01', '2026-11-30')).toEqual({
      start: new Date('2026-11-01T04:00:00.000Z'),
      end: new Date('2026-12-01T04:00:00.000Z'),
    });
  });

  it.each([
    ['2026-11-02', '2026-11-01'],
    ['2026-02-30', '2026-03-01'],
    ['2026-13-01', '2026-13-02'],
    ['ayer', '2026-11-01'],
  ])('rechaza el rango %s a %s', (from, to) => {
    expect(toReportRange(from, to)).toBeNull();
  });
});

describe('countBy', () => {
  it('agrupa filas iguales, cuenta y ordena', () => {
    expect(
      countBy([
        ['Plomeria', 'Sur'],
        ['Electricidad', 'Norte'],
        ['Plomeria', 'Sur'],
      ]),
    ).toEqual([
      ['Electricidad', 'Norte', 1],
      ['Plomeria', 'Sur', 2],
    ]);
    expect(countBy([])).toEqual([]);
  });
});

describe('toCsv', () => {
  it('escapa comas, comillas y saltos de linea', () => {
    expect(toCsv(['a', 'total'], [['Norte, "Alto"\nSur', 2]])).toBe(
      '﻿a,total\r\n"Norte, ""Alto""\nSur",2\r\n',
    );
  });

  it.each(['=1+1', '+SUM(A1)', '-2', '@cmd'])(
    'neutraliza el texto %s para que no se ejecute como formula',
    (text) => {
      expect(toCsv(['a'], [[text]])).toContain(`'${text}`);
    },
  );
});
