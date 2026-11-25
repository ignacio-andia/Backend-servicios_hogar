// Reglas puras de los reportes (RF-52): rango de fechas, agrupacion y CSV.

/** Bolivia no usa horario de verano: America/La_Paz es siempre UTC-4. */
const LA_PAZ_OFFSET = '-04:00';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Intervalo semiabierto [start, end) que cubre los dias `from` a `to`. */
export interface ReportRange {
  start: Date;
  end: Date;
}

/** null si alguna fecha no existe o `from` es posterior a `to`. */
export function toReportRange(from: string, to: string): ReportRange | null {
  const day = (value: string) => {
    const date = new Date(`${value}T00:00:00${LA_PAZ_OFFSET}`);
    // Rechaza fechas inexistentes, como 2026-02-30.
    return !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
      ? date
      : null;
  };
  const start = day(from);
  const last = day(to);
  if (!start || !last || start > last) {
    return null;
  }
  return { start, end: new Date(last.getTime() + DAY_MS) };
}

export type ReportCell = string | number;

/** Cuenta las filas que coinciden en todas las columnas y ordena el resultado. */
export function countBy(rows: ReportCell[][]): ReportCell[][] {
  const groups = new Map<string, { row: ReportCell[]; total: number }>();
  for (const row of rows) {
    const key = JSON.stringify(row);
    const group = groups.get(key);
    if (group) {
      group.total += 1;
    } else {
      groups.set(key, { row, total: 1 });
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'es'))
    .map(([, { row, total }]) => [...row, total]);
}

/**
 * CSV (RFC 4180) con marca UTF-8 para hojas de calculo. Un texto que empiece
 * como formula se antepone con un apostrofo.
 */
export function toCsv(columns: string[], rows: ReportCell[][]): string {
  const cell = (value: ReportCell) => {
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) {
      text = `'${text}`;
    }
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `﻿${[columns, ...rows]
    .map((row) => row.map(cell).join(','))
    .join('\r\n')}\r\n`;
}
