import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, RoleName } from '../../generated/prisma/enums.js';
import {
  AdvanceConfirmationRegistry,
  type AdvanceConfirmationVerifier,
} from './advance-confirmation.registry.js';
import type { OrderActor } from './order-history.js';
import type { OrderTransitionRequest } from './order-transition.js';
import { OrdersService } from './orders.service.js';

// Guarda de ACORDADO -> ANTICIPO_REGISTRADO en OrdersService.transition().

const ORDER = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const WORKER = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const CLIENT = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';

const user = (userId: string, role: RoleName): OrderActor => ({
  type: 'USUARIO',
  userId,
  role,
});
const assignedWorker = user(WORKER, RoleName.TRABAJADOR);

function setup({
  status = OrderStatus.ACORDADO as OrderStatus,
  verifier,
}: {
  status?: OrderStatus;
  verifier?: AdvanceConfirmationVerifier;
} = {}) {
  const tx = {
    $queryRaw: vi.fn(() =>
      Promise.resolve([
        {
          status,
          clientId: CLIENT,
          assignedWorkerId: WORKER,
          expired: false,
        },
      ]),
    ),
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    orderStatusHistory: { create: vi.fn() },
  };
  const lifecycle = { runBeforeTransition: vi.fn() };
  const registry = new AdvanceConfirmationRegistry();
  if (verifier) {
    registry.register(verifier);
  }
  const unused = {} as never;
  const service = new OrdersService(
    unused,
    unused,
    unused,
    unused,
    unused,
    lifecycle as never,
    unused,
    unused,
    unused,
    registry,
    unused,
    unused,
  );
  const transition = (
    actor: OrderActor,
    to: OrderStatus = OrderStatus.ANTICIPO_REGISTRADO,
  ) =>
    service.transition(
      tx as never,
      {
        orderId: ORDER,
        to,
        actor,
      } as OrderTransitionRequest,
    );
  const unchanged = () => {
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  };
  return { tx, transition, unchanged };
}

const confirming = () => ({
  hasValidConfirmation: vi.fn(() => Promise.resolve(true)),
});

describe('OrdersService.transition: ACORDADO -> ANTICIPO_REGISTRADO', () => {
  it('permite al trabajador asignado con confirmacion valida, verificada en la misma transaccion', async () => {
    const verifier = confirming();
    const { tx, transition } = setup({ verifier });

    await expect(transition(assignedWorker)).resolves.toMatchObject({
      toStatus: OrderStatus.ANTICIPO_REGISTRADO,
      assignedWorkerId: WORKER,
    });
    expect(verifier.hasValidConfirmation).toHaveBeenCalledWith(tx, {
      orderId: ORDER,
      workerId: WORKER,
    });
    // El pedido se bloquea antes de verificar la confirmacion.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      verifier.hasValidConfirmation.mock.invocationCallOrder[0],
    );
    expect(tx.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('rechaza al trabajador asignado sin confirmacion (409)', async () => {
    const { transition, unchanged } = setup({
      verifier: { hasValidConfirmation: () => Promise.resolve(false) },
    });
    await expect(transition(assignedWorker)).rejects.toBeInstanceOf(
      ConflictException,
    );
    unchanged();
  });

  it('sin verificador registrado rechaza (cerrado por defecto)', async () => {
    const { transition, unchanged } = setup();
    await expect(transition(assignedWorker)).rejects.toBeInstanceOf(
      ConflictException,
    );
    unchanged();
  });

  it.each<[string, OrderActor]>([
    ['el cliente', user(CLIENT, RoleName.CLIENTE)],
    ['un administrador', user('admin', RoleName.ADMINISTRADOR)],
    ['el sistema', { type: 'SISTEMA', process: 'OTRO_MODULO' }],
    ['otro trabajador', user('otro', RoleName.TRABAJADOR)],
    ['el asignado actuando como cliente', user(WORKER, RoleName.CLIENTE)],
    [
      'el asignado actuando como administrador',
      user(WORKER, RoleName.ADMINISTRADOR),
    ],
    [
      'el cliente haciendose pasar por trabajador',
      user(CLIENT, RoleName.TRABAJADOR),
    ],
  ])('rechaza a %s aunque exista confirmacion (403)', async (_name, actor) => {
    const verifier = confirming();
    const { transition, unchanged } = setup({ verifier });
    await expect(transition(actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(verifier.hasValidConfirmation).not.toHaveBeenCalled();
    unchanged();
  });

  it.each([
    [OrderStatus.ANTICIPO_REGISTRADO, OrderStatus.EN_EJECUCION],
    [OrderStatus.EN_EJECUCION, OrderStatus.TERMINADO],
    [OrderStatus.TERMINADO, OrderStatus.CERRADO],
  ])(
    'no exige confirmacion ni trabajador para %s -> %s',
    async (status, to) => {
      const verifier = confirming();
      const { transition } = setup({ status, verifier });
      await expect(
        transition({ type: 'SISTEMA', process: 'PRUEBA' }, to),
      ).resolves.toMatchObject({ toStatus: to });
      expect(verifier.hasValidConfirmation).not.toHaveBeenCalled();
    },
  );

  it('admite un solo verificador', () => {
    const registry = new AdvanceConfirmationRegistry();
    registry.register(confirming());
    expect(() => registry.register(confirming())).toThrow();
  });
});
