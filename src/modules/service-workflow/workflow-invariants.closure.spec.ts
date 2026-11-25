import { ConflictException } from '@nestjs/common';
import { OrderStatus, RoleName } from '../../generated/prisma/enums.js';
import type { OrderActor } from '../orders/order-history.js';
import { OrderLifecycleRegistry } from '../orders/order-lifecycle.registry.js';
import { WorkflowInvariantHooks } from './workflow-invariants.hooks.js';
import { CONFORMITY_CLOSURE_PROCESS } from './workflow-support.js';

// Quien puede declarar terminado un trabajo y cerrarlo (RF-28), cualquiera
// que sea el modulo que llame a OrdersService.transition().

const ORDER = 'pedido';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const PAST = new Date('2026-11-24T12:00:00.000Z');
const FUTURE = new Date('2026-11-30T12:00:00.000Z');

const user = (userId: string, role: RoleName): OrderActor => ({
  type: 'USUARIO',
  userId,
  role,
});
const client = user('cliente', RoleName.CLIENTE);
const worker = user('trabajador', RoleName.TRABAJADOR);
const system = (process: string): OrderActor => ({ type: 'SISTEMA', process });

function setup(execution: {
  conformedAt?: Date | null;
  conformityDeadline?: Date;
}) {
  const lifecycle = new OrderLifecycleRegistry();
  const orders = {
    findOrderSummary: vi.fn().mockResolvedValue({
      clientId: 'cliente',
      assignedWorkerId: 'trabajador',
    }),
  };
  new WorkflowInvariantHooks(
    lifecycle,
    {} as never,
    orders as never,
  ).onModuleInit();
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ now: NOW }]),
    orderExecution: {
      findUnique: vi.fn().mockResolvedValue({
        finishedAt: PAST,
        conformityDeadline: FUTURE,
        conformedAt: null,
        ...execution,
      }),
    },
    additionalBudget: { count: vi.fn().mockResolvedValue(0) },
  };
  const attempt = (toStatus: OrderStatus, actor: OrderActor) =>
    lifecycle.runBeforeTransition(
      {
        orderId: ORDER,
        fromStatus:
          toStatus === OrderStatus.CERRADO
            ? OrderStatus.TERMINADO
            : OrderStatus.EN_EJECUCION,
        toStatus,
        actor,
      },
      tx as never,
    );
  return { attempt };
}

describe('TERMINADO: solo lo declara el trabajador asignado', () => {
  it('el trabajador asignado puede', async () => {
    await expect(
      setup({}).attempt(OrderStatus.TERMINADO, worker),
    ).resolves.not.toThrow();
  });

  it.each([
    ['el cliente', client],
    ['otro trabajador', user('otro', RoleName.TRABAJADOR)],
    ['el sistema', system('OTRO_MODULO')],
  ])('%s no (409)', async (_who, actor) => {
    await expect(
      setup({}).attempt(OrderStatus.TERMINADO, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CERRADO desde TERMINADO: conformidad o cierre automatico', () => {
  const close = (
    actor: OrderActor,
    execution: Parameters<typeof setup>[0] = {},
  ) => setup(execution).attempt(OrderStatus.CERRADO, actor);

  it('el cliente con su conformidad registrada', async () => {
    await expect(close(client, { conformedAt: NOW })).resolves.not.toThrow();
  });

  it('el sistema con el plazo vencido y sin conformidad', async () => {
    await expect(
      close(system(CONFORMITY_CLOSURE_PROCESS), { conformityDeadline: PAST }),
    ).resolves.not.toThrow();
  });

  it.each<[string, OrderActor, Parameters<typeof setup>[0]]>([
    ['el cliente sin conformidad', client, {}],
    ['el trabajador aunque haya conformidad', worker, { conformedAt: NOW }],
    ['otro cliente', user('otro', RoleName.CLIENTE), { conformedAt: NOW }],
    [
      'el cierre automatico antes del plazo',
      system(CONFORMITY_CLOSURE_PROCESS),
      {},
    ],
    [
      'otro proceso del sistema con el plazo vencido',
      system('OTRO_MODULO'),
      { conformityDeadline: PAST },
    ],
  ])('rechaza %s (409)', async (_case, actor, execution) => {
    await expect(close(actor, execution)).rejects.toThrow(
      /conformidad del cliente o el cierre automatico/,
    );
  });
});
