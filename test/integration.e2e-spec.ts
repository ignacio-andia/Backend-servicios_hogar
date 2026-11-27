//=========================================================
// MODIFICADO: integration.e2e-spec.ts
// Fase B3 (cancelacion): la lista de hooks del pedido incluye
// 'payments:resumen-cancelacion'. Necesario porque PaymentsModule captura
// ahora la fotografia economica al cancelar. Regla: sin ese hook registrado
// una cancelacion no dejaria resumen.
//=========================================================
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/common/setup-app.js';
import { OfferEventRegistry } from '../src/modules/offers/offer-events.registry.js';
import { AdvanceConfirmationRegistry } from '../src/modules/orders/advance-confirmation.registry.js';
import { OrderLifecycleRegistry } from '../src/modules/orders/order-lifecycle.registry.js';
import { PaymentsConfig } from '../src/modules/payments/payments.config.js';
import { ReviewsConfig } from '../src/modules/reviews/reviews.config.js';
import { VisitPaymentRegistry } from '../src/modules/service-workflow/visit-payment.port.js';
import { WorkflowEventRegistry } from '../src/modules/service-workflow/workflow-events.registry.js';
import { TimelineSourceRegistry } from '../src/modules/timeline/timeline-source.registry.js';

/**
 * Cableado de la aplicacion integrada: arranca SOLO AppModule y comprueba que
 * los modulos queden conectados (registros y hooks), que las rutas privadas
 * exijan sesion y que las decisiones pendientes del docente sigan desactivadas
 * por defecto. No crea ni modifica datos.
 */
describe('Integracion de la aplicacion (AppModule, e2e)', () => {
  let app: INestApplication<App>;
  const previous = {
    advance: process.env.PAYMENTS_ADVANCE_CONFIRMED_BY,
    reviews: process.env.REVIEWS_ELIGIBLE_STATUSES,
  };

  /** Nombres de los hooks registrados en un registro del proyecto. */
  const hookNames = (registry: object): string[] =>
    (registry as unknown as { hooks: { name: string }[] }).hooks
      .map((hook) => hook.name)
      .sort();

  beforeAll(async () => {
    // Sin configuracion: los valores por defecto del proyecto.
    process.env.PAYMENTS_ADVANCE_CONFIRMED_BY = '';
    process.env.REVIEWS_ELIGIBLE_STATUSES = '';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    process.env.PAYMENTS_ADVANCE_CONFIRMED_BY = previous.advance ?? '';
    process.env.REVIEWS_ELIGIBLE_STATUSES = previous.reviews ?? '';
  });

  it('conecta el cobro de la visita de ServiceWorkflow con Payments', () => {
    expect(app.get(VisitPaymentRegistry).get()).not.toBeNull();
  });

  it('conecta la verificacion del anticipo de Orders con Payments', () => {
    expect(app.get(AdvanceConfirmationRegistry).get()).not.toBeNull();
  });

  it('registra los hooks del pedido de Offers, Workflow, Claims, pagos y avisos', () => {
    expect(hookNames(app.get(OrderLifecycleRegistry))).toEqual([
      'claims:invariantes',
      'notifications:pedido',
      'offers:cierre-por-pedido',
      'payments:resumen-cancelacion',
      'workflow:invariantes',
    ]);
  });

  it('registra los hooks del flujo de trabajo y de las ofertas', () => {
    expect(hookNames(app.get(WorkflowEventRegistry))).toEqual([
      'notifications:flujo-de-trabajo',
    ]);
    expect(hookNames(app.get(OfferEventRegistry))).toEqual([
      'notifications:ofertas',
      'payments:constancia-servicio',
    ]);
  });

  it('registra los cinco lectores de la linea de tiempo', () => {
    expect(
      app
        .get(TimelineSourceRegistry)
        .list()
        .map((source) => source.name)
        .sort(),
    ).toEqual(['claims', 'offers', 'orders', 'payments', 'workflow']);
  });

  it('sin configuracion el anticipo lo confirma el trabajador (decision confirmada)', () => {
    expect(app.get(PaymentsConfig).advanceConfirmedBy).toBe('TRABAJADOR');
  });

  it('deja desactivadas por defecto las decisiones pendientes del docente', () => {
    expect(app.get(ReviewsConfig).policy.eligibleStatuses).toEqual([]);
  });

  const id = randomUUID();
  const privateRoutes: ['get' | 'post' | 'patch', string][] = [
    ['get', `/api/orders/${id}/workflow`],
    ['post', `/api/orders/${id}/finish`],
    ['post', `/api/orders/${id}/claims`],
    ['get', `/api/admin/claims`],
    ['get', `/api/orders/${id}/payments`],
    ['get', `/api/orders/${id}/receipts`],
    ['post', `/api/orders/${id}/payments/ANTICIPO/declarations`],
    ['get', `/api/admin/payments/differences`],
    ['post', `/api/orders/${id}/reviews`],
    ['get', `/api/orders/${id}/reviews/mine`],
    ['get', `/api/reviews/received`],
    ['get', `/api/admin/reviews`],
    ['patch', `/api/admin/reviews/${id}/hide`],
    ['get', `/api/orders/${id}/timeline`],
    ['get', `/api/agenda/me`],
    ['post', `/api/agenda/me/check`],
  ];

  it.each(privateRoutes)(
    '%s %s esta montada y exige sesion (401)',
    async (method, url) => {
      await request(app.getHttpServer())[method](url).expect(401);
    },
  );

  it.each([`/api/workers/${id}/public-profile`, `/api/workers/${id}/reviews`])(
    '%s es publica y no revela a quien no es un trabajador aprobado',
    async (url) => {
      const res = await request(app.getHttpServer()).get(url).expect(404);
      expect(res.body.message).toBe('El trabajador no existe');
    },
  );
});
