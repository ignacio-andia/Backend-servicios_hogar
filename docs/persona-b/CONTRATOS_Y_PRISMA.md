# Persona B — Contratos públicos y propuesta Prisma (para revisión)

**Estado:** PROPUESTA. No se ha modificado `schema.prisma`, ni enums compartidos, ni migraciones, ni `app.module.ts`, ni Orders/Offers. Nada de este documento se aplica sin autorización y sin coordinar con Persona A.

Rama: `feature/payments-reviews-agenda`. Fuentes: requerimientos v1.2, arquitectura, especificación v1.0 y adenda v1.1.

## 1. Lo ya implementado en esta fase (sin Prisma, sin integraciones)

| Pieza | Archivos | Qué hace |
|---|---|---|
| Agenda (solo tests) | `worker-profile/schedules.agenda.spec.ts`, `offers/offer-slots.agenda.spec.ts` | Bordes de horario, zona `America/La_Paz` (UTC-4, sin DST), medianoche, DOMINGO→LUNES y `[inicio, inicio+duración)`. No cambian lógica. |
| Pagos (dominio puro) | `payments/payments.rules.ts`, `payment-declarations.ts`, `expected-balance.ts`, `dto/declare-payment.dto.ts`, `contracts/payment-contracts.ts` | Anticipo 25 % con `Prisma.Decimal`, resumen informativo de declaraciones, saldo esperado, DTO y contratos (solo interfaces). |
| Reseñas (dominio puro) | `reviews/review-eligibility.policy.ts`, `review-rules.ts`, `dto/create-review.dto.ts` | Política de elegibilidad aislada, reglas inmutables, promedio. |
| Timeline (sin Prisma de dominio) | `timeline/timeline.types.ts`, `timeline-page.ts`, `timeline-source.registry.ts`, `timeline.service.ts` | Unión, orden y paginación de eventos que aportan lectores públicos. |
| Contrato compartido | `common/contracts/order-participants.reader.ts` | Interfaz de participantes del pedido. |

No existen todavía controladores, módulos Nest ni servicios con Prisma de pagos/reseñas: dependen de los modelos propuestos abajo.

### Reglas de dinero fijadas (documentadas en código)

- **Base del anticipo:** monto de la oferta aceptada (RN-02: "monto acordado del trabajo"), no `Order.budgetAmount`.
- **Cálculo:** `Prisma.Decimal`; `monto × 0.25`, redondeo **a 2 decimales, mitad hacia arriba** (`ROUND_HALF_UP`); nunca `number`. Ejemplo: `100.02 → 25.01`.
- **Presupuestos adicionales:** no cambian el anticipo (la base es el monto acordado).
- **Saldo esperado:** `acordado + adicionales aceptados − anticipo`. Si el contrato de presupuestos adicionales no está disponible devuelve `PENDIENTE_INTEGRACION` con monto `null`: nunca un saldo incompleto.
- **Declaraciones:** cada parte declara por separado; una no completa a la otra. La comparación (`SOLO_CLIENTE`, `SOLO_TRABAJADOR`, `MONTOS_COINCIDEN`, `MONTOS_DIFERENTES`) es **informativa**; no es conciliación definitiva ni dispara transiciones.

## 2. Contratos públicos necesarios (qué se necesita de quién)

Todos los lectores son **interfaces con token de inyección y sin implementación por defecto**. Si no se registran, la inyección falla; no se inventan valores.

### 2.1 De Persona A / OrdersModule

| # | Contrato | Firma propuesta | Uso |
|---|---|---|---|
| C1 | Transiciones | Reglas en `orders.rules.ts` para `ACORDADO→ANTICIPO_REGISTRADO` y `TERMINADO→CERRADO`, con actor permitido y precondiciones. `OrdersService.transition()` ya es público y tipado. | Avance de estado tras pagos. **No se implementa ninguna transición automática mientras no esté definido quién confirma el anticipo** ni cuándo se cierra. |
| C2 | Participantes | `OrderParticipantsReader.findParticipants(db, orderId): { orderId, clientId, assignedWorkerId, status } \| null` | Permisos de pagos, reseñas y timeline sin leer `orders`. |
| C5 | Visita | Ver §2.4 | Pago de visita sin duplicar registros. |
| C6 | Historial de estados | `TimelineSource` de Orders (`name: 'orders'`) que traduce `OrderStatusHistory` | Timeline. Sin lecturas directas de `order_status_history`. |
| C7 | Fuentes de A | `TimelineSource` de visita, presupuesto adicional, ejecución, cancelación y reclamo | Timeline. |
| C4 | Presupuestos adicionales | `AdditionalBudgetsReader.sumAcceptedAmounts(db, orderId): Decimal` | Saldo esperado. |

### 2.2 De OffersModule (se agregará en integración, sin que yo edite `OffersService`)

| # | Contrato | Firma propuesta | Uso |
|---|---|---|---|
| C3 | Acuerdo | `AcceptedAgreementReader.findAcceptedAgreement(db, orderId): { orderId, workerId, amount, requiresVisit, visitCost } \| null` | Base del anticipo y costo de visita. |
| C6b | Negociación | `TimelineSource` de Offers (`name: 'offers'`) que traduce `OfferEvent` | Timeline. Sin lecturas directas de `offer_events`. |

### 2.3 Lo que expone Persona B

- `PaymentsService` (a crear tras el schema): consulta de pagos y constancias de un pedido; `confirmVisitPayment` (C5); declaraciones de cliente y trabajador.
- `ReviewsService`: calificar, listar, promedio y datos públicos para el perfil del trabajador.
- `TimelineSourceRegistry.register(source)` y la fuente `payments`.
- Nadie escribe las tablas de pagos ni reseñas fuera de estos servicios.

### 2.4 Visita ↔ pago de visita (separación acordada)

- **Persona A** es dueña del evento operativo de la visita (realizada, fecha, notas). **No guarda dinero.**
- **Persona B** es dueña del registro financiero (`Payment` con concepto `VISITA`) y su constancia.
- Propuesta de enlace, para acordar con A:
  - A llama a `PaymentsService.confirmVisitPayment(tx, { orderId, workerId, amount, method: 'EFECTIVO' })` desde su endpoint «Pago confirmado», **dentro de su misma transacción**. No hay un segundo endpoint para el mismo botón.
  - El monto esperado sale de `visitCost` del acuerdo (C3). Visita sin costo o gratis: **no se crea pago** (RF-25 A2).
  - A puede guardar el `paymentId` devuelto como referencia; no duplica monto ni método.
  - Unicidad `@@unique([orderId, concept])` impide un segundo pago de visita.
  - RN-04 fija el método en efectivo: el servicio rechaza `QR` para `VISITA`.

## 3. Reglas de confirmación por concepto (sin forzar requisitos)

| Concepto | Confirmación obligatoria | Declaración del cliente |
|---|---|---|
| VISITA | Trabajador «Pago confirmado» (RN-04, RF-25) | Opcional (RF-42) |
| SALDO | Trabajador «Confirmo que me pagaron» (RN-03, RF-40) | Opcional (RF-42) |
| ANTICIPO | **Pendiente de definición** (CU-39 dice "quién lo confirma" sin completar) | Opcional (RF-42) |

- Se registra cada declaración; **ninguna transición de estado depende de una confirmación no definida** (anticipo).
- No se implementan pagos parciales encadenados. Un monto declarado distinto del esperado se guarda y se informa como diferencia, sin bloquear ni cerrar.

## 4. Propuesta de cambios Prisma

Solo propuesta. Bloque propio al final del schema, con comentarios, para facilitar la fusión con Persona A.

### 4.1 Enums nuevos (míos, sin conflicto)

```prisma
enum PaymentConcept { VISITA ANTICIPO SALDO }
enum PaymentMethod { EFECTIVO QR }
enum PaymentDeclarer { CLIENTE TRABAJADOR }
```

### 4.2 Modelos nuevos

```prisma
/// Un pago de un pedido por concepto. Sin importe propio: el monto lo declaran las partes.
model Payment {
  id        String         @id @default(uuid()) @db.Uuid
  orderId   String         @map("order_id") @db.Uuid
  concept   PaymentConcept
  createdAt DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)

  order        Order                @relation(fields: [orderId], references: [id], onDelete: Restrict)
  declarations PaymentDeclaration[]

  @@unique([orderId, concept])
  @@map("payments")
}

/// Declaracion inmutable de una parte (trigger append-only, como order_status_history).
/// Cada parte declara una sola vez por pago; son afirmaciones independientes.
model PaymentDeclaration {
  id              String          @id @default(uuid()) @db.Uuid
  paymentId       String          @map("payment_id") @db.Uuid
  declaredBy      PaymentDeclarer @map("declared_by")
  userId          String          @map("user_id") @db.Uuid
  method          PaymentMethod
  amount          Decimal         @db.Decimal(10, 2)
  /// Solo referencia: NO es prueba de que el dinero llego (RF-41).
  referenceFileKey String?        @map("reference_file_key") @db.VarChar(255)
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)

  payment Payment @relation(fields: [paymentId], references: [id], onDelete: Restrict)
  user    User    @relation("PaymentDeclarationUser", fields: [userId], references: [id], onDelete: Restrict)

  @@unique([paymentId, declaredBy])
  @@map("payment_declarations")
  // CHECK en la migracion: amount > 0.
}

/// Constancia de servicio (RF-41), inmutable y separada de las de pago.
model ServiceReceipt {
  id           String   @id @default(uuid()) @db.Uuid
  orderId      String   @unique @map("order_id") @db.Uuid
  clientId     String   @map("client_id") @db.Uuid
  workerId     String   @map("worker_id") @db.Uuid
  agreedAmount Decimal  @map("agreed_amount") @db.Decimal(10, 2)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  order  Order @relation(fields: [orderId], references: [id], onDelete: Restrict)
  client User  @relation("ServiceReceiptClient", fields: [clientId], references: [id], onDelete: Restrict)
  worker User  @relation("ServiceReceiptWorker", fields: [workerId], references: [id], onDelete: Restrict)

  @@map("service_receipts")
}

/// Calificacion mutua (RF-44, RF-45). Una por parte y pedido; sin autocalificacion.
model Review {
  id         String   @id @default(uuid()) @db.Uuid
  orderId    String   @map("order_id") @db.Uuid
  authorId   String   @map("author_id") @db.Uuid
  targetId   String   @map("target_id") @db.Uuid
  authorRole RoleName @map("author_role")
  rating     Int      @db.SmallInt
  comment    String?  @db.VarChar(1000)
  /// Moderacion (RF-46 A1): oculta, no se borra.
  hiddenAt   DateTime? @map("hidden_at") @db.Timestamptz(3)
  hiddenById String?  @map("hidden_by_id") @db.Uuid
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  order    Order @relation(fields: [orderId], references: [id], onDelete: Restrict)
  author   User  @relation("ReviewAuthor", fields: [authorId], references: [id], onDelete: Restrict)
  target   User  @relation("ReviewTarget", fields: [targetId], references: [id], onDelete: Restrict)
  hiddenBy User? @relation("ReviewHiddenBy", fields: [hiddenById], references: [id], onDelete: Restrict)

  @@unique([orderId, authorId])
  @@index([targetId, createdAt(sort: Desc)])
  @@map("reviews")
  // CHECK en la migracion: rating BETWEEN 1 AND 5 y author_id <> target_id.
}
```

### 4.3 Relaciones inversas (a coordinar con A, bloque delimitado)

- `Order`: `payments Payment[]`, `serviceReceipt ServiceReceipt?`, `reviews Review[]`.
- `User`: `paymentDeclarations PaymentDeclaration[] @relation("PaymentDeclarationUser")`, `receiptsAsClient`, `receiptsAsWorker`, `reviewsAuthored`, `reviewsReceived`, `reviewsHidden`.
- No cambian columnas existentes. `Order.status` sigue siendo exclusivo de A.

### 4.4 Enums compartidos (a coordinar con A antes de migrar)

- `NotificationType`: propongo que yo agregue `OFERTA_RECIBIDA`, `OFERTA_RESPONDIDA`, `ACUERDO_REGISTRADO`, `PEDIDO_CANCELADO`, `PEDIDO_VENCIDO`, `PAGO_DECLARADO`, `PAGO_CON_DIFERENCIA`, `CALIFICACION_RECIBIDA`. A agrega los suyos (presupuesto adicional, visita, reclamo, cancelación de trabajo).
- `NotificationResourceType`: yo agrego `PEDIDO` y `PAGO`; A agrega `RECLAMO` si lo necesita.
- Solo se agregan valores al final, en una migración propia de cada persona, para que la integración sea una unión mecánica de `ADD VALUE`.

### 4.5 Migración (borrador)

- Un solo directorio de migración con nombre descriptivo, generado con Prisma Migrate en una BD local propia.
- Triggers de inmutabilidad (patrón de `order_status_history`) en `payment_declarations` y `service_receipts`: solo inserción.
- CHECK de `amount > 0`, de `rating BETWEEN 1 AND 5` y de `author_id <> target_id`.
- No modifica migraciones existentes.

## 5. Eventos de notificación que se necesitan de Offers y Orders (no se modifican)

Notificación interna; se guarda con `NotificationsService.create(userId, notification, tx)` dentro de la transacción del evento. Especificación v1.0 §6.1 y RF-33.

| Evento | Dónde ocurre | Destinatario | Cómo se obtendría |
|---|---|---|---|
| Nueva oferta | `OffersService.create` | Cliente del pedido | Llamada a agregar en integración |
| Nueva respuesta de negociación (contraoferta) | `OffersService.counter` | La otra parte | Ídem |
| Oferta aceptada / acuerdo | `OffersService.accept` | Trabajador | Ídem |
| Oferta rechazada o retirada | `OffersService.close*` | Contraparte | Ídem |
| Pedido cancelado | `OrdersService.cancel` → evento `CANCELADO` | Trabajadores con ofertas / participantes | Hook en `OrderLifecycleRegistry.inTransaction`, sin `lockWorker` |
| Pedido vencido | Evento `VENCIDO` | Cliente y oferentes | Ídem |
| Presupuesto adicional | Módulo de A | Cliente | A, con el mismo servicio |
| Pago declarado / con diferencia | `PaymentsService` | Contraparte (y administradores si hay diferencia) | Mío |
| Calificación recibida | `ReviewsService` | Calificado | Mío |

Decisión pendiente de la matriz (§7.4 de la especificación): contenido mínimo y tratamiento de notificaciones administrativas. No se cierra aquí.

## 6. Pendiente de integración (no simulado)

- Avance de estado tras anticipo y saldo (C1) y definición de quién confirma el anticipo.
- Monto esperado del anticipo y de la visita (C3).
- Saldo esperado con presupuestos adicionales (C4).
- Pago de visita desde el flujo de A (C5).
- Permisos por pedido en pagos, reseñas y timeline (C2); hasta entonces solo tests con lectores falsos.
- Timeline completo: fuentes de Orders, Offers y A (C6, C7).
- Notificaciones de oferta/acuerdo en Offers (§5).
- Elegibilidad de reseñas: estados habilitantes **sin definir**; el módulo exige elegirlos explícitamente.
- Perfil público del trabajador (RF-46): respuesta con campos explícitos y solo perfiles `APROBADO`; depende de reseñas y de `WorkerProfileService`.
- Registro en `app.module.ts` (lo hace el integrador): `PaymentsModule`, `ReviewsModule`, `TimelineModule`.

## 7. Preguntas de negocio que siguen abiertas

1. ¿Quién confirma la recepción del anticipo? (bloquea cualquier transición automática a `ANTICIPO_REGISTRADO`)
2. Pago parcial del saldo (RF-40 A2, "[Por confirmar]"): no se implementa más allá de registrar el monto declarado y mostrar la diferencia.
3. ¿Qué estados habilitan calificar (`TERMINADO`, `CERRADO`, saldo confirmado)? Aislado en `ReviewEligibilityPolicy`.
4. Redondeo del anticipo: se usa mitad hacia arriba a 2 decimales (decisión técnica; basta cambiar `MONEY_ROUNDING`).
