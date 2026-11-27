//=========================================================
// NUEVO: orders-cancellation.spec.ts
// Fase B1 (cancelacion): pruebas unitarias de las reglas comunes a las dos
// rutas (RF-18 cancelar pedido y RF-34 «Cancelar trabajo»).
// Comprueban: motivo obligatorio (HTTP e interno), solo el cliente
// propietario, estados permitidos y no permitidos, pedido vencido, historial
// con motivo y actor, y la limpieza de datos solo cuando no hubo acuerdo.
// La persistencia real y la concurrencia se prueban en los E2E.
//=========================================================
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { OrderStatus, RoleName } from '../../generated/prisma/enums.js';
import { CancelWorkDto } from '../service-workflow/dto/cancel-work.dto.js';
import { CancelOrderDto } from './dto/cancel-order.dto.js';
import { OrderLifecycleRegistry } from './order-lifecycle.registry.js';
import type { OrderCancellationKind } from './orders.rules.js';
import { OrdersService } from './orders.service.js';

const ORDER = 'pedido';
const CLIENT = 'cliente';
const MOTIVE = 'Ya no necesito el servicio';

const ALLOWED: Record<OrderCancellationKind, OrderStatus[]> = {
  SIN_ACUERDO: [OrderStatus.PUBLICADO, OrderStatus.EN_NEGOCIACION],
  CON_ACUERDO: [
    OrderStatus.ACORDADO,
    OrderStatus.ANTICIPO_REGISTRADO,
    OrderStatus.VISITA_REALIZADA,
    OrderStatus.PRESUPUESTO_ADICIONAL_PENDIENTE,
    OrderStatus.EN_EJECUCION,
  ],
};
const KINDS = Object.keys(ALLOWED) as OrderCancellationKind[];

/** `status: null` = el pedido no existe o es de otro cliente (sin fila). */
function setup(
  status: OrderStatus | null,
  { expired = false }: { expired?: boolean } = {},
) {
  const tx = {
    $queryRaw: vi.fn((..._query: unknown[]) =>
      Promise.resolve(
        status === null
          ? []
          : [{ status, clientId: CLIENT, assignedWorkerId: null, expired }],
      ),
    ),
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    orderStatusHistory: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const lifecycle = new OrderLifecycleRegistry();
  const inTransaction = vi
    .spyOn(lifecycle, 'runInTransaction')
    .mockResolvedValue();
  const afterCommit = vi.spyOn(lifecycle, 'runAfterCommit').mockResolvedValue();
  const fileDeletion = { processNow: vi.fn() };
  const retention = {
    cleanupClosedOrder: vi.fn(() => Promise.resolve(['foto-1'])),
  };
  const unused = {} as never;
  const service = new OrdersService(
    prisma as never,
    unused,
    unused,
    unused,
    fileDeletion as never,
    lifecycle,
    unused,
    unused,
    retention as never,
    unused,
    unused,
    unused,
  );
  const view = { id: ORDER } as never;
  vi.spyOn(service, 'getOwn').mockResolvedValue(view);
  const cancel = (kind: OrderCancellationKind, reason: string = MOTIVE) =>
    kind === 'SIN_ACUERDO'
      ? service.cancel(CLIENT, ORDER, { reason })
      : service.cancelAgreedWork(CLIENT, ORDER, reason);
  return {
    tx,
    prisma,
    inTransaction,
    afterCommit,
    fileDeletion,
    retention,
    view,
    cancel,
  };
}

describe('Cancelacion: motivo obligatorio en el cuerpo HTTP', () => {
  // Misma configuracion que el ValidationPipe global (setup-app.ts).
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (metatype: new () => object, body: object) =>
    pipe.transform(body, { type: 'body', metatype }) as Promise<{
      reason: string;
    }>;

  describe.each([
    ['cancelar pedido', CancelOrderDto],
    ['cancelar trabajo', CancelWorkDto],
  ])('%s', (_route, dto) => {
    it.each([
      ['ausente', {}],
      ['nulo', { reason: null }],
      ['vacio', { reason: '' }],
      ['solo espacios', { reason: '   ' }],
      ['no es texto', { reason: 7 }],
      ['501 caracteres', { reason: 'x'.repeat(501) }],
      ['con campos extra', { reason: MOTIVE, status: 'CANCELADO' }],
    ])('rechaza el motivo %s', async (_label, body) => {
      await expect(validate(dto, body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('acepta 500 caracteres y recorta los espacios', async () => {
      const motive = 'x'.repeat(500);
      await expect(validate(dto, { reason: `  ${motive}  ` })).resolves.toEqual(
        { reason: motive },
      );
    });
  });
});

describe.each(KINDS)('Cancelacion %s: reglas del servicio', (kind) => {
  const [allowed] = ALLOWED[kind];

  it.each([
    ['ausente', undefined],
    ['vacio', ''],
    ['solo espacios', '   '],
    ['501 caracteres', 'x'.repeat(501)],
  ])('rechaza el motivo %s sin tocar la base', async (_label, reason) => {
    const t = setup(allowed);
    await expect(
      // `undefined` activaria el valor por defecto del auxiliar.
      t.cancel(kind, reason ?? (null as unknown as string)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('solo el cliente propietario: para otro el pedido no existe (404)', async () => {
    const t = setup(null);
    await expect(t.cancel(kind)).rejects.toBeInstanceOf(NotFoundException);
    // El bloqueo filtra por el pedido Y por el cliente autenticado.
    expect(t.tx.$queryRaw.mock.calls[0].slice(1)).toEqual([ORDER, CLIENT]);
    expect(t.tx.$executeRaw).not.toHaveBeenCalled();
    expect(t.tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  const rejected = Object.values(OrderStatus).filter(
    (status) => !ALLOWED[kind].includes(status),
  );

  it.each(rejected)('responde 409 en estado %s sin cambiar nada', async (s) => {
    const t = setup(s);
    await expect(t.cancel(kind)).rejects.toBeInstanceOf(ConflictException);
    expect(t.tx.$executeRaw).not.toHaveBeenCalled();
    expect(t.tx.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(t.inTransaction).not.toHaveBeenCalled();
    expect(t.retention.cleanupClosedOrder).not.toHaveBeenCalled();
    expect(t.afterCommit).not.toHaveBeenCalled();
  });

  it.each(ALLOWED[kind])(
    'cancela en estado %s y registra motivo, estados y actor',
    async (from) => {
      const t = setup(from);
      await expect(t.cancel(kind, `  ${MOTIVE}  `)).resolves.toBe(t.view);
      expect(t.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(t.tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: ORDER,
          fromStatus: from,
          toStatus: OrderStatus.CANCELADO,
          reason: MOTIVE,
          actorType: 'USUARIO',
          changedById: CLIENT,
          actorRole: RoleName.CLIENTE,
        }) as unknown,
      });
      const events = [
        expect.objectContaining({
          type: 'CANCELADO',
          orderId: ORDER,
          fromStatus: from,
          reason: MOTIVE,
        }) as unknown,
      ];
      expect(t.inTransaction).toHaveBeenCalledWith(events, t.tx);
      expect(t.afterCommit).toHaveBeenCalledWith(events);
    },
  );

  it('limpia los datos solo cuando el pedido no tuvo acuerdo', async () => {
    const t = setup(allowed);
    await t.cancel(kind);
    if (kind === 'SIN_ACUERDO') {
      expect(t.retention.cleanupClosedOrder).toHaveBeenCalledWith(
        t.tx,
        ORDER,
        OrderStatus.CANCELADO,
      );
      expect(t.fileDeletion.processNow).toHaveBeenCalledWith(['foto-1']);
    } else {
      expect(t.retention.cleanupClosedOrder).not.toHaveBeenCalled();
      expect(t.fileDeletion.processNow).not.toHaveBeenCalled();
    }
  });
});

describe('Cancelacion de un pedido vencido', () => {
  it.each(KINDS)('%s responde 409 por estar vencido', async (kind) => {
    const t = setup(OrderStatus.PUBLICADO, { expired: true });
    await expect(t.cancel(kind)).rejects.toThrow(/venci|VENCIDO/);
    expect(t.tx.$executeRaw).not.toHaveBeenCalled();
  });
});
