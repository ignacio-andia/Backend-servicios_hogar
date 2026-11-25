import { OrderStatus } from '../../generated/prisma/enums.js';
import {
  ORDER_AGREED_STATUSES,
  ORDER_TRANSITIONS,
  ORDER_WORK_CANCELLABLE_STATUSES,
} from './orders.rules.js';
import { isAllowedTransition } from './orders.service.js';

const S = OrderStatus;

describe('matriz de transiciones del ciclo de vida del trabajo', () => {
  it.each([
    [S.ACORDADO, S.ANTICIPO_REGISTRADO],
    [S.ANTICIPO_REGISTRADO, S.VISITA_REALIZADA],
    [S.ANTICIPO_REGISTRADO, S.EN_EJECUCION],
    [S.VISITA_REALIZADA, S.EN_EJECUCION],
    [S.VISITA_REALIZADA, S.PRESUPUESTO_ADICIONAL_PENDIENTE],
    [S.EN_EJECUCION, S.PRESUPUESTO_ADICIONAL_PENDIENTE],
    [S.PRESUPUESTO_ADICIONAL_PENDIENTE, S.EN_EJECUCION],
    // RF-27: rechazo del adicional.
    [S.PRESUPUESTO_ADICIONAL_PENDIENTE, S.CERRADO],
    [S.EN_EJECUCION, S.TERMINADO],
    [S.TERMINADO, S.CERRADO],
    [S.TERMINADO, S.EN_RECLAMO],
    [S.EN_RECLAMO, S.CERRADO],
  ])('permite %s -> %s', (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(true);
  });

  it.each([
    // RF-27 pendiente del docente: el rechazo del adicional NO tiene salida.
    [S.PRESUPUESTO_ADICIONAL_PENDIENTE, S.TERMINADO],
    [S.PRESUPUESTO_ADICIONAL_PENDIENTE, S.VISITA_REALIZADA],
    // No se saltan pasos.
    [S.ACORDADO, S.EN_EJECUCION],
    [S.ACORDADO, S.TERMINADO],
    [S.ANTICIPO_REGISTRADO, S.TERMINADO],
    [S.VISITA_REALIZADA, S.TERMINADO],
    // No se retrocede ni se reabre.
    [S.TERMINADO, S.EN_EJECUCION],
    [S.CERRADO, S.EN_RECLAMO],
    [S.CERRADO, S.EN_EJECUCION],
    [S.EN_RECLAMO, S.TERMINADO],
    [S.EN_EJECUCION, S.ACORDADO],
    // Un trabajo terminado o en reclamo no se cancela (usa el reclamo).
    [S.TERMINADO, S.CANCELADO],
    [S.EN_RECLAMO, S.CANCELADO],
    [S.CERRADO, S.CANCELADO],
    // Un pedido con acuerdo no vence ni vuelve a negociarse.
    [S.ACORDADO, S.VENCIDO],
    [S.ACORDADO, S.PUBLICADO],
    [S.EN_EJECUCION, S.EN_NEGOCIACION],
  ])('rechaza %s -> %s', (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(false);
  });

  it('CANCELADO es alcanzable exactamente desde los estados cancelables del trabajo', () => {
    const reachable = ORDER_AGREED_STATUSES.filter((status) =>
      isAllowedTransition(status, S.CANCELADO),
    );
    expect([...reachable].sort()).toEqual(
      [...ORDER_WORK_CANCELLABLE_STATUSES].sort(),
    );
  });

  it('los estados finales no tienen salidas', () => {
    for (const status of [S.CERRADO, S.CANCELADO, S.VENCIDO, S.SIN_ACUERDO]) {
      expect(ORDER_TRANSITIONS[status] ?? []).toEqual([]);
    }
  });
});
