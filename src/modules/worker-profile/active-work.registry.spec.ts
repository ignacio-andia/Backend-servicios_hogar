import type { Prisma } from '../../generated/prisma/client.js';
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from './active-work.registry.js';

const BOTH = [ActiveWorkKind.PEDIDOS, ActiveWorkKind.OFERTAS];
const tx = { $queryRaw: vi.fn() } as unknown as Prisma.TransactionClient;

describe('WorkerActiveWorkRegistry', () => {
  it('sin fuentes registradas informa que no se puede verificar', async () => {
    const registry = new WorkerActiveWorkRegistry();

    await expect(registry.check('u', BOTH, tx)).resolves.toEqual({
      verifiable: false,
      missingSources: [ActiveWorkKind.PEDIDOS, ActiveWorkKind.OFERTAS],
    });
  });

  it('con una sola fuente sigue sin poder verificar y no la consulta', async () => {
    const registry = new WorkerActiveWorkRegistry();
    const countActive = vi.fn().mockResolvedValue(0);
    registry.register({ kind: ActiveWorkKind.PEDIDOS, countActive });

    await expect(registry.check('u', BOTH, tx)).resolves.toEqual({
      verifiable: false,
      missingSources: [ActiveWorkKind.OFERTAS],
    });
    expect(countActive).not.toHaveBeenCalled();
  });

  it('consulta cada fuente con la transaccion del llamador', async () => {
    const registry = new WorkerActiveWorkRegistry();
    registry.register({
      kind: ActiveWorkKind.PEDIDOS,
      countActive: vi.fn().mockResolvedValue(2),
    });
    const offers = vi.fn().mockResolvedValue(0);
    registry.register({ kind: ActiveWorkKind.OFERTAS, countActive: offers });

    await expect(registry.check('worker-1', BOTH, tx)).resolves.toEqual({
      verifiable: true,
      counts: { PEDIDOS: 2, OFERTAS: 0 },
    });
    expect(offers).toHaveBeenCalledWith('worker-1', tx);
  });

  it('no admite dos fuentes del mismo tipo', () => {
    const registry = new WorkerActiveWorkRegistry();
    const source = {
      kind: ActiveWorkKind.OFERTAS,
      countActive: vi.fn(),
    };
    registry.register(source);

    expect(() => registry.register(source)).toThrow(/OFERTAS/);
  });

  it('lockWorker bloquea la fila del perfil con SELECT ... FOR UPDATE', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const db = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await new WorkerActiveWorkRegistry().lockWorker(db, 'worker-1');

    const [strings, userId] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      string,
    ];
    expect(strings.join('?')).toMatch(
      /FROM "worker_profiles" WHERE "user_id" = \?::uuid FOR UPDATE/,
    );
    expect(userId).toBe('worker-1');
  });
});
