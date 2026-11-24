import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderStatus, RoleName } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { buildTimelinePage } from './timeline-page.js';
import { TimelineSourceRegistry } from './timeline-source.registry.js';
import { TimelineService } from './timeline.service.js';
import type { TimelineEvent, TimelineSource } from './timeline.types.js';

const event = (
  source: string,
  id: string,
  iso: string,
  type = 'X',
): TimelineEvent => ({
  id,
  source,
  type,
  at: new Date(iso),
  actor: { type: 'SISTEMA', process: 'TEST' },
  summary: `${source}:${id}`,
});

describe('buildTimelinePage', () => {
  const events = [
    event('b', '1', '2026-11-24T10:00:00Z'),
    event('a', '2', '2026-11-24T09:00:00Z'),
    event('a', '1', '2026-11-24T10:00:00Z'),
    event('b', '2', '2026-11-24T11:00:00Z'),
  ];

  it('une fuentes y ordena de la mas antigua a la mas reciente', () => {
    const page = buildTimelinePage(events);
    expect(page.data.map((e) => e.summary)).toEqual([
      'a:2',
      'a:1', // mismo instante que b:1: desempata la fuente
      'b:1',
      'b:2',
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('el orden no depende de como llegan los eventos', () => {
    const reversed = buildTimelinePage([...events].reverse());
    expect(reversed.data.map((e) => e.summary)).toEqual(
      buildTimelinePage(events).data.map((e) => e.summary),
    );
  });

  it('pagina por cursor sin repetir ni saltar eventos', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = buildTimelinePage(events, { limit: 1, cursor });
      seen.push(...page.data.map((e) => e.summary));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['a:2', 'a:1', 'b:1', 'b:2']);
    expect(pages).toBe(4);
  });

  it('descarta duplicados de la misma fuente e id', () => {
    const page = buildTimelinePage([
      event('a', '1', '2026-11-24T09:00:00Z'),
      event('a', '1', '2026-11-24T09:00:00Z'),
    ]);
    expect(page.data).toHaveLength(1);
  });

  it('un cursor mas alla del final devuelve una pagina vacia', () => {
    const last = buildTimelinePage(events, { limit: 4 }).data[3];
    const firstPage = buildTimelinePage(events, { limit: 3 });
    expect(firstPage.nextCursor).not.toBeNull();
    const tail = buildTimelinePage(events, {
      limit: 3,
      cursor: firstPage.nextCursor!,
    });
    expect(tail.data).toEqual([last]);
    expect(tail.nextCursor).toBeNull();
  });

  it('rechaza cursores invalidos y limites fuera de rango', () => {
    expect(() => buildTimelinePage(events, { cursor: 'no-es-un-cursor' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      buildTimelinePage(events, {
        cursor: Buffer.from('{"at":"x"}').toString('base64url'),
      }),
    ).toThrow(BadRequestException);
    expect(() => buildTimelinePage(events, { limit: 0 })).toThrow(
      BadRequestException,
    );
    expect(() => buildTimelinePage(events, { limit: 101 })).toThrow(
      BadRequestException,
    );
  });

  it('sin eventos devuelve una pagina vacia', () => {
    expect(buildTimelinePage([])).toEqual({ data: [], nextCursor: null });
  });
});

describe('TimelineSourceRegistry', () => {
  it('no admite dos fuentes con el mismo nombre', () => {
    const registry = new TimelineSourceRegistry();
    const source: TimelineSource = { name: 'orders', listEvents: async () => [] };
    registry.register(source);
    expect(() => registry.register(source)).toThrow();
    expect(registry.list()).toHaveLength(1);
  });
});

describe('TimelineService (RF-32)', () => {
  const CLIENT = 'client-1';
  const WORKER = 'worker-1';
  const tx = {};
  const prisma = {
    $transaction: vi.fn((fn: (db: object) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  let registry: TimelineSourceRegistry;
  let findParticipants: ReturnType<typeof vi.fn>;
  let service: TimelineService;

  beforeEach(() => {
    registry = new TimelineSourceRegistry();
    registry.register({
      name: 'orders',
      listEvents: async () => [event('orders', '1', '2026-11-24T09:00:00Z')],
    });
    registry.register({
      name: 'payments',
      listEvents: async () => [event('payments', '1', '2026-11-24T10:00:00Z')],
    });
    findParticipants = vi.fn().mockResolvedValue({
      orderId: 'o1',
      clientId: CLIENT,
      assignedWorkerId: WORKER,
      status: OrderStatus.ACORDADO,
    });
    service = new TimelineService(prisma, registry, { findParticipants });
  });

  const viewer = (userId: string, ...roles: RoleName[]) => ({ userId, roles });

  it('el cliente y el trabajador asignado ven la linea de tiempo', async () => {
    for (const id of [CLIENT, WORKER]) {
      const page = await service.getTimeline(
        viewer(id, RoleName.CLIENTE),
        'o1',
      );
      expect(page.data).toHaveLength(2);
    }
  });

  it('un administrador ve cualquier pedido', async () => {
    const page = await service.getTimeline(
      viewer('admin', RoleName.ADMINISTRADOR),
      'o1',
    );
    expect(page.data).toHaveLength(2);
  });

  it('un tercero recibe 404, igual que un pedido inexistente', async () => {
    await expect(
      service.getTimeline(viewer('otro', RoleName.TRABAJADOR), 'o1'),
    ).rejects.toThrow(NotFoundException);
    findParticipants.mockResolvedValue(null);
    await expect(
      service.getTimeline(viewer(CLIENT, RoleName.CLIENTE), 'o1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('no consulta las fuentes si el usuario no tiene acceso', async () => {
    const listEvents = vi.fn().mockResolvedValue([]);
    registry.register({ name: 'spy', listEvents });
    await expect(
      service.getTimeline(viewer('otro', RoleName.CLIENTE), 'o1'),
    ).rejects.toThrow(NotFoundException);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('una fuente que falla hace fallar la consulta completa (no oculta eventos)', async () => {
    registry.register({
      name: 'rota',
      listEvents: async () => {
        throw new Error('falla');
      },
    });
    await expect(
      service.getTimeline(viewer(CLIENT, RoleName.CLIENTE), 'o1'),
    ).rejects.toThrow('falla');
  });

  it('sin fuentes registradas devuelve una linea de tiempo vacia, no inventa eventos', async () => {
    service = new TimelineService(prisma, new TimelineSourceRegistry(), {
      findParticipants,
    });
    const page = await service.getTimeline(
      viewer(CLIENT, RoleName.CLIENTE),
      'o1',
    );
    expect(page.data).toEqual([]);
  });
});
