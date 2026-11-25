import { NotImplementedException } from '@nestjs/common';
import { ServiceWorkflowService } from './service-workflow.service.js';
import { VisitPaymentRegistry } from './visit-payment.port.js';

describe('puerto del cobro de la visita (VisitPaymentRegistry)', () => {
  it('sin modulo de pagos registrado, confirmar el cobro responde 501 sin tocar la BD', async () => {
    const transaction = vi.fn();
    const service = new ServiceWorkflowService(
      { $transaction: transaction } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new VisitPaymentRegistry(),
    );

    await expect(
      service.confirmVisitPayment('worker', 'order'),
    ).rejects.toBeInstanceOf(NotImplementedException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('admite un solo registrador', () => {
    const registry = new VisitPaymentRegistry();
    const recorder = { recordVisitPayment: () => Promise.resolve() };
    expect(registry.get()).toBeNull();
    registry.register(recorder);
    expect(registry.get()).toBe(recorder);
    expect(() => registry.register(recorder)).toThrow();
  });
});
