# Persona B — Integración, contratos y Prisma (estado implementado)

Rama: `feature/payments-reviews-agenda`, con `origin/feature/service-workflow-claims`
(Persona A) integrada localmente. Este documento reemplaza la propuesta de
contratos de la primera fase: ahora describe lo **implementado**. La
documentación por módulo está en cada `README.md`; los contratos para el
frontend, en [frontend-contracts.md](frontend-contracts.md).

## 1. Módulos entregados

| Módulo | Qué hace | README |
|---|---|---|
| `PaymentsModule` | Pagos, declaraciones, constancias, saldo esperado, diferencias (RF-39 a RF-43) | `src/modules/payments/README.md` |
| `ReviewsModule` | Calificaciones mutuas, perfil público, moderación (RF-44 a RF-46) | `src/modules/reviews/README.md` |
| `TimelineModule` | Seguimiento del pedido con lectores públicos (RF-32) | `src/modules/timeline/README.md` |
| `OrderNotificationsModule` | Avisos internos de eventos reales (RF-33) | `src/modules/order-notifications/README.md` |
| `AgendaModule` | Consulta de agenda y comprobación de horarios (RF-29 a RF-31) | `src/modules/agenda/README.md` |

## 2. Registrar en `app.module.ts` (lo hace el integrador; NO se editó aquí)

```ts
import { ServiceWorkflowModule } from './modules/service-workflow/service-workflow.module.js'; // A
import { ClaimsModule } from './modules/claims/claims.module.js';                             // A
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { TimelineModule } from './modules/timeline/timeline.module.js';
import { OrderNotificationsModule } from './modules/order-notifications/order-notifications.module.js';
import { AgendaModule } from './modules/agenda/agenda.module.js';
// imports: [..., ServiceWorkflowModule, ClaimsModule, PaymentsModule,
//           ReviewsModule, TimelineModule, OrderNotificationsModule, AgendaModule]
```

Sin ciclos: Payments → {Orders, Offers, ServiceWorkflow, WorkerProfile,
Notifications}; Timeline → {Orders, Offers, ServiceWorkflow, Payments};
Reviews → {Orders, WorkerProfile, Notifications}; OrderNotifications →
{Orders, Offers, ServiceWorkflow, Notifications}; Agenda → {Orders, Offers,
WorkerProfile}. Ninguno de los módulos existentes los importa.

**Aviso para el integrador:** `VisitPaymentRegistry` admite **un solo**
registrador (lo registra `PaymentsIntegration`). La prueba
`test/service-workflow.e2e-spec.ts` de A registra el suyo y espera el 501 sin
pagos: al sumar `PaymentsModule` a `AppModule` esa prueba debe ajustarse (por
ejemplo, no importando `PaymentsModule` ahí o dejando que use el registrador de
Pagos).

## 3. Contratos con Persona A y Offers (cómo quedaron)

| Necesidad | Contrato usado | Estado |
|---|---|---|
| Visita ↔ pago de visita | Puerto de A: `VisitPaymentRegistry.register({ recordVisitPayment(tx, { orderId, amount, confirmedByUserId }) })`. Pagos lo implementa (idempotente, siempre `EFECTIVO`, monto fijado por A). A guarda el hecho operativo; Pagos, el registro financiero. | **Integrado** y probado (`POST /orders/:id/visit/payment-confirmation` ya no responde 501). |
| Monto y adicionales | `WorkflowQueryService.getAgreedAmount` | **Integrado.** El saldo esperado ya incluye los adicionales aceptados. |
| Oferta aceptada | `OffersService.getAcceptedOfferTerms` (de A) | **Integrado.** |
| Participantes del pedido | `OrdersService.findOrderSummary(db, orderId)` (nuevo, aditivo, solo lectura) | Integrado. |
| Historial de estados | `OrdersService.listStatusHistory(db, orderId)` (nuevo, aditivo, solo lectura) | Integrado. |
| Historial de negociación | `OffersService.listNegotiationEvents(db, orderId)` (nuevo, aditivo, solo lectura) | Integrado. |
| Agenda | `OffersService.findAcceptedJobSlots(db, workerId, orderIds)` (nuevo, aditivo, solo lectura) | Integrado. |
| Inasistencia | `WorkflowQueryService.getNoShowReport(orderId, db)` (nuevo, aditivo, solo lectura) | Integrado. |
| Perfil público | `WorkerProfileService.getPublicProfile(workerUserId)` (nuevo, aditivo, solo lectura) | Integrado. |
| Avisos de ofertas | `OfferEventRegistry` (nuevo en OffersModule, mismo patrón que `OrderLifecycleRegistry`) | Integrado; sin hooks no hace nada. |
| Avisos de pedido y flujo | `OrderLifecycleRegistry` y `WorkflowEventRegistry` ya existentes | Integrado. |
| Transición del anticipo | `OrdersService.transition()` con `ACORDADO → ANTICIPO_REGISTRADO` (ya habilitada por A) | **Desactivada por defecto** (ver §5). |

Los cambios en Orders, Offers, WorkerProfile y ServiceWorkflow son **solo
aditivos** (métodos de lectura y el registro de eventos de ofertas); no se
modificaron las reglas de transición, `OrderStatus`, `order-transition.ts`,
`orders.rules.ts`, los invariantes `beforeTransition` ni la lógica de aceptación
y cruces de ofertas.

## 4. Prisma

Migraciones nuevas, posteriores a la de A (`20261124100000_service_workflow_and_claims`);
no se modificó ninguna anterior:

1. `20261124200000_payments_reviews_notifications`: enums `PaymentConcept`,
   `PaymentMethod`, `PaymentDeclarer`; tablas `payments`, `payment_declarations`,
   `service_receipts`, `reviews`; valores nuevos de `NotificationType` y
   `NotificationResourceType`; CHECK (`amount > 0`, `rating` 1–5, sin
   autocalificación, `hidden_*` juntos); triggers de solo inserción
   (`append_only_guard`) en pagos, declaraciones y constancias, y `reviews_guard`
   (no se borra; solo se puede ocultar).
2. `20261124210000_notification_offer_expired`: `NotificationType.OFERTA_VENCIDA`.

`schema.prisma`: los modelos de A se conservan intactos; los míos están en un
bloque independiente al final, y las relaciones inversas en `User`
(`paymentDeclarations`, `receiptsAsClient`, `receiptsAsWorker`, `reviewsAuthored`,
`reviewsReceived`, `reviewsHidden`) y `Order` (`payments`, `serviceReceipt`,
`reviews`) tienen nombres explícitos. No hay relación con `Offer`: el monto y el
costo de la visita se leen con `getAcceptedOfferTerms` y se copian
(`expectedAmount`, `agreedAmount`) para que la constancia no cambie.

## 5. Decisiones pendientes del docente (aisladas, no asumidas)

| Tema | Estado en el código |
|---|---|
| Quién confirma la recepción del anticipo (CU-39; RN-03 solo regula el saldo) | `PAYMENTS_ADVANCE_CONFIRMED_BY` sin valor ⇒ la transición `ACORDADO → ANTICIPO_REGISTRADO` **no se hace**; el anticipo se registra igual. **Mientras esté desactivada, el flujo de A no avanza de `ACORDADO`** (visita, inicio y ejecución exigen `ANTICIPO_REGISTRADO`). |
| Base del 25 % del anticipo | Monto de la oferta aceptada; incluir o no los adicionales está pendiente (`PaymentsService.expectedFor`). |
| Pago parcial del saldo (RF-40 A2) | Se registra lo declarado y se informa la diferencia; sin pagos encadenados ni conciliación definitiva. |
| Estados que habilitan calificar (CU-44 vs CU-45) | `REVIEWS_ELIGIBLE_STATUSES` sin valor ⇒ calificaciones deshabilitadas. |
| Efecto de la inasistencia en estrellas (RF-36) | No existe ningún ajuste automático. |
| Tratamiento del anticipo al cancelar (RF-34) | No se decide: un pedido cancelado no admite declaraciones. |
| Redondeo del anticipo | Decisión técnica: 2 decimales, mitad hacia arriba (`MONEY_ROUNDING`). |
| Lenguaje ofensivo en comentarios (RF-44 A1) | No implementado; solo ocultación manual por el administrador. |

## 6. No implementado

- Subida de comprobante de QR como referencia (la columna `referenceFileKey` está reservada).
- Avisos de «próximo vencimiento» y «nuevo pedido compatible» (matriz de la
  especificación §7.4 sin cerrar).
- RF-31 A1 (extensión de la duración real y revalidación del horario).
