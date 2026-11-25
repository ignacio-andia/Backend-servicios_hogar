import type { Prisma } from '../../generated/prisma/client.js';
import {
  OfferEventRegistry,
  type OfferNegotiationEvent,
} from './offer-events.registry.js';

const event: OfferNegotiationEvent = {
  type: 'PROPUESTA',
  offerId: 'o1',
  orderId: 'p1',
  workerId: 'w1',
  clientId: 'c1',
  actorId: 'w1',
  round: 1,
  amount: '100.00',
};
const tx = {} as Prisma.TransactionClient;

describe('OfferEventRegistry', () => {
  it('sin hooks no hace nada', async () => {
    const registry = new OfferEventRegistry();
    expect(registry.hasHooks).toBe(false);
    await expect(
      registry.runInTransaction([event], tx),
    ).resolves.toBeUndefined();
  });

  it('pasa el cliente de la transaccion a cada hook, en orden de registro', async () => {
    const registry = new OfferEventRegistry();
    const calls: string[] = [];
    registry.register({
      name: 'a',
      inTransaction: (e, db) => {
        expect(db).toBe(tx);
        calls.push(`a:${e.type}`);
        return Promise.resolve();
      },
    });
    registry.register({
      name: 'b',
      inTransaction: (e) => {
        calls.push(`b:${e.type}`);
        return Promise.resolve();
      },
    });
    expect(registry.hasHooks).toBe(true);
    await registry.runInTransaction([event], tx);
    expect(calls).toEqual(['a:PROPUESTA', 'b:PROPUESTA']);
  });

  it('un hook que falla propaga el error (la transaccion del hecho se revierte)', async () => {
    const registry = new OfferEventRegistry();
    registry.register({
      name: 'falla',
      inTransaction: () => Promise.reject(new Error('fallo')),
    });
    await expect(registry.runInTransaction([event], tx)).rejects.toThrow(
      'fallo',
    );
  });

  it('no admite dos hooks con el mismo nombre', () => {
    const registry = new OfferEventRegistry();
    const hooks = { name: 'x', inTransaction: () => Promise.resolve() };
    registry.register(hooks);
    expect(() => registry.register(hooks)).toThrow();
  });
});
