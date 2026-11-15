import { OrderStatus } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { OrderActor } from './order-history.js';
import {
  OrderTransitionRequest as Req,
  OrderTransitionUsageError,
} from './order-transition.js';
import { OrdersService } from './orders.service.js';

const ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const W = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const S = OrderStatus;
const actor: OrderActor = { type: 'SISTEMA', process: 'PRUEBA' };

// Combinaciones validas: deben compilar.
export const VALID: Req[] = [
  { orderId: ID, to: S.EN_NEGOCIACION, actor },
  { orderId: ID, to: S.ACORDADO, actor, assignWorkerId: W },
  { orderId: ID, to: S.PUBLICADO, actor, releaseWorker: true },
  { orderId: ID, to: S.EN_EJECUCION, actor, from: S.ANTICIPO_REGISTRADO },
];

// Combinaciones invalidas: cada una debe fallar en compilacion (si alguna
// compila, tsc marca la directiva @ts-expect-error como no usada).
// @ts-expect-error CANCELADO no es un destino publico
const c1: Req = { orderId: ID, to: S.CANCELADO, actor };
// @ts-expect-error VENCIDO no es un destino publico
const c2: Req = { orderId: ID, to: S.VENCIDO, actor };
// @ts-expect-error ACORDADO exige assignWorkerId
const c3: Req = { orderId: ID, to: S.ACORDADO, actor };
// @ts-expect-error solo ACORDADO asigna trabajador
const c4: Req = { orderId: ID, to: S.PUBLICADO, actor, assignWorkerId: W };
// @ts-expect-error con acuerdo se conserva el trabajador asignado
const c5: Req = { orderId: ID, to: S.EN_EJECUCION, actor, assignWorkerId: W };
// @ts-expect-error con acuerdo no se puede liberar al trabajador
const c6: Req = { orderId: ID, to: S.TERMINADO, actor, releaseWorker: true };
// @ts-expect-error no se puede asignar y liberar a la vez
const c7: Req = {
  orderId: ID,
  to: S.ACORDADO,
  actor,
  assignWorkerId: W,
  releaseWorker: true,
};

describe('OrdersService.transition: usos invalidos', () => {
  // Los usos invalidos se rechazan antes de tocar la BD: el servicio no
  // necesita dependencias para estas pruebas.
  const service = new (OrdersService as unknown as new () => OrdersService)();
  const tx = {} as Prisma.TransactionClient;

  it.each([
    ['CANCELADO', c1, 'solo la realiza OrdersModule'],
    ['VENCIDO', c2, 'solo la realiza OrdersModule'],
    ['ACORDADO sin trabajador', c3, 'exige assignWorkerId'],
    ['asignar hacia PUBLICADO', c4, 'Solo se asigna un trabajador'],
    ['asignar entre estados con acuerdo', c5, 'Solo se asigna un trabajador'],
    ['liberar con acuerdo', c6, 'no se puede liberar'],
    ['asignar y liberar', c7, 'asignar y liberar'],
  ])(
    '%s es un error de uso interno, no un error HTTP',
    async (_label, request, message) => {
      const error: unknown = await service
        .transition(tx, request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OrderTransitionUsageError);
      expect((error as Error).message).toContain(message);
      expect(error).not.toHaveProperty('getStatus');
    },
  );
});
