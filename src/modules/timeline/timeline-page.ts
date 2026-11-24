import { BadRequestException } from '@nestjs/common';
import type { TimelineEvent, TimelinePage } from './timeline.types.js';

export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 100;

interface CursorKey {
  at: number;
  source: string;
  id: string;
}

/** Orden total y estable: fecha, luego fuente, luego id. */
export function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  return (
    a.at.getTime() - b.at.getTime() ||
    (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function encodeCursor(event: TimelineEvent): string {
  const key: CursorKey = {
    at: event.at.getTime(),
    source: event.source,
    id: event.id,
  };
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor: string): CursorKey {
  try {
    const key = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<CursorKey>;
    if (
      typeof key.at !== 'number' ||
      !Number.isFinite(key.at) ||
      typeof key.source !== 'string' ||
      typeof key.id !== 'string'
    ) {
      throw new Error('cursor invalido');
    }
    return key as CursorKey;
  } catch {
    throw new BadRequestException(
      'El cursor de la línea de tiempo no es válido.',
    );
  }
}

/**
 * Une los eventos de varias fuentes, los ordena cronologicamente (el mas
 * antiguo primero, como el flujo de CU-32) y devuelve una pagina por cursor.
 * Un evento repetido (misma fuente e id) se cuenta una sola vez.
 */
export function buildTimelinePage(
  events: readonly TimelineEvent[],
  options: { limit?: number; cursor?: string } = {},
): TimelinePage {
  const limit = options.limit ?? TIMELINE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TIMELINE_MAX_LIMIT) {
    throw new BadRequestException(
      `limit debe ser un entero entre 1 y ${TIMELINE_MAX_LIMIT}.`,
    );
  }
  const unique = new Map<string, TimelineEvent>();
  for (const event of events) {
    unique.set(`${event.source}\u0000${event.id}`, event);
  }
  const sorted = [...unique.values()].sort(compareEvents);

  let start = 0;
  if (options.cursor !== undefined) {
    const key = decodeCursor(options.cursor);
    const after = (event: TimelineEvent) =>
      compareEvents(event, {
        ...event,
        at: new Date(key.at),
        source: key.source,
        id: key.id,
      }) > 0;
    start = sorted.findIndex(after);
    if (start === -1) {
      start = sorted.length;
    }
  }
  const data = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  return {
    data,
    nextCursor: hasMore ? encodeCursor(data[data.length - 1]) : null,
  };
}
