import { OfferStatus } from '../../generated/prisma/enums.js';
import { AcceptedOfferRegistry } from '../orders/accepted-offer.registry.js';
import { OffersAcceptedOfferSource } from './offers-accepted-offer.source.js';

const input = { orderId: 'pedido', workerId: 'trabajador' };

describe('oferta aceptada como condicion de ACORDADO', () => {
  const setup = () => {
    const registry = new AcceptedOfferRegistry();
    new OffersAcceptedOfferSource(registry).onModuleInit();
    return registry;
  };

  it.each([
    [1, true],
    [0, false],
  ])(
    'busca la oferta ACEPTADA de ese pedido y trabajador (%i)',
    async (n, expected) => {
      const tx = { offer: { count: vi.fn().mockResolvedValue(n) } };

      await expect(setup().has(tx as never, input)).resolves.toBe(expected);
      expect(tx.offer.count).toHaveBeenCalledWith({
        where: { ...input, status: OfferStatus.ACEPTADA },
      });
    },
  );

  it('sin nadie registrado ningun pedido puede pasar a ACORDADO', async () => {
    await expect(
      new AcceptedOfferRegistry().has({} as never, input),
    ).resolves.toBe(false);
  });

  it('admite un solo verificador', () => {
    const registry = setup();
    expect(() =>
      registry.register({ hasAcceptedOffer: () => Promise.resolve(true) }),
    ).toThrow();
  });
});
