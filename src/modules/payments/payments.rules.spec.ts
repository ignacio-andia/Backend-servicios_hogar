import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../../generated/prisma/client.js';
import { DeclarePaymentDto } from './dto/declare-payment.dto.js';
import { computeExpectedBalance } from './expected-balance.js';
import {
  summarizeDeclarations,
  type DeclarationFact,
} from './payment-declarations.js';
import {
  computeAdvanceAmount,
  DIRECT_PAYMENT_NOTICE,
  roundMoney,
} from './payments.rules.js';

describe('computeAdvanceAmount (RN-02: 25% del monto acordado)', () => {
  it.each([
    ['100', '25'],
    ['100.00', '25'],
    ['1000', '250'],
    ['80.40', '20.1'],
    ['10', '2.5'],
  ])('25%% de %s es %s', (agreed, expected) => {
    expect(computeAdvanceAmount(agreed).toString()).toBe(expected);
  });

  it('redondea a 2 decimales con mitad hacia arriba', () => {
    // 100.02 * 0.25 = 25.005 -> 25.01 (con binarios flotantes daria 25).
    expect(computeAdvanceAmount('100.02').toFixed(2)).toBe('25.01');
    // 0.02 * 0.25 = 0.005 -> 0.01
    expect(computeAdvanceAmount('0.02').toFixed(2)).toBe('0.01');
    // 0.01 * 0.25 = 0.0025 -> 0.00
    expect(computeAdvanceAmount('0.01').toFixed(2)).toBe('0.00');
    // 33.33 * 0.25 = 8.3325 -> 8.33
    expect(computeAdvanceAmount('33.33').toFixed(2)).toBe('8.33');
    // 99999999.99 * 0.25 = 24999999.9975 -> 25000000.00
    expect(computeAdvanceAmount('99999999.99').toFixed(2)).toBe('25000000.00');
  });

  it('acepta un Decimal de Prisma como entrada', () => {
    expect(computeAdvanceAmount(new Prisma.Decimal('240')).toFixed(2)).toBe(
      '60.00',
    );
  });

  it('el resultado es un Decimal, nunca un number', () => {
    expect(computeAdvanceAmount('100')).toBeInstanceOf(Prisma.Decimal);
  });

  it('rechaza montos no positivos o no finitos', () => {
    expect(() => computeAdvanceAmount('0')).toThrow(RangeError);
    expect(() => computeAdvanceAmount('-5')).toThrow(RangeError);
    expect(() => computeAdvanceAmount('Infinity')).toThrow(RangeError);
  });

  it('roundMoney es ROUND_HALF_UP y no ROUND_HALF_EVEN', () => {
    expect(roundMoney('2.675').toFixed(2)).toBe('2.68');
    expect(roundMoney('2.665').toFixed(2)).toBe('2.67');
    expect(roundMoney('2.5').toFixed(2)).toBe('2.50');
  });
});

describe('summarizeDeclarations (informativo, no es conciliacion)', () => {
  const fact = (
    declaredBy: DeclarationFact['declaredBy'],
    amount: string,
    method: DeclarationFact['method'] = 'EFECTIVO',
  ): DeclarationFact => ({ declaredBy, amount, method });

  it('sin declaraciones', () => {
    expect(summarizeDeclarations([])).toMatchObject({
      comparison: 'SIN_DECLARACIONES',
      difference: null,
    });
  });

  it('una sola parte: no infiere la otra', () => {
    const soloCliente = summarizeDeclarations([fact('CLIENTE', '25')]);
    expect(soloCliente.comparison).toBe('SOLO_CLIENTE');
    expect(soloCliente.workerAmount).toBeNull();
    const soloTrabajador = summarizeDeclarations([fact('TRABAJADOR', '25')]);
    expect(soloTrabajador.comparison).toBe('SOLO_TRABAJADOR');
    expect(soloTrabajador.clientAmount).toBeNull();
  });

  it('ambas con el mismo monto', () => {
    const summary = summarizeDeclarations([
      fact('CLIENTE', '25.00'),
      fact('TRABAJADOR', '25', 'QR'),
    ]);
    expect(summary.comparison).toBe('MONTOS_COINCIDEN');
    expect(summary.difference?.isZero()).toBe(true);
    // El metodo distinto se informa aparte; no cambia la comparacion de montos.
    expect(summary.methodsMatch).toBe(false);
  });

  it('montos distintos: informa la diferencia (trabajador - cliente)', () => {
    const summary = summarizeDeclarations([
      fact('CLIENTE', '100'),
      fact('TRABAJADOR', '80.50'),
    ]);
    expect(summary.comparison).toBe('MONTOS_DIFERENTES');
    expect(summary.difference?.toFixed(2)).toBe('-19.50');
  });

  it('no depende del orden de las declaraciones', () => {
    const a = summarizeDeclarations([
      fact('CLIENTE', '10'),
      fact('TRABAJADOR', '20'),
    ]);
    const b = summarizeDeclarations([
      fact('TRABAJADOR', '20'),
      fact('CLIENTE', '10'),
    ]);
    expect(a.difference?.toString()).toBe(b.difference?.toString());
  });

  it('rechaza dos declaraciones de la misma parte', () => {
    expect(() =>
      summarizeDeclarations([fact('CLIENTE', '10'), fact('CLIENTE', '10')]),
    ).toThrow();
  });
});

describe('computeExpectedBalance (RN-02/RN-03 con presupuestos adicionales)', () => {
  it('sin el contrato de presupuestos adicionales NO calcula un saldo parcial', () => {
    const result = computeExpectedBalance({
      agreedAmount: '1000',
      additionalBudgetsTotal: null,
    });
    expect(result.status).toBe('PENDIENTE_INTEGRACION');
    expect(result.amount).toBeNull();
  });

  it('saldo = acordado - anticipo cuando no hay adicionales', () => {
    const result = computeExpectedBalance({
      agreedAmount: '1000',
      additionalBudgetsTotal: '0',
    });
    expect(result).toMatchObject({ status: 'CALCULADO' });
    expect(result.amount?.toFixed(2)).toBe('750.00');
  });

  it('suma los adicionales aceptados y el anticipo no cambia', () => {
    const result = computeExpectedBalance({
      agreedAmount: '1000',
      additionalBudgetsTotal: '200.50',
    });
    if (result.status !== 'CALCULADO') {
      throw new Error('se esperaba CALCULADO');
    }
    expect(result.advanceAmount.toFixed(2)).toBe('250.00');
    expect(result.amount.toFixed(2)).toBe('950.50');
  });

  it('rechaza adicionales negativos', () => {
    expect(() =>
      computeExpectedBalance({
        agreedAmount: '100',
        additionalBudgetsTotal: '-1',
      }),
    ).toThrow(RangeError);
  });
});

describe('DeclarePaymentDto', () => {
  const errorsOf = async (body: object) =>
    (
      await validate(plainToInstance(DeclarePaymentDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).map((error) => error.property);

  it('acepta monto como texto o numero y metodo valido', async () => {
    expect(await errorsOf({ amount: '25.50', method: 'QR' })).toEqual([]);
    expect(await errorsOf({ amount: 25, method: 'EFECTIVO' })).toEqual([]);
  });

  it.each(['0', '0.00', '-5', '1.234', 'abc', '', '123456789'])(
    'rechaza el monto %s',
    async (amount) => {
      expect(await errorsOf({ amount, method: 'QR' })).toContain('amount');
    },
  );

  it('rechaza un metodo desconocido (solo EFECTIVO o QR)', async () => {
    expect(await errorsOf({ amount: '10', method: 'TARJETA' })).toContain(
      'method',
    );
  });

  it('no acepta campos que decidan identidad o rol desde el cuerpo', async () => {
    const errors = await errorsOf({
      amount: '10',
      method: 'QR',
      userId: 'otro',
      declaredBy: 'TRABAJADOR',
    });
    expect(errors).toEqual(expect.arrayContaining(['userId', 'declaredBy']));
  });
});

describe('aviso de pago directo (RF-43)', () => {
  it('aclara que la plataforma no recibe ni retiene dinero', () => {
    expect(DIRECT_PAYMENT_NOTICE).toMatch(/no recibe, retiene ni garantiza/);
  });
});
