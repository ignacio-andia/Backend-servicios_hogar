# Persona B — Integración, contratos y Prisma (estado implementado)

Estado integrado en `integration/sprint-1`. Este documento reemplaza la propuesta
de contratos de la primera fase: describe lo **implementado**. La documentación
por módulo está en cada `README.md`; los contratos para el frontend, en
[frontend-contracts.md](frontend-contracts.md) y en
[10-sprint1-endpoints.md](../frontend-api-contracts/10-sprint1-endpoints.md).

## 1. Módulos entregados

| Módulo                     | Qué hace                                                                       | README                                      |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| `PaymentsModule`           | Pagos, declaraciones, constancias, saldo esperado, diferencias (RF-39 a RF-43) | `src/modules/payments/README.md`            |
| `ReviewsModule`            | Calificaciones mutuas, perfil público, moderación (RF-44 a RF-46)              | `src/modules/reviews/README.md`             |
| `TimelineModule`           | Seguimiento del pedido con lectores públicos (RF-32)                           | `src/modules/timeline/README.md`            |
| `OrderNotificationsModule` | Avisos internos de eventos reales (RF-33)                                      | `src/modules/order-notifications/README.md` |
| `AgendaModule`             | Consulta de agenda y comprobación de horarios (RF-29 a RF-31)                  | `src/modules/agenda/README.md`              |

## 2. Registro en `app.module.ts`

`AppModule` registra, además de los módulos anteriores:

```ts
(ServiceWorkflowModule,
  ClaimsModule,
  PaymentsModule,
  ReviewsModule,
  TimelineModule,
  OrderNotificationsModule,
  AgendaModule);
```

Sin ciclos: Payments → {Orders, Offers, ServiceWorkflow, WorkerProfile,
Notifications}; Timeline → {Orders, Offers, ServiceWorkflow, Payments};
Reviews → {Orders, WorkerProfile, Notifications}; OrderNotifications →
{Orders, Offers, ServiceWorkflow, Notifications}; Agenda → {Orders, Offers,
WorkerProfile}. Ninguno de los módulos existentes los importa.

`VisitPaymentRegistry` y `AdvanceConfirmationRegistry` admiten **un solo**
registrador cada uno; ambos los registra `PaymentsIntegration`. En la aplicación
integrada el cobro de la visita queda registrado en Pagos.

## 3. Contratos con Persona A y Offers (cómo quedaron)

| Necesidad                | Contrato usado                                                                                                                                                                                                                                           | Estado                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Visita ↔ pago de visita  | Puerto de A: `VisitPaymentRegistry.register({ recordVisitPayment(tx, { orderId, amount, confirmedByUserId }) })`. Pagos lo implementa (idempotente, siempre `EFECTIVO`, monto fijado por A). A guarda el hecho operativo; Pagos, el registro financiero. | **Integrado** y probado (`POST /orders/:id/visit/payment-confirmation`). |
| Monto y adicionales      | `WorkflowQueryService.getAgreedAmount`                                                                                                                                                                                                                   | **Integrado.** El saldo esperado ya incluye los adicionales aceptados.   |
| Oferta aceptada          | `OffersService.getAcceptedOfferTerms` (de A)                                                                                                                                                                                                             | **Integrado.**                                                           |
| Participantes del pedido | `OrdersService.findOrderSummary(db, orderId)` (nuevo, aditivo, solo lectura)                                                                                                                                                                             | Integrado.                                                               |
| Historial de estados     | `OrdersService.listStatusHistory(db, orderId)` (nuevo, aditivo, solo lectura)                                                                                                                                                                            | Integrado.                                                               |
| Historial de negociación | `OffersService.listNegotiationEvents(db, orderId)` (nuevo, aditivo, solo lectura)                                                                                                                                                                        | Integrado.                                                               |
| Agenda                   | `OffersService.findAcceptedJobSlots(db, workerId, orderIds)` (nuevo, aditivo, solo lectura)                                                                                                                                                              | Integrado.                                                               |
| Inasistencia             | `WorkflowQueryService.getNoShowReport(orderId, db)` (nuevo, aditivo, solo lectura)                                                                                                                                                                       | Integrado.                                                               |
| Perfil público           | `WorkerProfileService.getPublicProfile(workerUserId)` (nuevo, aditivo, solo lectura)                                                                                                                                                                     | Integrado.                                                               |
| Avisos de ofertas        | `OfferEventRegistry` (nuevo en OffersModule, mismo patrón que `OrderLifecycleRegistry`)                                                                                                                                                                  | Integrado; sin hooks no hace nada.                                       |
| Avisos de pedido y flujo | `OrderLifecycleRegistry` y `WorkflowEventRegistry` ya existentes                                                                                                                                                                                         | Integrado.                                                               |
| Transición del anticipo  | `OrdersService.transition()` con `ACORDADO → ANTICIPO_REGISTRADO`. Orders exige que el actor sea el trabajador asignado y pide la confirmación por `AdvanceConfirmationRegistry` (Pagos: `hasValidAdvanceConfirmation`).                                 | **Activa**: la dispara la confirmación del trabajador.                   |

Los contratos de lectura anteriores son aditivos. La integración añadió además:
la guarda del anticipo en `OrdersService.transition()` (con
`AdvanceConfirmationRegistry`) y el campo `reason` en `NegotiationEventRecord`,
que los avisos usan para no confundir los cierres que provoca el propio pedido.
No se modificaron `OrderStatus` ni la lógica de aceptación y cruces de ofertas.

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

**Resuelta:** el anticipo lo confirma exclusivamente el trabajador asignado
(`PAYMENTS_ADVANCE_CONFIRMED_BY=TRABAJADOR`, único valor y predeterminado).

| Tema                                             | Estado en el código                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Estados que habilitan calificar (CU-44 vs CU-45) | `REVIEWS_ELIGIBLE_STATUSES` sin valor ⇒ calificaciones deshabilitadas.                                    |
| Base del 25 % del anticipo                       | Monto de la oferta aceptada; incluir o no los adicionales está pendiente (`PaymentsService.expectedFor`). |
| Pago parcial del saldo (RF-40 A2)                | Se registra lo declarado y se informa la diferencia; sin pagos encadenados ni conciliación definitiva.    |
| Efecto de la inasistencia en estrellas (RF-36)   | No existe ningún ajuste automático.                                                                       |
| Tratamiento del anticipo al cancelar (RF-34)     | No se decide: un pedido cancelado solo admite el cobro de la visita ya realizada.                         |
| Redondeo del anticipo                            | Decisión técnica: 2 decimales, mitad hacia arriba (`MONEY_ROUNDING`).                                     |
| Lenguaje ofensivo en comentarios (RF-44 A1)      | No implementado; solo ocultación manual por el administrador.                                             |

## 6. No implementado

- Subida de comprobante de QR como referencia (la columna `referenceFileKey` está reservada).
- Avisos de «próximo vencimiento» y «nuevo pedido compatible» (matriz de la
  especificación §7.4 sin cerrar).
- RF-31 A1 (extensión de la duración real y revalidación del horario).
