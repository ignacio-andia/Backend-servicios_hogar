import type { Prisma } from '../../generated/prisma/client.js';
import { OrderStatus, RoleName } from '../../generated/prisma/enums.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { OfferEventRegistry } from '../offers/offer-events.registry.js';
import type { OffersService } from '../offers/offers.service.js';
import { OrderLifecycleRegistry } from '../orders/order-lifecycle.registry.js';
import type { OrdersService } from '../orders/orders.service.js';
import {
  type WorkflowEvent,
  WorkflowEventRegistry,
} from '../service-workflow/workflow-events.registry.js';
import { OrderNotificationsIntegration } from './order-notifications.integration.js';

type Fn = ReturnType<typeof vi.fn>;

const CLIENT = 'client-1';
const WORKER = 'worker-1';
const ORDER = 'order-1';
const tx = { marker: 'tx' } as unknown as Prisma.TransactionClient;

describe('OrderNotificationsIntegration (RF-33)', () => {
  let create: Fn;
  let createForRole: Fn;
  let findOrderSummary: Fn;
  let listNegotiationEvents: Fn;
  let lifecycle: OrderLifecycleRegistry;
  let workflow: WorkflowEventRegistry;
  let offerEvents: OfferEventRegistry;
  let integration: OrderNotificationsIntegration;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue(undefined);
    createForRole = vi.fn().mockResolvedValue(0);
    findOrderSummary = vi.fn().mockResolvedValue({
      orderId: ORDER,
      clientId: CLIENT,
      assignedWorkerId: WORKER,
      status: OrderStatus.EN_EJECUCION,
    });
    listNegotiationEvents = vi.fn().mockResolvedValue([]);
    lifecycle = new OrderLifecycleRegistry();
    workflow = new WorkflowEventRegistry();
    offerEvents = new OfferEventRegistry();
    integration = new OrderNotificationsIntegration(
      { create, createForRole } as unknown as NotificationsService,
      { findOrderSummary } as unknown as OrdersService,
      { listNegotiationEvents } as unknown as OffersService,
      lifecycle,
      workflow,
      offerEvents,
    );
  });

  const sent = () =>
    create.mock.calls.map(([userId, notification]) => ({
      userId: userId as string,
      type: (notification as { type: string }).type,
    }));

  it('se registra en los tres puntos de extension y nunca hace llamadas fuera de la transaccion', async () => {
    integration.onModuleInit();
    // Registrar dos veces falla: los nombres son unicos (no quedan hooks duplicados).
    expect(() => integration.onModuleInit()).toThrow();
    await workflow.runInTransaction(
      [{ type: 'TRABAJO_INICIADO', orderId: ORDER, workerId: WORKER }],
      tx,
    );
    // Siempre con el `tx` del hecho como ultimo argumento.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][2]).toBe(tx);
  });

  describe('eventos del flujo de trabajo (los 11, ninguno queda sin aviso)', () => {
    const events: WorkflowEvent[] = [
      { type: 'VISITA_REGISTRADA', orderId: ORDER, workerId: WORKER },
      { type: 'TRABAJO_INICIADO', orderId: ORDER, workerId: WORKER },
      {
        type: 'ADICIONAL_PROPUESTO',
        orderId: ORDER,
        budgetId: 'b1',
        workerId: WORKER,
      },
      { type: 'ADICIONAL_ACEPTADO', orderId: ORDER, budgetId: 'b1' },
      {
        type: 'TRABAJO_TERMINADO',
        orderId: ORDER,
        workerId: WORKER,
        conformityDeadline: new Date('2026-12-01T12:00:00Z'),
      },
      { type: 'CONFORMIDAD_CONFIRMADA', orderId: ORDER },
      { type: 'CIERRE_POR_PLAZO', orderId: ORDER },
      { type: 'INASISTENCIA_REPORTADA', orderId: ORDER, workerId: WORKER },
      { type: 'RECLAMO_PRESENTADO', orderId: ORDER, claimId: 'cl1' },
      { type: 'RECLAMO_EN_REVISION', orderId: ORDER, claimId: 'cl1' },
      {
        type: 'RECLAMO_RESUELTO',
        orderId: ORDER,
        claimId: 'cl1',
        closedFrom: OrderStatus.EN_RECLAMO,
      },
    ];

    it.each(events.map((event) => [event.type, event] as const))(
      '%s genera un aviso con el tx del hecho',
      async (_name, event) => {
        await integration.onWorkflowEvent(event, tx);
        expect(
          create.mock.calls.length + createForRole.mock.calls.length,
        ).toBeGreaterThan(0);
        for (const call of create.mock.calls) {
          expect(call[2]).toBe(tx);
        }
        for (const call of createForRole.mock.calls) {
          expect(call[3]).toBe(tx);
        }
      },
    );

    it('cada evento va a los destinatarios correctos', async () => {
      const expected: Record<string, string[]> = {
        VISITA_REGISTRADA: [CLIENT],
        TRABAJO_INICIADO: [CLIENT],
        ADICIONAL_PROPUESTO: [CLIENT],
        ADICIONAL_ACEPTADO: [WORKER],
        TRABAJO_TERMINADO: [CLIENT],
        CONFORMIDAD_CONFIRMADA: [WORKER],
        CIERRE_POR_PLAZO: [CLIENT, WORKER],
        INASISTENCIA_REPORTADA: [WORKER],
        RECLAMO_PRESENTADO: [WORKER],
        RECLAMO_EN_REVISION: [CLIENT],
        RECLAMO_RESUELTO: [CLIENT, WORKER],
      };
      for (const event of events) {
        create.mockClear();
        await integration.onWorkflowEvent(event, tx);
        expect(sent().map((n) => n.userId)).toEqual(expected[event.type]);
      }
    });

    it('un reclamo nuevo y una inasistencia tambien avisan a los administradores', async () => {
      await integration.onWorkflowEvent(events[8], tx);
      await integration.onWorkflowEvent(events[7], tx);
      expect(createForRole).toHaveBeenCalledTimes(2);
      expect(createForRole.mock.calls[0][0]).toBe(RoleName.ADMINISTRADOR);
    });

    it('sin trabajador asignado no falla ni inventa destinatarios', async () => {
      findOrderSummary.mockResolvedValue({
        orderId: ORDER,
        clientId: CLIENT,
        assignedWorkerId: null,
        status: OrderStatus.CANCELADO,
      });
      await integration.onWorkflowEvent(events[3], tx);
      expect(create).not.toHaveBeenCalled();
    });

    it('un pedido inexistente no genera avisos', async () => {
      findOrderSummary.mockResolvedValue(null);
      await integration.onWorkflowEvent(events[0], tx);
      expect(create).not.toHaveBeenCalled();
    });

    it('los textos no incluyen direccion ni telefono', async () => {
      for (const event of events) {
        await integration.onWorkflowEvent(event, tx);
      }
      const text = JSON.stringify(create.mock.calls.map((c) => c[1]));
      expect(text).not.toMatch(/Av\.|calle|tel[eé]fono|\+591|7\d{7}/i);
    });
  });

  describe('cancelacion y vencimiento del pedido', () => {
    it('cancelar un trabajo acordado avisa al trabajador y no al cliente que cancela', async () => {
      await integration.onOrderEvent(
        {
          type: 'CANCELADO',
          orderId: ORDER,
          fromStatus: OrderStatus.ACORDADO,
          actor: { type: 'USUARIO', userId: CLIENT, role: RoleName.CLIENTE },
          reason: 'Cambio de planes',
        },
        tx,
      );
      expect(sent()).toEqual([{ userId: WORKER, type: 'PEDIDO_CANCELADO' }]);
    });

    it('avisa a los oferentes con ofertas abiertas y no a quienes ya la cerraron', async () => {
      findOrderSummary.mockResolvedValue({
        orderId: ORDER,
        clientId: CLIENT,
        assignedWorkerId: null,
        status: OrderStatus.EN_NEGOCIACION,
      });
      listNegotiationEvents.mockResolvedValue([
        { offerId: 'a', workerId: 'w-open', type: 'PROPUESTA' },
        { offerId: 'b', workerId: 'w-withdrawn', type: 'PROPUESTA' },
        { offerId: 'b', workerId: 'w-withdrawn', type: 'RETIRADA' },
        { offerId: 'c', workerId: 'w-superseded', type: 'PROPUESTA' },
        { offerId: 'c', workerId: 'w-superseded', type: 'SIN_EFECTO' },
      ]);
      await integration.onOrderEvent(
        {
          type: 'CANCELADO',
          orderId: ORDER,
          fromStatus: OrderStatus.EN_NEGOCIACION,
          actor: { type: 'USUARIO', userId: CLIENT, role: RoleName.CLIENTE },
          reason: null,
        },
        tx,
      );
      expect(
        sent()
          .map((n) => n.userId)
          .sort(),
      ).toEqual(['w-open', 'w-superseded'].sort());
    });

    it('un pedido vencido avisa al cliente y a los oferentes abiertos', async () => {
      findOrderSummary.mockResolvedValue({
        orderId: ORDER,
        clientId: CLIENT,
        assignedWorkerId: null,
        status: OrderStatus.EN_NEGOCIACION,
      });
      listNegotiationEvents.mockResolvedValue([
        { offerId: 'a', workerId: 'w-open', type: 'PROPUESTA' },
      ]);
      await integration.onOrderEvent(
        {
          type: 'VENCIDO',
          orderId: ORDER,
          fromStatus: OrderStatus.EN_NEGOCIACION,
        },
        tx,
      );
      expect(sent()).toEqual([
        { userId: 'w-open', type: 'PEDIDO_VENCIDO' },
        { userId: CLIENT, type: 'PEDIDO_VENCIDO' },
      ]);
    });

    it('otros eventos del pedido (EDITADO) no generan avisos', async () => {
      await integration.onOrderEvent(
        {
          type: 'EDITADO',
          orderId: ORDER,
          revision: 2,
          actor: { type: 'USUARIO', userId: CLIENT, role: RoleName.CLIENTE },
        },
        tx,
      );
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('ofertas y negociacion', () => {
    const base = {
      offerId: 'o1',
      orderId: ORDER,
      workerId: WORKER,
      clientId: CLIENT,
      round: 1,
    };

    it('nueva oferta: al cliente; la contraoferta, a la otra parte', async () => {
      await integration.onOfferEvent(
        { ...base, type: 'PROPUESTA', actorId: WORKER, amount: '100.00' },
        tx,
      );
      await integration.onOfferEvent(
        { ...base, type: 'CONTRAOFERTA', actorId: CLIENT, amount: '90.00' },
        tx,
      );
      await integration.onOfferEvent(
        { ...base, type: 'CONTRAOFERTA', actorId: WORKER, amount: '95.00' },
        tx,
      );
      expect(sent()).toEqual([
        { userId: CLIENT, type: 'OFERTA_RECIBIDA' },
        { userId: WORKER, type: 'CONTRAOFERTA_RECIBIDA' },
        { userId: CLIENT, type: 'CONTRAOFERTA_RECIBIDA' },
      ]);
    });

    it('aceptada y rechazada: al trabajador; retirada: al cliente; vencida: a ambos', async () => {
      for (const type of ['ACEPTADA', 'RECHAZADA', 'RETIRADA'] as const) {
        await integration.onOfferEvent(
          {
            ...base,
            type,
            actorId: type === 'RETIRADA' ? WORKER : CLIENT,
            amount: null,
          },
          tx,
        );
      }
      await integration.onOfferEvent(
        { ...base, type: 'VENCIDA', actorId: null, amount: null },
        tx,
      );
      expect(sent()).toEqual([
        { userId: WORKER, type: 'OFERTA_ACEPTADA' },
        { userId: WORKER, type: 'OFERTA_RECHAZADA' },
        { userId: CLIENT, type: 'OFERTA_RETIRADA' },
        { userId: CLIENT, type: 'OFERTA_VENCIDA' },
        { userId: WORKER, type: 'OFERTA_VENCIDA' },
      ]);
    });

    it('nunca avisa a quien origino el hecho', async () => {
      await integration.onOfferEvent(
        { ...base, type: 'RETIRADA', actorId: CLIENT, amount: null },
        tx,
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('un fallo al guardar el aviso se propaga (el hecho se revierte)', async () => {
      create.mockRejectedValue(new Error('fallo'));
      await expect(
        integration.onOfferEvent(
          { ...base, type: 'PROPUESTA', actorId: WORKER, amount: '1.00' },
          tx,
        ),
      ).rejects.toThrow('fallo');
    });
  });
});
