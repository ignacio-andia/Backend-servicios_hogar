import { ForbiddenException } from '@nestjs/common';
import { ServiceWorkflowService } from './service-workflow.service.js';
import { VisitPaymentRegistry } from './visit-payment.port.js';

// RF-13: las acciones del trabajador sobre un trabajo acordado validan su
// aprobacion sin mirar solicitudes de cambio de zona.

const WORKER = 'worker';
const ORDER = 'order';

function setup() {
  const stop = new ForbiddenException('corta despues de validar');
  const workerProfiles = {
    lockApprovedWorker: vi.fn(),
    lockApprovedWorkerForAgreedWork: vi.fn(() => Promise.reject(stop)),
  };
  const tx = { $queryRaw: vi.fn() };
  const visitPayments = new VisitPaymentRegistry();
  visitPayments.register({ recordVisitPayment: () => Promise.resolve() });
  const service = new ServiceWorkflowService(
    { $transaction: (work: (db: unknown) => unknown) => work(tx) } as never,
    {} as never,
    {} as never,
    workerProfiles as never,
    {} as never,
    visitPayments,
  );
  return { service, workerProfiles, tx, stop };
}

describe('ServiceWorkflowService: validacion del trabajador (RF-13)', () => {
  it.each<[string, (service: ServiceWorkflowService) => Promise<unknown>]>([
    ['registrar la visita', (s) => s.registerVisit(WORKER, ORDER)],
    ['confirmar su cobro', (s) => s.confirmVisitPayment(WORKER, ORDER)],
    ['iniciar el trabajo', (s) => s.startWork(WORKER, ORDER)],
    [
      'presupuesto adicional',
      (s) =>
        s.createAdditionalBudget(WORKER, ORDER, {
          amount: '10.00',
          reason: 'motivo',
          materials: 'materiales',
        }),
    ],
    ['finalizar el trabajo', (s) => s.finishWork(WORKER, ORDER)],
  ])(
    '%s usa lockApprovedWorkerForAgreedWork antes de tocar el pedido',
    async (_name, action) => {
      const { service, workerProfiles, tx, stop } = setup();

      await expect(action(service)).rejects.toBe(stop);

      expect(
        workerProfiles.lockApprovedWorkerForAgreedWork,
      ).toHaveBeenCalledWith(tx, WORKER);
      expect(workerProfiles.lockApprovedWorker).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
});
