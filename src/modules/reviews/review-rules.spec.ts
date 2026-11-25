import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/enums.js';
import { CreateReviewDto } from './dto/create-review.dto.js';
import {
  REVIEW_DISABLED_MESSAGE,
  statusEligibilityPolicy,
  type ReviewEligibilityPolicy,
} from './review-eligibility.policy.js';
import {
  assertValidRating,
  resolveReviewTarget,
  summarizeRatings,
  type ReviewableOrder,
} from './review-rules.js';

const CLIENT = 'client-1';
const WORKER = 'worker-1';
const OTHER = 'other-1';

// La politica real esta pendiente: los tests la fijan de forma explicita.
const terminadoOCerrado = statusEligibilityPolicy([
  OrderStatus.TERMINADO,
  OrderStatus.CERRADO,
]);
const soloCerrado = statusEligibilityPolicy([OrderStatus.CERRADO]);

const order = (overrides: Partial<ReviewableOrder> = {}): ReviewableOrder => ({
  clientId: CLIENT,
  assignedWorkerId: WORKER,
  status: OrderStatus.CERRADO,
  ...overrides,
});

const resolve = (
  authorId: string,
  options: {
    order?: ReviewableOrder;
    alreadyReviewed?: boolean;
    policy?: ReviewEligibilityPolicy;
  } = {},
) =>
  resolveReviewTarget({
    authorId,
    order: options.order ?? order(),
    alreadyReviewed: options.alreadyReviewed ?? false,
    policy: options.policy ?? terminadoOCerrado,
  });

describe('statusEligibilityPolicy (aislada y configurable)', () => {
  it('sin estados configurados las calificaciones quedan deshabilitadas (sin valores por defecto)', () => {
    const disabled = statusEligibilityPolicy([]);
    expect(disabled.eligibleStatuses).toEqual([]);
    for (const status of Object.values(OrderStatus)) {
      expect(disabled.denialReason({ status })).toBe(REVIEW_DISABLED_MESSAGE);
    }
  });

  it('habilita solo los estados configurados', () => {
    expect(terminadoOCerrado.denialReason({ status: 'TERMINADO' })).toBeNull();
    expect(soloCerrado.denialReason({ status: 'TERMINADO' })).not.toBeNull();
    expect(soloCerrado.denialReason({ status: 'CERRADO' })).toBeNull();
  });

  it.each([
    OrderStatus.PUBLICADO,
    OrderStatus.EN_NEGOCIACION,
    OrderStatus.ACORDADO,
    OrderStatus.EN_EJECUCION,
    OrderStatus.CANCELADO,
    OrderStatus.SIN_ACUERDO,
    OrderStatus.VENCIDO,
  ])('un pedido %s no se califica con la politica de ejemplo', (status) => {
    expect(terminadoOCerrado.denialReason({ status })).not.toBeNull();
  });

  it('cambiar la politica cambia el resultado sin tocar las reglas inmutables', () => {
    const terminado = order({ status: OrderStatus.TERMINADO });
    expect(resolve(CLIENT, { order: terminado }).targetId).toBe(WORKER);
    expect(() =>
      resolve(CLIENT, { order: terminado, policy: soloCerrado }),
    ).toThrow(ConflictException);
  });
});

describe('resolveReviewTarget: reglas inmutables (RF-44, RF-45, RN-14)', () => {
  it('el cliente califica al trabajador', () => {
    expect(resolve(CLIENT)).toEqual({
      targetId: WORKER,
      authorRole: 'CLIENTE',
    });
  });

  it('el trabajador califica al cliente', () => {
    expect(resolve(WORKER)).toEqual({
      targetId: CLIENT,
      authorRole: 'TRABAJADOR',
    });
  });

  it('un tercero no califica (403)', () => {
    expect(() => resolve(OTHER)).toThrow(ForbiddenException);
  });

  it('un administrador u otro trabajador no participan: 403 aunque el pedido este terminado', () => {
    expect(() => resolve('admin-1')).toThrow(ForbiddenException);
  });

  it('una parte no califica dos veces el mismo pedido (409)', () => {
    expect(() => resolve(CLIENT, { alreadyReviewed: true })).toThrow(
      ConflictException,
    );
    expect(() => resolve(WORKER, { alreadyReviewed: true })).toThrow(
      ConflictException,
    );
  });

  it('bloquea la autocalificacion: cliente y trabajador no pueden ser la misma persona', () => {
    const propio = order({ assignedWorkerId: CLIENT });
    expect(() => resolve(CLIENT, { order: propio })).toThrow(ConflictException);
  });

  it('un pedido sin trabajador no tiene a quien calificar', () => {
    expect(() =>
      resolve(CLIENT, { order: order({ assignedWorkerId: null }) }),
    ).toThrow(ConflictException);
  });

  it('un pedido fuera de la politica se rechaza con 409 y el motivo', () => {
    expect(() =>
      resolve(CLIENT, { order: order({ status: OrderStatus.CANCELADO }) }),
    ).toThrow(/terminado/);
  });

  it('el 403 tiene prioridad sobre el estado (no revela el estado a terceros)', () => {
    expect(() =>
      resolve(OTHER, { order: order({ status: OrderStatus.CANCELADO }) }),
    ).toThrow(ForbiddenException);
  });
});

describe('assertValidRating', () => {
  it.each([1, 2, 3, 4, 5])('acepta %i', (rating) => {
    expect(() => assertValidRating(rating)).not.toThrow();
  });

  it.each([0, 6, -1, 3.5, NaN, Infinity, '4', null, undefined])(
    'rechaza %s',
    (rating) => {
      expect(() => assertValidRating(rating)).toThrow(BadRequestException);
    },
  );
});

describe('summarizeRatings (RF-46)', () => {
  const r = (rating: number, hidden = false) => ({ rating, hidden });

  it('sin calificaciones no hay promedio', () => {
    expect(summarizeRatings([])).toEqual({ average: null, count: 0 });
  });

  it('promedia con 2 decimales, mitad hacia arriba', () => {
    expect(summarizeRatings([r(5), r(4)])).toEqual({ average: 4.5, count: 2 });
    expect(summarizeRatings([r(5), r(5), r(4)])).toEqual({
      average: 4.67,
      count: 3,
    });
    // 4.125 exacto: 5+4+4+4+4+4+4+4 = 33 / 8
    expect(
      summarizeRatings([r(5), r(4), r(4), r(4), r(4), r(4), r(4), r(4)]),
    ).toEqual({ average: 4.13, count: 8 });
  });

  it('las opiniones ocultas no cuentan en el promedio ni en la cantidad (RF-46 A1)', () => {
    expect(summarizeRatings([r(5), r(1, true)])).toEqual({
      average: 5,
      count: 1,
    });
    expect(summarizeRatings([r(1, true)])).toEqual({
      average: null,
      count: 0,
    });
  });

  it('detecta datos corruptos fuera de 1-5', () => {
    expect(() => summarizeRatings([r(9)])).toThrow(BadRequestException);
  });
});

describe('CreateReviewDto', () => {
  const errorsOf = async (body: object) =>
    (
      await validate(plainToInstance(CreateReviewDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).map((error) => error.property);

  it('acepta rating valido con o sin comentario', async () => {
    expect(await errorsOf({ rating: 5 })).toEqual([]);
    expect(await errorsOf({ rating: 3, comment: 'Buen trabajo' })).toEqual([]);
    expect(await errorsOf({ rating: 3, comment: '   ' })).toEqual([]);
  });

  it.each([0, 6, 2.5, '4'])('rechaza el rating %s', async (rating) => {
    expect(await errorsOf({ rating })).toContain('rating');
  });

  it('limita el comentario', async () => {
    expect(await errorsOf({ rating: 4, comment: 'a'.repeat(1001) })).toContain(
      'comment',
    );
  });

  it('el cuerpo no puede elegir autor ni calificado', async () => {
    expect(await errorsOf({ rating: 4, authorId: 'x', targetId: 'y' })).toEqual(
      expect.arrayContaining(['authorId', 'targetId']),
    );
  });
});
