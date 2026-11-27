//=========================================================
// NUEVO: orders-cancellation-expiry.spec.ts
// Fase B5 (cancelacion): pruebas unitarias de la decision del vencimiento
// despues del bloqueo (statusAfterLock y su uso en las dos rutas).
// Reglas: manda la hora real posterior al bloqueo; solo vencen PUBLICADO y
// EN_NEGOCIACION; un rechazo no escribe nada. La espera real en PostgreSQL se
// prueba en los E2E.
//=========================================================
import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../../generated/prisma/enums.js';
import { OrderLifecycleRegistry } from './order-lifecycle.registry.js';
import {
  ORDER_EXPIRABLE_STATUSES,
  type OrderCancellationKind,
} from './orders.rules.js';
import { OrdersService, statusAfterLock } from './orders.service.js';

/**
 * El bloqueo dice «vigente» (now() de antes de esperar) y la consulta
 * posterior responde `expiredNow`.
 */
function setup(status: OrderStatus, expiredNow: boolean) {
  const queries: string[] = [];
  const tx = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      queries.push(sql);
      return Promise.resolve(
        sql.includes('clock_timestamp')
          ? [{ expired: expiredNow }]
          : [
              {
                status,
                clientId: 'cliente',
                assignedWorkerId: null,
                expired: false,
              },
            ],
      );
    }),
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    orderStatusHistory: { create: vi.fn() },
  };
  const lifecycle = new OrderLifecycleRegistry();
  const inTransaction = vi
    .spyOn(lifecycle, 'runInTransaction')
    .mockResolvedValue();
  vi.spyOn(lifecycle, 'runAfterCommit').mockResolvedValue();
  const retention = { cleanupClosedOrder: vi.fn().mockResolvedValue([]) };
  const unused = {} as never;
  const service = new OrdersService(
    {
      $transaction: (work: (client: typeof tx) => unknown) => work(tx),
    } as never,
    unused,
    unused,
    unused,
    { processNow: vi.fn() } as never,
    lifecycle,
    unused,
    unused,
    retention as never,
    unused,
    unused,
    unused,
  );
  vi.spyOn(service, 'getOwn').mockResolvedValue({} as never);
  const cancel = (kind: OrderCancellationKind) =>
    kind === 'SIN_ACUERDO'
      ? service.cancel('cliente', 'pedido', { reason: 'motivo' })
      : service.cancelAgreedWork('cliente', 'pedido', 'motivo');
  return { tx, queries, inTransaction, retention, cancel };
}

describe('statusAfterLock', () => {
  it.each(Object.values(OrderStatus))(
    '%s: solo consulta la hora si el estado puede vencer',
    async (status) => {
      const { tx, queries } = setup(status, true);
      const result = await statusAfterLock(tx as never, 'pedido', { status });
      const expirable = ORDER_EXPIRABLE_STATUSES.includes(status);
      expect(result).toBe(expirable ? OrderStatus.VENCIDO : status);
      expect(queries).toHaveLength(expirable ? 1 : 0);
    },
  );

  it('usa la hora real de la base, no la de inicio de la transaccion', async () => {
    const { tx, queries } = setup(OrderStatus.PUBLICADO, false);
    await expect(
      statusAfterLock(tx as never, 'pedido', {
        status: OrderStatus.PUBLICADO,
      }),
    ).resolves.toBe(OrderStatus.PUBLICADO);
    expect(queries[0]).toContain('"expires_at" <= clock_timestamp()');
    expect(queries[0]).not.toContain('now()');
    expect(queries[0]).not.toContain('FOR UPDATE');
  });
});

describe('Cancelacion de un pedido que vence mientras espera el bloqueo', () => {
  describe.each(['SIN_ACUERDO', 'CON_ACUERDO'] as const)('%s', (kind) => {
    it.each(ORDER_EXPIRABLE_STATUSES)(
      'desde %s responde 409 sin escribir nada',
      async (status) => {
        const t = setup(status, true);
        await expect(t.cancel(kind)).rejects.toBeInstanceOf(ConflictException);
        expect(t.tx.$executeRaw).not.toHaveBeenCalled();
        expect(t.tx.orderStatusHistory.create).not.toHaveBeenCalled();
        expect(t.inTransaction).not.toHaveBeenCalled();
        expect(t.retention.cleanupClosedOrder).not.toHaveBeenCalled();
        // Primero el bloqueo y despues la hora.
        expect(t.queries).toHaveLength(2);
        expect(t.queries[0]).toContain('FOR UPDATE');
        expect(t.queries[1]).toContain('clock_timestamp()');
      },
    );
  });

  it('si sigue vigente despues del bloqueo, cancela', async () => {
    const t = setup(OrderStatus.EN_NEGOCIACION, false);
    await t.cancel('SIN_ACUERDO');
    expect(t.tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('un pedido con acuerdo no vence: no se consulta la hora', async () => {
    const t = setup(OrderStatus.ACORDADO, true);
    await t.cancel('CON_ACUERDO');
    expect(t.queries).toHaveLength(1);
    expect(t.tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });
});
