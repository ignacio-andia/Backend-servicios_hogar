import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, RoleName } from '../../generated/prisma/enums.js';
import { AcceptedOfferRegistry } from './accepted-offer.registry.js';
import { AdvanceConfirmationRegistry } from './advance-confirmation.registry.js';
import { OpenNegotiationRegistry } from './open-negotiation.registry.js';
import { OrdersService } from './orders.service.js';

// RF-13 en OrdersService.transition(): asignar continuando una negociacion
// abierta no lo impide un cambio de zona pendiente; asignar sin ella, si.

const ORDER = 'pedido';
const WORKER = 'trabajador';
const CLIENT = 'cliente';

function setup({
  negotiation,
  accepted = false,
}: { negotiation?: boolean; accepted?: boolean } = {}) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(() => {
      calls.push('pedido');
      return Promise.resolve([
        {
          status: OrderStatus.EN_NEGOCIACION,
          clientId: CLIENT,
          assignedWorkerId: null,
          expired: false,
        },
      ]);
    }),
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    orderStatusHistory: { create: vi.fn() },
  };
  const workerProfiles = {
    lockApprovedWorker: vi.fn(),
    lockApprovedWorkerForAgreedWork: vi.fn(() => {
      calls.push('trabajador');
      return Promise.resolve({ profileId: 'perfil' });
    }),
    assertNoPendingZoneChange: vi.fn(() =>
      Promise.reject(new ConflictException('cambio de zona pendiente')),
    ),
  };
  const openNegotiations = new OpenNegotiationRegistry();
  if (negotiation !== undefined) {
    openNegotiations.register({
      hasOpenNegotiation: () => {
        calls.push('negociacion');
        return Promise.resolve(negotiation);
      },
      findOpenOrderIds: () => Promise.resolve([]),
    });
  }
  const acceptedOffers = new AcceptedOfferRegistry();
  acceptedOffers.register({
    hasAcceptedOffer: () => Promise.resolve(accepted),
  });
  const unused = {} as never;
  const service = new OrdersService(
    unused,
    unused,
    unused,
    unused,
    unused,
    { runBeforeTransition: vi.fn(), runInTransaction: vi.fn() } as never,
    workerProfiles as never,
    unused,
    unused,
    new AdvanceConfirmationRegistry(),
    openNegotiations,
    acceptedOffers,
  );
  const assign = () =>
    service.transition(tx as never, {
      orderId: ORDER,
      to: OrderStatus.ACORDADO,
      actor: { type: 'USUARIO', userId: CLIENT, role: RoleName.CLIENTE },
      assignWorkerId: WORKER,
    });
  return { assign, workerProfiles, calls, tx };
}

describe('OrdersService.transition: asignacion y cambio de zona (RF-13)', () => {
  it('con una negociacion abierta asigna sin mirar el cambio de zona', async () => {
    const { assign, workerProfiles, calls, tx } = setup({
      negotiation: true,
      accepted: true,
    });

    await assign();

    expect(workerProfiles.assertNoPendingZoneChange).not.toHaveBeenCalled();
    expect(workerProfiles.lockApprovedWorker).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    // Orden de bloqueos: trabajador, pedido y despues la negociacion.
    expect(calls).toEqual(['trabajador', 'pedido', 'negociacion']);
  });

  it.each([
    ['sin oferta abierta en el pedido', false],
    ['sin verificador registrado', undefined],
  ])('%s es trabajo nuevo: lo impide (409)', async (_case, negotiation) => {
    const { assign, workerProfiles, tx } = setup({ negotiation });

    await expect(assign()).rejects.toThrow('cambio de zona pendiente');

    expect(workerProfiles.assertNoPendingZoneChange).toHaveBeenCalledWith(
      tx,
      'perfil',
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('una negociacion abierta sin oferta aceptada no asigna el pedido', async () => {
    const { assign, workerProfiles, tx } = setup({ negotiation: true });

    await expect(assign()).rejects.toThrow('sin una oferta aceptada');

    expect(workerProfiles.assertNoPendingZoneChange).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('con la oferta aceptada asigna aunque ya no conste como negociacion abierta', async () => {
    const { assign, workerProfiles, tx } = setup({
      negotiation: false,
      accepted: true,
    });

    await assign();

    expect(workerProfiles.assertNoPendingZoneChange).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('un trabajador no habilitado no se asigna aunque tenga negociacion abierta', async () => {
    const { assign, workerProfiles, tx } = setup({ negotiation: true });
    workerProfiles.lockApprovedWorkerForAgreedWork.mockRejectedValue(
      new ForbiddenException('perfil no aprobado'),
    );

    await expect(assign()).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
