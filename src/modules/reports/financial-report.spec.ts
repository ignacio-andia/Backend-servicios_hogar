import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import type { FinancialReportRecord } from '../payments/payments.service.js';
import { FinancialReportQueryDto } from './dto/financial-report-query.dto.js';
import { readCommissionPercent } from './financial-report.config.js';
import {
  buildFinancialTable,
  computeAmounts,
  toLaPazDateTime,
} from './financial-report.js';
import { ReportsService } from './reports.service.js';

const d = (value: string) => new Prisma.Decimal(value);
const FIFTEEN = d('15');

function record(
  overrides: Partial<FinancialReportRecord> = {},
): FinancialReportRecord {
  return {
    orderId: 'order-1',
    status: OrderStatus.EN_EJECUCION,
    categoryId: 'cat',
    zoneId: 'zone',
    agreedAt: new Date('2026-11-20T15:30:00.000Z'),
    baseAmount: d('200.00'),
    acceptedAdditional: d('0'),
    visitCost: null,
    closedByRejection: false,
    confirmed: { ANTICIPO: d('0'), VISITA: d('0'), SALDO: d('0') },
    ...overrides,
  };
}

const text = (amounts: ReturnType<typeof computeAmounts>) => ({
  expected: amounts.expected.toFixed(2),
  income: amounts.income.toFixed(2),
  pending: amounts.pending.toFixed(2),
  commission: amounts.commission.toFixed(2),
});

describe('computeAmounts (reporte financiero)', () => {
  it('sin pagos confirmados todo lo esperado queda pendiente y no hay comision', () => {
    expect(text(computeAmounts(record(), FIFTEEN))).toEqual({
      expected: '200.00',
      income: '0.00',
      pending: '200.00',
      commission: '0.00',
    });
  });

  it('suma oferta, adicionales aceptados y visita con costo, y resta lo confirmado', () => {
    const amounts = computeAmounts(
      record({
        acceptedAdditional: d('40.00'),
        visitCost: d('30.00'),
        confirmed: { ANTICIPO: d('50.00'), VISITA: d('30.00'), SALDO: d('0') },
      }),
      FIFTEEN,
    );

    expect(text(amounts)).toEqual({
      expected: '270.00',
      income: '80.00',
      pending: '190.00',
      commission: '12.00',
    });
  });

  it('nunca deja un pendiente negativo si se confirmo de mas', () => {
    const amounts = computeAmounts(
      record({
        status: OrderStatus.CERRADO,
        confirmed: { ANTICIPO: d('50'), VISITA: d('0'), SALDO: d('170') },
      }),
      FIFTEEN,
    );

    expect(text(amounts).pending).toBe('0.00');
    expect(text(amounts).income).toBe('220.00');
  });

  it('un pedido cancelado no deja pendiente, pero conserva lo confirmado', () => {
    const amounts = computeAmounts(
      record({
        status: OrderStatus.CANCELADO,
        confirmed: { ANTICIPO: d('50'), VISITA: d('0'), SALDO: d('0') },
      }),
      FIFTEEN,
    );

    expect(text(amounts)).toEqual({
      expected: '200.00',
      income: '50.00',
      pending: '0.00',
      commission: '7.50',
    });
  });

  it('cerrado por rechazo de un adicional: solo queda el cobro de la visita', () => {
    const pendingVisit = computeAmounts(
      record({
        status: OrderStatus.CERRADO,
        closedByRejection: true,
        visitCost: d('30.00'),
        confirmed: { ANTICIPO: d('50'), VISITA: d('0'), SALDO: d('0') },
      }),
      FIFTEEN,
    );
    const visitPaid = computeAmounts(
      record({
        status: OrderStatus.CERRADO,
        closedByRejection: true,
        visitCost: d('30.00'),
        confirmed: { ANTICIPO: d('50'), VISITA: d('30'), SALDO: d('0') },
      }),
      FIFTEEN,
    );

    expect(text(pendingVisit).pending).toBe('30.00');
    expect(text(visitPaid).pending).toBe('0.00');
  });

  it('redondea la comision a 2 decimales (mitad hacia arriba)', () => {
    const amounts = computeAmounts(
      record({
        confirmed: { ANTICIPO: d('33.33'), VISITA: d('0'), SALDO: d('0') },
      }),
      d('12.5'),
    );

    // 33.33 x 12.5 % = 4.16625 -> 4.17
    expect(text(amounts).commission).toBe('4.17');
  });

  it('trata como 0 un pedido sin oferta aceptada', () => {
    expect(
      text(computeAmounts(record({ baseAmount: null }), FIFTEEN)).expected,
    ).toBe('0.00');
  });
});

describe('buildFinancialTable', () => {
  it('arma una fila por pedido con montos en texto y suma los totales', () => {
    const { rows, totals } = buildFinancialTable(
      [
        record({
          confirmed: { ANTICIPO: d('50'), VISITA: d('0'), SALDO: d('0') },
        }),
        record({
          orderId: 'order-2',
          status: OrderStatus.CANCELADO,
          baseAmount: d('100'),
          confirmed: { ANTICIPO: d('25'), VISITA: d('0'), SALDO: d('0') },
        }),
      ],
      FIFTEEN,
      () => ['Plomería', 'Norte'],
    );

    expect(rows[0]).toEqual([
      'order-1',
      '2026-11-20 11:30',
      'Plomería',
      'Norte',
      'EN_EJECUCION',
      '200.00',
      '0.00',
      '0.00',
      '200.00',
      '50.00',
      '150.00',
      '7.50',
    ]);
    expect(totals).toEqual({
      orders: 2,
      expected: '300.00',
      income: '75.00',
      pending: '150.00',
      commission: '11.25',
    });
  });

  it('sin pedidos devuelve totales en cero', () => {
    expect(buildFinancialTable([], FIFTEEN, () => ['', '']).totals).toEqual({
      orders: 0,
      expected: '0.00',
      income: '0.00',
      pending: '0.00',
      commission: '0.00',
    });
  });

  it('muestra la fecha del acuerdo en hora de Bolivia', () => {
    expect(toLaPazDateTime(new Date('2026-11-21T02:15:00.000Z'))).toBe(
      '2026-11-20 22:15',
    );
  });
});

describe('readCommissionPercent', () => {
  it('usa 15 si no esta configurado', () => {
    expect(readCommissionPercent(undefined).toFixed(2)).toBe('15.00');
    expect(readCommissionPercent('  ').toFixed(2)).toBe('15.00');
  });

  it.each(['0', '10', '12.5', '100'])('acepta %s', (value) => {
    expect(readCommissionPercent(value).eq(d(value))).toBe(true);
  });

  it.each(['-1', '100.01', '101', 'diez', '1.234', '1,5'])(
    'rechaza %s',
    (value) => {
      expect(() => readCommissionPercent(value)).toThrow(
        'FINANCIAL_COMMISSION_PERCENT',
      );
    },
  );
});

describe('FinancialReportQueryDto', () => {
  const check = async (query: Record<string, unknown>) => {
    const dto = plainToInstance(FinancialReportQueryDto, query);
    return { dto, errors: await validate(dto) };
  };

  it('acepta estados separados por coma, sin repetidos', async () => {
    const { dto, errors } = await check({
      from: '2026-11-01',
      to: '2026-11-30',
      status: 'CERRADO, TERMINADO,CERRADO',
    });

    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['CERRADO', 'TERMINADO']);
    expect(dto.format).toBe('json');
  });

  it('sin estados devuelve una lista vacia', async () => {
    const { dto, errors } = await check({
      from: '2026-11-01',
      to: '2026-11-30',
    });

    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual([]);
  });

  it('rechaza un estado que no existe y un formato no admitido', async () => {
    const { errors } = await check({
      from: '2026-11-01',
      to: '2026-11-30',
      status: 'PAGADO',
      format: 'pdf',
    });

    expect(errors.map((error) => error.property).sort()).toEqual([
      'format',
      'status',
    ]);
  });
});

describe('ReportsService.buildFinancial', () => {
  function service(records: FinancialReportRecord[]) {
    const payments = {
      listForFinancialReport: vi.fn().mockResolvedValue(records),
    };
    const catalogs = {
      findByIds: vi.fn((kind: string) =>
        Promise.resolve(
          kind === 'CATEGORY'
            ? [{ id: 'cat', name: 'Plomería' }]
            : [{ id: 'zone', name: 'Norte' }],
        ),
      ),
    };
    const reports = new ReportsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      catalogs as never,
      payments as never,
      { commissionPercent: FIFTEEN } as never,
    );
    return { reports, payments };
  }

  it('pasa el rango de Bolivia y los estados, y devuelve aviso, columnas y totales', async () => {
    const { reports, payments } = service([record()]);

    const report = await reports.buildFinancial('2026-11-01', '2026-11-30', [
      OrderStatus.EN_EJECUCION,
    ]);

    expect(payments.listForFinancialReport).toHaveBeenCalledWith(
      {
        start: new Date('2026-11-01T04:00:00.000Z'),
        end: new Date('2026-12-01T04:00:00.000Z'),
      },
      [OrderStatus.EN_EJECUCION],
    );
    expect(report.report).toBe('financiero');
    expect(report.commissionPercent).toBe('15.00');
    expect(report.notice).toContain('no recibe, retiene ni garantiza dinero');
    expect(report.notice).toContain('comisión es solo informativa');
    expect(report.columns[0]).toBe('pedido');
    expect(report.rows[0].slice(2, 4)).toEqual(['Plomería', 'Norte']);
    expect(report.totals.pending).toBe('200.00');
    expect(report.message).toBeNull();
  });

  it('avisa cuando no hay pedidos en el rango', async () => {
    const { reports } = service([]);

    const report = await reports.buildFinancial('2026-11-01', '2026-11-30', []);

    expect(report.rows).toEqual([]);
    expect(report.message).toBe('No hay datos en el rango indicado.');
  });

  it('rechaza un rango invertido sin consultar datos', async () => {
    const { reports, payments } = service([]);

    await expect(
      reports.buildFinancial('2026-11-30', '2026-11-01', []),
    ).rejects.toThrow('Rango de fechas no válido');
    expect(payments.listForFinancialReport).not.toHaveBeenCalled();
  });
});
