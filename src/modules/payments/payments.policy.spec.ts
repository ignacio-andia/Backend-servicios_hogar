import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '../../generated/prisma/enums.js';
import { PaymentsConfig, parseAdvanceConfirmation } from './payments.config.js';
import {
  DECLARABLE_STATUSES,
  advanceConfirmationSatisfied,
  allowedMethods,
  requiredConfirmationFor,
} from './payments.policy.js';
import { PAYMENT_CONCEPTS } from './payments.rules.js';

describe('PaymentsConfig (quien confirma el anticipo esta pendiente del docente)', () => {
  it('sin valor la transicion automatica queda desactivada', () => {
    expect(parseAdvanceConfirmation(undefined)).toBeNull();
    expect(parseAdvanceConfirmation('')).toBeNull();
    expect(parseAdvanceConfirmation('   ')).toBeNull();
    const config = new PaymentsConfig(new ConfigService({}));
    expect(config.advanceConfirmedBy).toBeNull();
  });

  it.each(['TRABAJADOR', 'CLIENTE', 'AMBOS', ' trabajador '])(
    'acepta %s',
    (value) => {
      expect(parseAdvanceConfirmation(value)).toBe(value.trim().toUpperCase());
    },
  );

  it('un valor desconocido detiene el arranque', () => {
    expect(() => parseAdvanceConfirmation('SISTEMA')).toThrow(
      /PAYMENTS_ADVANCE_CONFIRMED_BY/,
    );
    expect(
      () =>
        new PaymentsConfig(
          new ConfigService({ PAYMENTS_ADVANCE_CONFIRMED_BY: 'NADIE' }),
        ),
    ).toThrow();
  });
});

describe('advanceConfirmationSatisfied', () => {
  it('sin politica nunca se satisface, aunque ambos hayan declarado', () => {
    expect(advanceConfirmationSatisfied(null, ['CLIENTE', 'TRABAJADOR'])).toBe(
      false,
    );
  });

  it('TRABAJADOR y CLIENTE exigen esa parte; AMBOS exige las dos', () => {
    expect(advanceConfirmationSatisfied('TRABAJADOR', ['TRABAJADOR'])).toBe(
      true,
    );
    expect(advanceConfirmationSatisfied('TRABAJADOR', ['CLIENTE'])).toBe(false);
    expect(advanceConfirmationSatisfied('CLIENTE', ['CLIENTE'])).toBe(true);
    expect(advanceConfirmationSatisfied('CLIENTE', [])).toBe(false);
    expect(advanceConfirmationSatisfied('AMBOS', ['CLIENTE'])).toBe(false);
    expect(
      advanceConfirmationSatisfied('AMBOS', ['CLIENTE', 'TRABAJADOR']),
    ).toBe(true);
  });
});

describe('requiredConfirmationFor (responsabilidades distintas por concepto)', () => {
  it('visita y saldo exigen al trabajador (RN-03, RN-04); el anticipo no esta definido', () => {
    expect(requiredConfirmationFor('VISITA', null)).toBe('TRABAJADOR');
    expect(requiredConfirmationFor('SALDO', null)).toBe('TRABAJADOR');
    expect(requiredConfirmationFor('ANTICIPO', null)).toBe(
      'PENDIENTE_DEFINICION',
    );
  });

  it('la politica solo cambia el anticipo', () => {
    expect(requiredConfirmationFor('ANTICIPO', 'AMBOS')).toBe('AMBOS');
    expect(requiredConfirmationFor('SALDO', 'AMBOS')).toBe('TRABAJADOR');
    expect(requiredConfirmationFor('VISITA', 'CLIENTE')).toBe('TRABAJADOR');
  });
});

describe('DECLARABLE_STATUSES', () => {
  it('ningun concepto admite un pedido cancelado, vencido o sin acuerdo', () => {
    for (const concept of PAYMENT_CONCEPTS) {
      for (const status of [
        OrderStatus.PUBLICADO,
        OrderStatus.EN_NEGOCIACION,
        OrderStatus.CANCELADO,
        OrderStatus.VENCIDO,
        OrderStatus.SIN_ACUERDO,
      ]) {
        expect(DECLARABLE_STATUSES[concept]).not.toContain(status);
      }
    }
  });

  it('el saldo exige el trabajo terminado (RF-40) y la visita, haberse realizado', () => {
    expect(DECLARABLE_STATUSES.SALDO).not.toContain(OrderStatus.EN_EJECUCION);
    expect(DECLARABLE_STATUSES.SALDO).toContain(OrderStatus.TERMINADO);
    expect(DECLARABLE_STATUSES.VISITA).not.toContain(OrderStatus.ACORDADO);
    expect(DECLARABLE_STATUSES.ANTICIPO).toContain(OrderStatus.ACORDADO);
  });
});

describe('allowedMethods (RN-01, RN-04)', () => {
  it('la visita solo en efectivo; anticipo y saldo, efectivo o QR', () => {
    expect(allowedMethods('VISITA')).toEqual(['EFECTIVO']);
    expect(allowedMethods('ANTICIPO')).toEqual(['EFECTIVO', 'QR']);
    expect(allowedMethods('SALDO')).toEqual(['EFECTIVO', 'QR']);
  });
});
