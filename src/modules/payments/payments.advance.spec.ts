import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { OrderStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { OffersService } from '../offers/offers.service.js';
import type { OrdersService } from '../orders/orders.service.js';
import type { WorkflowQueryService } from '../service-workflow/workflow-query.service.js';
import type { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import type { PaymentsConfig } from './payments.config.js';
import { PaymentsService } from './payments.service.js';

// Anticipo confirmado por el trabajador asignado (decision confirmada). La BD
// se sustituye por un doble en memoria; la transicion la hace OrdersService.

const CLIENT = 'client';
const WORKER = 'worker';
const ORDER = 'order';
/** 25 % de 120.50 = 30.125 -> 30.13. */
const ADVANCE = '30.13';

interface Declaration {
  id: string;
  paymentId: string;
  declaredBy: 'CLIENTE' | 'TRABAJADOR';
  userId: string;
  method: 'EFECTIVO' | 'QR';
  amount: Prisma.Decimal;
  createdAt: Date;
}

function setup({ status = OrderStatus.ACORDADO as OrderStatus } = {}) {
  const order = {
    status,
    clientId: CLIENT,
    assignedWorkerId: WORKER,
    expired: false,
  };
  const declarations: Declaration[] = [];
  let payment: { id: string; expectedAmount: Prisma.Decimal | null } | null =
    null;
  const tx = {
    $queryRaw: vi.fn(() => Promise.resolve([{ ...order }])),
    serviceReceipt: { createMany: vi.fn() },
    payment: {
      findUnique: vi.fn(() => Promise.resolve(payment)),
      create: vi.fn(({ data }) => {
        payment = { id: 'payment', expectedAmount: data.expectedAmount };
        return Promise.resolve(payment);
      }),
    },
    paymentDeclaration: {
      findUnique: vi.fn(({ where }) =>
        Promise.resolve(
          declarations.find(
            (d) => d.declaredBy === where.paymentId_declaredBy.declaredBy,
          ) ?? null,
        ),
      ),
      create: vi.fn(({ data }) => {
        declarations.push({
          ...data,
          id: `d${declarations.length}`,
          createdAt: new Date(),
        });
        return Promise.resolve();
      }),
      findMany: vi.fn(() => Promise.resolve([...declarations])),
    },
  };
  const orders = {
    findOrderSummary: vi.fn(() =>
      Promise.resolve({ orderId: ORDER, ...order }),
    ),
    transition: vi.fn((_tx, change: { to: OrderStatus }) => {
      order.status = change.to;
      return Promise.resolve();
    }),
  };
  const offers = {
    getAcceptedOfferTerms: vi.fn(() =>
      Promise.resolve({
        offerId: 'offer',
        workerId: WORKER,
        amount: new Prisma.Decimal('120.50'),
        requiresVisit: false,
        visitCost: null,
        proposedStartAt: new Date(),
        estimatedDurationMinutes: 30,
      }),
    ),
  };
  const workerProfiles = {
    lockApprovedWorker: vi.fn(),
    lockApprovedWorkerForAgreedWork: vi.fn(),
  };
  const notifications = { create: vi.fn(), createForRole: vi.fn() };
  const service = new PaymentsService(
    {
      $transaction: (work: (client: unknown) => unknown) => work(tx),
    } as unknown as PrismaService,
    orders as unknown as OrdersService,
    offers as unknown as OffersService,
    {} as WorkflowQueryService,
    workerProfiles as unknown as WorkerProfileService,
    notifications as unknown as NotificationsService,
    { advanceConfirmedBy: 'TRABAJADOR' } as PaymentsConfig,
  );
  const declare = (
    userId: string,
    amount = ADVANCE,
    method: 'EFECTIVO' | 'QR' = 'EFECTIVO',
  ) => service.declare(userId, ORDER, 'ANTICIPO', { amount, method });
  return {
    declare,
    order,
    declarations,
    orders,
    workerProfiles,
    notifications,
  };
}

describe('PaymentsService.hasValidAdvanceConfirmation (puerto de Orders)', () => {
  const check = async ({
    amount = ADVANCE as string | null,
    offerWorker = WORKER,
  } = {}) => {
    const findFirst = vi.fn(() =>
      Promise.resolve(
        amount === null ? null : { amount: new Prisma.Decimal(amount) },
      ),
    );
    const offers = {
      getAcceptedOfferTerms: vi.fn(() =>
        Promise.resolve({
          workerId: offerWorker,
          amount: new Prisma.Decimal('120.50'),
        }),
      ),
    };
    const unused = {} as never;
    const service = new PaymentsService(
      unused,
      unused,
      offers as unknown as OffersService,
      unused,
      unused,
      unused,
      unused,
    );
    const valid = await service.hasValidAdvanceConfirmation(
      { paymentDeclaration: { findFirst } } as never,
      { orderId: ORDER, workerId: WORKER },
    );
    return { valid, findFirst };
  };

  it('busca la declaracion del trabajador en el anticipo de ESE pedido', async () => {
    const { valid, findFirst } = await check();
    expect(valid).toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          declaredBy: 'TRABAJADOR',
          userId: WORKER,
          payment: { orderId: ORDER, concept: 'ANTICIPO' },
        },
      }),
    );
  });

  it.each([
    ['sin declaracion', { amount: null }],
    ['con otro monto', { amount: '30.12' }],
    ['si la oferta aceptada es de otro trabajador', { offerWorker: 'otro' }],
  ])('es false %s', async (_name, options) => {
    expect((await check(options)).valid).toBe(false);
  });
});

describe('PaymentsService: confirmacion del anticipo', () => {
  it('el trabajador asignado confirma: registra y pasa a ANTICIPO_REGISTRADO', async () => {
    const { declare, orders, declarations, workerProfiles } = setup();
    const result = await declare(WORKER);

    expect(result.orderTransition).toBe('ANTICIPO_REGISTRADO');
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({
      declaredBy: 'TRABAJADOR',
      userId: WORKER,
    });
    expect(workerProfiles.lockApprovedWorkerForAgreedWork).toHaveBeenCalledWith(
      expect.anything(),
      WORKER,
    );
    // RF-13: no usa la validacion de trabajo nuevo.
    expect(workerProfiles.lockApprovedWorker).not.toHaveBeenCalled();
    expect(orders.transition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: ORDER,
        from: OrderStatus.ACORDADO,
        to: OrderStatus.ANTICIPO_REGISTRADO,
        actor: { type: 'USUARIO', userId: WORKER, role: 'TRABAJADOR' },
      }),
    );
  });

  it('la declaracion del cliente se registra como suya y no confirma la recepcion', async () => {
    const { declare, orders, declarations, order } = setup();
    const result = await declare(CLIENT);

    expect(result.orderTransition).toBe('NO_APLICA');
    expect(declarations.map((d) => d.declaredBy)).toEqual(['CLIENTE']);
    expect(orders.transition).not.toHaveBeenCalled();
    expect(order.status).toBe(OrderStatus.ACORDADO);
  });

  it('el cliente no avanza el pedido aunque ya exista la declaracion del trabajador', async () => {
    const { declare, orders, order, declarations } = setup();
    // Dato anterior a la regla: el trabajador declaro y el pedido no avanzo.
    declarations.push({
      id: 'previa',
      paymentId: 'payment',
      declaredBy: 'TRABAJADOR',
      userId: WORKER,
      method: 'EFECTIVO',
      amount: new Prisma.Decimal(ADVANCE),
      createdAt: new Date(),
    });
    const result = await declare(CLIENT);

    expect(result.orderTransition).toBe('NO_APLICA');
    expect(orders.transition).not.toHaveBeenCalled();
    expect(order.status).toBe(OrderStatus.ACORDADO);

    // Solo la confirmacion del trabajador lo avanza, sin duplicar su registro.
    const confirmed = await declare(WORKER);
    expect(confirmed.orderTransition).toBe('ANTICIPO_REGISTRADO');
    expect(declarations).toHaveLength(2);
  });

  it('un tercero recibe 404 y no registra nada', async () => {
    const { declare, orders, declarations } = setup();
    await expect(declare('intruso')).rejects.toBeInstanceOf(NotFoundException);
    expect(declarations).toHaveLength(0);
    expect(orders.transition).not.toHaveBeenCalled();
  });

  it('si el trabajador no esta habilitado (403) no registra ni avanza', async () => {
    const { declare, orders, declarations, workerProfiles } = setup();
    workerProfiles.lockApprovedWorkerForAgreedWork.mockRejectedValue(
      new ForbiddenException('perfil no aprobado'),
    );
    await expect(declare(WORKER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(declarations).toHaveLength(0);
    expect(orders.transition).not.toHaveBeenCalled();
  });

  it('la declaracion del cliente no valida ni bloquea al trabajador', async () => {
    const { declare, workerProfiles } = setup();
    await declare(CLIENT);
    expect(
      workerProfiles.lockApprovedWorkerForAgreedWork,
    ).not.toHaveBeenCalled();
    expect(workerProfiles.lockApprovedWorker).not.toHaveBeenCalled();
  });

  it('repetir la misma confirmacion es idempotente', async () => {
    const { declare, orders, declarations, notifications } = setup();
    const first = await declare(WORKER);
    const notified = notifications.create.mock.calls.length;
    const again = await declare(WORKER);

    expect(again.orderTransition).toBe('ANTICIPO_REGISTRADO');
    expect(again.payment.declarations).toEqual(first.payment.declarations);
    expect(declarations).toHaveLength(1);
    expect(orders.transition).toHaveBeenCalledTimes(1);
    // Un solo aviso (al cliente) en total.
    expect(notified).toBe(1);
    expect(notifications.create.mock.calls.length).toBe(notified);
    expect(notifications.createForRole).not.toHaveBeenCalled();
  });

  it('repetir con otro metodo no edita la declaracion (409)', async () => {
    const { declare, declarations } = setup();
    await declare(WORKER);
    await expect(declare(WORKER, ADVANCE, 'QR')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(declarations).toHaveLength(1);
  });

  it.each(['30.12', '30.14', '120.50', '1'])(
    'rechaza la confirmacion por Bs %s (no es el 25 %%)',
    async (amount) => {
      const { declare, orders, declarations } = setup();
      await expect(declare(WORKER, amount)).rejects.toThrow(
        /anticipo esperado \(Bs 30\.13\)/,
      );
      expect(declarations).toHaveLength(0);
      expect(orders.transition).not.toHaveBeenCalled();
    },
  );

  it.each([
    OrderStatus.PUBLICADO,
    OrderStatus.EN_NEGOCIACION,
    OrderStatus.CANCELADO,
    OrderStatus.VENCIDO,
  ])('rechaza la confirmacion con el pedido en %s', async (status) => {
    const { declare, orders, declarations } = setup({ status });
    await expect(declare(WORKER)).rejects.toBeInstanceOf(ConflictException);
    expect(declarations).toHaveLength(0);
    expect(orders.transition).not.toHaveBeenCalled();
  });
});
