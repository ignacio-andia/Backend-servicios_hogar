import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '../../generated/prisma/enums.js';
import {
  ADVANCE_CONFIRMATION_VALUES,
  PaymentsConfig,
  parseAdvanceConfirmation,
} from './payments.config.js';
import {
  CONCEPT_LABELS,
  DECLARABLE_STATUSES,
  allowedMethods,
  isAdvanceReceiptConfirmation,
  requiredConfirmationFor,
} from './payments.policy.js';
import { PAYMENT_CONCEPTS, PAYMENT_DECLARERS } from './payments.rules.js';

const config = (value?: string) =>
  new PaymentsConfig(
    new ConfigService(
      value === undefined ? {} : { PAYMENTS_ADVANCE_CONFIRMED_BY: value },
    ),
  );

describe('PaymentsConfig (el anticipo lo confirma solo el trabajador asignado)', () => {
  // ConfigService lee primero process.env: se aisla del .env de la maquina.
  const previous = process.env.PAYMENTS_ADVANCE_CONFIRMED_BY;
  beforeEach(() => {
    delete process.env.PAYMENTS_ADVANCE_CONFIRMED_BY;
  });
  afterAll(() => {
    if (previous !== undefined) {
      process.env.PAYMENTS_ADVANCE_CONFIRMED_BY = previous;
    }
  });

  it('TRABAJADOR es el unico valor permitido', () => {
    expect(ADVANCE_CONFIRMATION_VALUES).toEqual(['TRABAJADOR']);
  });

  it.each([undefined, '', '   '])(
    'sin valor (%j) usa TRABAJADOR por defecto',
    (value) => {
      expect(parseAdvanceConfirmation(value)).toBe('TRABAJADOR');
      expect(config(value).advanceConfirmedBy).toBe('TRABAJADOR');
    },
  );

  it.each(['TRABAJADOR', ' trabajador ', 'Trabajador'])(
    'acepta %j',
    (value) => {
      expect(config(value).advanceConfirmedBy).toBe('TRABAJADOR');
    },
  );

  it.each(['CLIENTE', 'cliente', 'AMBOS', ' ambos ', 'SISTEMA', 'NADIE'])(
    'rechaza %j y detiene el arranque',
    (value) => {
      expect(() => parseAdvanceConfirmation(value)).toThrow(
        /PAYMENTS_ADVANCE_CONFIRMED_BY solo admite TRABAJADOR/,
      );
      expect(() => config(value)).toThrow(/trabajador asignado/);
    },
  );

  it('.env.example documenta la decision', () => {
    const line = /^PAYMENTS_ADVANCE_CONFIRMED_BY=(.*)$/m.exec(
      readFileSync('.env.example', 'utf8'),
    );
    expect(line?.[1].trim()).toBe('TRABAJADOR');
  });
});

describe('isAdvanceReceiptConfirmation', () => {
  it('de todas las combinaciones, solo el trabajador sobre el anticipo confirma', () => {
    const confirming = PAYMENT_CONCEPTS.flatMap((concept) =>
      PAYMENT_DECLARERS.filter((declarer) =>
        isAdvanceReceiptConfirmation(concept, declarer, 'TRABAJADOR'),
      ).map((declarer) => `${concept}:${declarer}`),
    );
    expect(confirming).toEqual(['ANTICIPO:TRABAJADOR']);
  });
});

describe('requiredConfirmationFor', () => {
  it.each(PAYMENT_CONCEPTS)(
    '%s exige la confirmacion del trabajador',
    (concept) => {
      expect(requiredConfirmationFor(concept, 'TRABAJADOR')).toBe('TRABAJADOR');
    },
  );
});

describe('DECLARABLE_STATUSES', () => {
  it('ningun concepto admite un pedido vencido o sin acuerdo', () => {
    for (const concept of PAYMENT_CONCEPTS) {
      for (const status of [
        OrderStatus.PUBLICADO,
        OrderStatus.EN_NEGOCIACION,
        OrderStatus.VENCIDO,
        OrderStatus.SIN_ACUERDO,
      ]) {
        expect(DECLARABLE_STATUSES[concept]).not.toContain(status);
      }
    }
  });

  it('de un pedido cancelado solo se declara la visita: ni anticipo ni saldo', () => {
    expect(
      PAYMENT_CONCEPTS.filter((concept) =>
        DECLARABLE_STATUSES[concept].includes(OrderStatus.CANCELADO),
      ),
    ).toEqual(['VISITA']);
  });

  it('el saldo exige el trabajo terminado (RF-40) y la visita, haberse realizado', () => {
    expect(DECLARABLE_STATUSES.SALDO).not.toContain(OrderStatus.EN_EJECUCION);
    expect(DECLARABLE_STATUSES.SALDO).toContain(OrderStatus.TERMINADO);
    expect(DECLARABLE_STATUSES.VISITA).not.toContain(OrderStatus.ACORDADO);
    expect(DECLARABLE_STATUSES.ANTICIPO).toContain(OrderStatus.ACORDADO);
  });
});

describe('allowedMethods (RN-01, RN-04)', () => {
  it('la visita solo en efectivo; anticipo y saldo en efectivo o QR', () => {
    expect(allowedMethods('VISITA')).toEqual(['EFECTIVO']);
    expect(allowedMethods('ANTICIPO')).toEqual(['EFECTIVO', 'QR']);
    expect(allowedMethods('SALDO')).toEqual(['EFECTIVO', 'QR']);
  });

  it('cada concepto tiene un nombre para los mensajes', () => {
    for (const concept of PAYMENT_CONCEPTS) {
      expect(CONCEPT_LABELS[concept]).toBeTruthy();
    }
  });
});
