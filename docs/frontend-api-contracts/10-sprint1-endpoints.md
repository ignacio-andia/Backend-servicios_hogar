# 10. Flujo del trabajo, reclamos, pagos, calificaciones, agenda y seguimiento

Contratos de los **34 endpoints** del Sprint 1 (#82 a #115). Los #113–#115
(rechazo del adicional, búsqueda y reportes) están al final. ServiceWorkflow
(10), Claims (7), Payments (4), Reviews (7), Agenda (2) y Timeline (1). Se
obtuvieron leyendo controllers, DTOs, services y vistas del código. Rigen las
convenciones generales del [README](README.md) y los códigos comunes de
[01](01-endpoints-inventory.md) (400, 401, 403, 500).

## Reglas comunes de este grupo

- Un pedido o recurso **ajeno** responde **404**, como si no existiera. Un rol
  sin acceso a la ruta responde **403**. Una cuenta con varios roles pasa la
  guarda de rol y, si no es parte del pedido, recibe 404. Una cuenta solo
  `ADMINISTRADOR` recibe 403 en las rutas de cliente y trabajador.
- Una acción repetida o en un estado que no corresponde responde **409**.
- **Trab. aprobado** = rol `TRABAJADOR` y perfil `APROBADO` con la cuenta
  `ACTIVO` (`ApprovedWorkerGuard`). Una solicitud de cambio de zona pendiente
  **no** afecta a #83–#87 ni a #101: son trabajos ya acordados (ver
  [05](05-auth-and-permissions.md#cambio-de-zona-pendiente-rf-13)).
- Montos: texto decimal con 2 decimales en las respuestas. En las peticiones se
  envían como texto (también se acepta un número JSON).
- Fechas: ISO 8601 en UTC.

## ServiceWorkflow (`/api/orders/:orderId`)

| #   | Método | Ruta                                                       | Acceso                              | Entrada                     | Respuesta                 | Éxito |
| --- | ------ | ---------------------------------------------------------- | ----------------------------------- | --------------------------- | ------------------------- | ----- |
| 82  | GET    | `/api/orders/:orderId/workflow`                            | cliente dueño o trabajador asignado | —                           | `WorkflowView`            | 200   |
| 83  | POST   | `/api/orders/:orderId/visit`                               | trab. aprobado asignado             | sin cuerpo                  | `{ status, visit }`       | 201   |
| 84  | POST   | `/api/orders/:orderId/visit/payment-confirmation`          | trab. aprobado asignado             | sin cuerpo                  | `{ visit }`               | 200   |
| 85  | POST   | `/api/orders/:orderId/start`                               | trab. aprobado asignado             | sin cuerpo                  | `{ status, execution }`   | 200   |
| 86  | POST   | `/api/orders/:orderId/additional-budgets`                  | trab. aprobado asignado             | `CreateAdditionalBudgetDto` | `{ status, budget }`      | 201   |
| 87  | POST   | `/api/orders/:orderId/finish`                              | trab. aprobado asignado             | sin cuerpo                  | `{ status, execution }`   | 200   |
| 88  | POST   | `/api/orders/:orderId/additional-budgets/:budgetId/accept` | `CLIENTE` dueño                     | sin cuerpo                  | `{ status, budget }`      | 200   |
| 89  | POST   | `/api/orders/:orderId/confirm-conformity`                  | `CLIENTE` dueño                     | sin cuerpo                  | `{ status, execution }`   | 200   |
| 90  | POST   | `/api/orders/:orderId/cancel-work`                         | `CLIENTE` dueño                     | `CancelWorkDto`             | `OwnerOrderView` (ver 03) | 200   |
| 91  | POST   | `/api/orders/:orderId/no-show`                             | `CLIENTE` dueño                     | `ReportNoShowDto`           | `{ created, report }`     | 200   |

`status` es el `OrderStatus` resultante.

### Entradas

| DTO                         | Propiedad     | Tipo            | Omitir / null                                  | Restricciones                                  |
| --------------------------- | ------------- | --------------- | ---------------------------------------------- | ---------------------------------------------- |
| `CreateAdditionalBudgetDto` | `amount`      | string o número | Obligatoria                                    | hasta 8 enteros y 2 decimales, **mayor que 0** |
|                             | `reason`      | string          | Obligatoria                                    | 1 a 1000 (recortado)                           |
|                             | `materials`   | string          | Obligatoria                                    | 1 a 1000 (recortado)                           |
| `CancelWorkDto`             | `reason`      | string          | Obligatoria                                    | 1 a 500 (recortado)                            |
| `ReportNoShowDto`           | `description` | string          | Omitible, admite null; `""` equivale a ausente | ≤ 1000                                         |

### Condiciones y errores

| #   | Estado requerido                                                                        | Errores de negocio                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 82  | cualquiera                                                                              | 404 `"El pedido no existe"`                                                                                                                                                                                         |
| 83  | `ANTICIPO_REGISTRADO` y oferta con visita                                               | 409 estado; 409 `"La oferta acordada no requiere visita (cotización por fotos)."`                                                                                                                                   |
| 84  | visita registrada con costo mayor que 0 (también con el pedido `CANCELADO` o `CERRADO`) | 409 `"Todavía no se registró la visita."`, `"La visita no tiene costo: no hay cobro que confirmar."`. Registra el pago en Payments (efectivo, monto acordado). **Idempotente**: repetirla responde 200 sin duplicar |
| 85  | `VISITA_REALIZADA`, o `ANTICIPO_REGISTRADO` si la oferta no requiere visita             | 409 `"La oferta requiere visita: registre primero la visita."`                                                                                                                                                      |
| 86  | `VISITA_REALIZADA` o `EN_EJECUCION`                                                     | 400 `"El monto adicional debe ser mayor a cero."`; 409 si ya hay uno pendiente o por estado                                                                                                                         |
| 87  | `EN_EJECUCION`                                                                          | 409. Fija `finishedAt` y `conformityDeadline` (7 × 24 h)                                                                                                                                                            |
| 88  | `PRESUPUESTO_ADICIONAL_PENDIENTE`                                                       | 404 `"El presupuesto adicional no existe"`; 409 `"El presupuesto adicional ya fue respondido."` o quedó sin efecto por cancelación. Pasa a `EN_EJECUCION`                                                           |
| 89  | `TERMINADO`                                                                             | 409. Pasa a `CERRADO`                                                                                                                                                                                               |
| 90  | `ACORDADO` hasta `PRESUPUESTO_ADICIONAL_PENDIENTE` o `EN_EJECUCION` (no terminado)      | 409 `"El trabajo ya terminó: no se puede cancelar. Use el reclamo (RF-37)."` u otro estado. No decide nada sobre el anticipo                                                                                        |
| 91  | `ACORDADO` o `ANTICIPO_REGISTRADO`                                                      | 409. Un reporte por pedido: si ya existe responde `created: false` con el existente. No cambia el estado ni penaliza                                                                                                |

El presupuesto adicional se rechaza con #113. **No existe** su contraoferta
(CU-27 A1, sin definir).

### Modelos

| Modelo                 | Campos                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowView`         | `orderId`, `status`, `visit: VisitView \| null`, `additionalBudgets: AdditionalBudgetView[]`, `execution: ExecutionView \| null`, `noShowReport: NoShowView \| null` |
| `VisitView`            | `orderId`, `performedAt`, `visitCost: string \| null`                                                                                                                |
| `AdditionalBudgetView` | `id`, `orderId`, `amount`, `reason`, `materials`, `status: AdditionalBudgetStatus`, `respondedAt \| null`, `createdAt`                                               |
| `ExecutionView`        | `orderId`, `startedAt`, `finishedAt`, `conformityDeadline`, `conformedAt` (las cuatro fechas admiten null)                                                           |
| `NoShowView`           | `id`, `orderId`, `description \| null`, `reportedAt`                                                                                                                 |

## Claims (reclamos)

| #   | Método | Ruta                                   | Acceso                                | Entrada                                              | Respuesta                                             | Éxito |
| --- | ------ | -------------------------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- | ----- |
| 92  | POST   | `/api/orders/:orderId/claims`          | `CLIENTE` dueño                       | multipart: `description`, `images[]`                 | `ClaimView`                                           | 201   |
| 93  | GET    | `/api/orders/:orderId/claim`           | cliente dueño o trabajador asignado   | —                                                    | `ClaimView` (cliente) o `ClaimPartyView` (trabajador) | 200   |
| 94  | GET    | `/api/claims/:claimId/images/:imageId` | cliente que reclamó o `ADMINISTRADOR` | query `variant` = `full` (por defecto) o `thumb`     | binario `image/webp`                                  | 200   |
| 95  | GET    | `/api/admin/claims`                    | `ADMINISTRADOR`                       | query `status?`, `page?` (1), `limit?` (20, máx. 50) | `Paginated<ClaimSummary>`, más antiguos primero       | 200   |
| 96  | GET    | `/api/admin/claims/:claimId`           | `ADMINISTRADOR`                       | —                                                    | `ClaimView`                                           | 200   |
| 97  | POST   | `/api/admin/claims/:claimId/review`    | `ADMINISTRADOR`                       | sin cuerpo                                           | `ClaimView`                                           | 200   |
| 98  | POST   | `/api/admin/claims/:claimId/decision`  | `ADMINISTRADOR`                       | `DecideClaimDto`                                     | `ClaimView`                                           | 200   |

### Entradas

| DTO              | Propiedad           | Omitir / null        | Restricciones                                                                                                                    |
| ---------------- | ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CreateClaimDto` | `description`       | Obligatoria          | 1 a 2000 (recortada)                                                                                                             |
|                  | `images` (archivos) | Opcional por defecto | entre `CLAIM_MIN_IMAGES` (0) y `CLAIM_MAX_IMAGES` (20); JPEG, PNG o WebP por contenido; peso máximo `ORDER_IMAGE_MAX_MB` (10 MB) |
| `DecideClaimDto` | `decision`          | Obligatoria          | 1 a 2000                                                                                                                         |
|                  | `justification`     | Obligatoria          | 1 a 2000                                                                                                                         |

### Errores

| #   | Errores de negocio                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 92  | 400 cantidad de fotos o archivo no válido; 404 `"El pedido no existe"`; 409 `"El pedido ya tiene un reclamo."`, pedido no `TERMINADO`, o `"El plazo de 7 días para presentar un reclamo ya venció."`; 413 foto demasiado pesada. Pasa el pedido a `EN_RECLAMO` |
| 93  | 404 `"El pedido no tiene un reclamo"` (también si no participa). El trabajador recibe `decision`, `justification` y `decidedAt` solo con el reclamo `RESUELTO`; nunca la descripción ni las fotos                                                              |
| 94  | 404 `"La fotografía no existe"` (también si no tiene permiso). Cabeceras `Cache-Control: private, no-store` y `X-Content-Type-Options: nosniff`                                                                                                                |
| 96  | 404 `"El reclamo no existe"`. El historial del pedido está en `GET /api/orders/admin/:orderId` (#68) y las constancias en #100                                                                                                                                 |
| 97  | 404; 409 si el reclamo no está `ABIERTO` o el pedido ya no está en reclamo. Pasa a `EN_REVISION`                                                                                                                                                               |
| 98  | 404; 409 si ya fue resuelto (como el pedido ya está `CERRADO`, el mensaje es que ya no está en reclamo). Deja el reclamo `RESUELTO` y el pedido `CERRADO`. Solo registra texto: sin sanciones ni efectos económicos                                            |

### Modelos

| Modelo           | Campos                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClaimView`      | `id`, `orderId`, `status: ClaimStatus`, `description`, `images: ClaimImageView[]`, `decision \| null`, `justification \| null`, `decidedAt \| null`, `createdAt` |
| `ClaimImageView` | `id`, `position`, `mimeType`, `width`, `height`, `sizeBytes`                                                                                                     |
| `ClaimPartyView` | `id`, `orderId`, `status`, `decision \| null`, `justification \| null`, `decidedAt \| null`                                                                      |
| `ClaimSummary`   | `id`, `orderId`, `status`, `imageCount`, `createdAt`                                                                                                             |

## Payments (pagos y constancias)

La plataforma **no procesa dinero**: solo registra declaraciones de las partes.

| #   | Método | Ruta                                                  | Acceso                                               | Entrada                                    | Respuesta                          | Éxito |
| --- | ------ | ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ | ---------------------------------- | ----- |
| 99  | GET    | `/api/orders/:orderId/payments`                       | cliente dueño, trabajador asignado o `ADMINISTRADOR` | —                                          | `PaymentsOverview`                 | 200   |
| 100 | GET    | `/api/orders/:orderId/receipts`                       | igual que #99                                        | —                                          | `ReceiptsView`                     | 200   |
| 101 | POST   | `/api/orders/:orderId/payments/:concept/declarations` | cliente dueño o trabajador asignado                  | `DeclarePaymentDto`                        | `DeclarationResult`                | 201   |
| 102 | GET    | `/api/admin/payments/differences`                     | `ADMINISTRADOR`                                      | query `page?` (1), `limit?` (20, máx. 100) | `Paginated<PaymentDifferenceView>` | 200   |

`:concept` = `VISITA`, `ANTICIPO` o `SALDO` (otro valor: 400).

`DeclarePaymentDto`: `amount` (texto o número, mayor que 0, hasta 8 enteros y 2
decimales) y `method` (`EFECTIVO` o `QR`), ambos obligatorios. La parte (cliente
o trabajador) sale del token y del pedido.

### Reglas de #101

| Concepto   | Estados del pedido admitidos                                                                          | Método        |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------- |
| `ANTICIPO` | `ACORDADO` y todos los posteriores, hasta `CERRADO`                                                   | efectivo o QR |
| `VISITA`   | desde `VISITA_REALIZADA` hasta `CERRADO`, y `CANCELADO`, siempre con la visita registrada y con costo | solo efectivo |
| `SALDO`    | `TERMINADO`, `EN_RECLAMO`, `CERRADO`                                                                  | efectivo o QR |

- **Anticipo:** lo confirma **exclusivamente el trabajador asignado**. Su
  declaración debe ser por el monto esperado (25 % del monto de la oferta
  aceptada); entonces el pedido pasa de `ACORDADO` a `ANTICIPO_REGISTRADO` y
  responde `orderTransition: "ANTICIPO_REGISTRADO"`. La declaración del cliente
  se registra y responde `"NO_APLICA"`: nunca avanza el pedido.
- Repetir la misma confirmación (mismo monto y método) es **idempotente**: 201
  con lo ya registrado. Cualquier otra repetición: 409.
- El trabajador **no** declara la visita aquí: usa #84.
- Errores: 400 método no permitido; 403 trabajador no aprobado; 404 pedido ajeno;
  409 estado, `"El pedido no tiene una oferta aceptada."`, `"El acuerdo no tiene
una visita con costo."`, `"Todavía no se registró la visita."`, `"El monto no
corresponde al anticipo esperado (Bs 30.13)."` o `"Ya declaró este pago. Una
declaración no se edita ni se repite."`.

### Modelos

| Modelo                  | Campos                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PaymentsOverview`      | `orderId`, `orderStatus`, `notice`, `agreement: { baseAmount, acceptedAdditional, totalAmount } \| null`, `advanceTransition: "ACTIVA"`, `payments: PaymentView[]`, `balance: BalanceView`                                                                                  |
| `PaymentView`           | `concept`, `paymentId \| null`, `expectedAmount \| null` (null en el saldo), `requiredConfirmation: "TRABAJADOR"`, `declarations: DeclarationView[]`, `comparison`, `difference \| null`, `methodsMatch \| null`                                                            |
| `DeclarationView`       | `id`, `declaredBy`, `userId`, `method`, `amount`, `createdAt`                                                                                                                                                                                                               |
| `BalanceView`           | `status: "CALCULADO" \| "PENDIENTE_INTEGRACION" \| "NO_APLICA"` (`NO_APLICA`: cerrado por rechazo de un adicional, #113; no hay saldo) (este último hoy cuando no hay oferta aceptada), `amount \| null`, `advanceAmount \| null`, `additionalBudgetsTotal \| null`, `note` |
| `DeclarationResult`     | `notice`, `payment: PaymentView`, `orderTransition: "ANTICIPO_REGISTRADO" \| "NO_APLICA"`                                                                                                                                                                                   |
| `ReceiptsView`          | `orderId`, `notice`, `referenceNotice`, `service: { clientId, workerId, agreedAmount, issuedAt } \| null`, `payments: { concept, paymentId, declaration }[]`                                                                                                                |
| `PaymentDifferenceView` | `paymentId`, `orderId`, `concept`, `clientAmount`, `workerAmount`, `difference` (trabajador − cliente), `createdAt`                                                                                                                                                         |

`comparison`: `SIN_DECLARACIONES`, `SOLO_CLIENTE`, `SOLO_TRABAJADOR`,
`MONTOS_COINCIDEN`, `MONTOS_DIFERENTES` (informativa).

## Reviews (calificaciones y perfil público)

| #   | Método | Ruta                                    | Acceso                              | Entrada                 | Respuesta                               | Éxito |
| --- | ------ | --------------------------------------- | ----------------------------------- | ----------------------- | --------------------------------------- | ----- |
| 103 | POST   | `/api/orders/:orderId/reviews`          | cliente dueño o trabajador asignado | `CreateReviewDto`       | `ReviewView`                            | 201   |
| 104 | GET    | `/api/orders/:orderId/reviews/mine`     | igual que #103                      | —                       | `MyReviewStatus`                        | 200   |
| 105 | GET    | `/api/reviews/received`                 | `CLIENTE` o `TRABAJADOR`            | query `page?`, `limit?` | `Paginated<ReviewView>` (solo visibles) | 200   |
| 106 | GET    | `/api/workers/:workerId/public-profile` | **público**                         | —                       | `PublicWorkerProfileView`               | 200   |
| 107 | GET    | `/api/workers/:workerId/reviews`        | **público**                         | query `page?`, `limit?` | `Paginated<PublicOpinionView>`          | 200   |
| 108 | GET    | `/api/admin/reviews`                    | `ADMINISTRADOR`                     | query `page?`, `limit?` | `Paginated<AdminReviewView>`            | 200   |
| 109 | PATCH  | `/api/admin/reviews/:reviewId/hide`     | `ADMINISTRADOR`                     | sin cuerpo              | `AdminReviewView`                       | 200   |

- `page` ≥ 1 (1); `limit` de 1 a 50 (10).
- `CreateReviewDto`: `rating` entero de 1 a 5 (número, obligatorio); `comment`
  opcional, ≤ 1000, `""` equivale a ausente.
- Los estados que habilitan calificar salen de `REVIEWS_ELIGIBLE_STATUSES`.
  **Sin esa variable las calificaciones están deshabilitadas**: #103 responde 409
  `"Las calificaciones todavía no están habilitadas."`.
- Errores: #103 y #104 404 `"El pedido no existe"`; #103 409 estado no
  habilitado, `"El pedido no tiene otra parte a la que calificar."` o `"Ya
calificó este pedido."`; #106 y #107 404 `"El trabajador no existe"` si no es
  un trabajador aprobado y activo; #109 404 `"La calificación no existe"` (ocultar
  una ya oculta es idempotente).

| Modelo                    | Campos                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReviewView`              | `id`, `orderId`, `authorRole`, `rating`, `comment \| null`, `createdAt`, `hidden`                                                                                                                                            |
| `MyReviewStatus`          | `orderId`, `canReview`, `reason \| null`, `alreadyReviewed`, `review: ReviewView \| null`                                                                                                                                    |
| `PublicWorkerProfileView` | `profile: { workerId, firstName, lastName, yearsOfExperience, description \| null, zone: CatalogRef \| null, specialties: CatalogRef[] }`, `rating: { average \| null, count, message \| null }`, `recentOpinions` (hasta 5) |
| `PublicOpinionView`       | `id`, `rating`, `comment \| null`, `createdAt`, `author` (nombre e inicial, p. ej. `"María P."`)                                                                                                                             |
| `AdminReviewView`         | `ReviewView` más `authorId`, `targetId`, `hiddenAt \| null`, `hiddenById \| null`                                                                                                                                            |

El perfil público solo promedia y muestra opiniones **de clientes** no ocultas.

## Agenda (`/api/agenda`)

| #   | Método | Ruta                   | Acceso         | Entrada                | Respuesta            | Éxito |
| --- | ------ | ---------------------- | -------------- | ---------------------- | -------------------- | ----- |
| 110 | GET    | `/api/agenda/me`       | trab. aprobado | —                      | `AgendaView`         | 200   |
| 111 | POST   | `/api/agenda/me/check` | trab. aprobado | `CheckAvailabilityDto` | `AvailabilityResult` | 200   |

`CheckAvailabilityDto`: `startAt` ISO 8601 **con zona horaria explícita**
(obligatoria) y `durationMinutes` entero de 1 a 43200 (obligatoria).

| Modelo               | Campos                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AgendaView`         | `timeZone`, `schedules: ScheduleView[]` (horario semanal; se edita con #27), `jobs: AgendaJob[]`                                   |
| `AgendaJob`          | `orderId`, `orderStatus`, `startAt`, `endAt`, `durationMinutes`                                                                    |
| `AvailabilityResult` | `startAt`, `endAt`, `available` (sin cruces), `conflicts: AgendaJob[]`, `withinSchedule` (informativo, no bloquea), `note \| null` |

Solo lectura: no reserva nada ni cambia las reglas de aceptación de ofertas.

## Timeline (seguimiento)

| #   | Método | Ruta                            | Acceso                                               | Entrada                                            | Respuesta      | Éxito |
| --- | ------ | ------------------------------- | ---------------------------------------------------- | -------------------------------------------------- | -------------- | ----- |
| 112 | GET    | `/api/orders/:orderId/timeline` | cliente dueño, trabajador asignado o `ADMINISTRADOR` | query `limit?` (50, de 1 a 100), `cursor?` (≤ 500) | `TimelinePage` | 200   |

Errores: 400 `"El cursor de la línea de tiempo no es válido."`; 404 `"Pedido no
encontrado"`.

| Modelo          | Campos                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| `TimelinePage`  | `data: TimelineEvent[]` (del más antiguo al más reciente), `nextCursor \| null`      |
| `TimelineEvent` | `id`, `source`, `type`, `at`, `actor`, `summary`, `details?`                         |
| `actor`         | `{ type: "USUARIO", userId \| null, role \| null }` o `{ type: "SISTEMA", process }` |

| `source`   | `type`                                                         | `details`                                                                                                                  |
| ---------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `orders`   | `PEDIDO_<OrderStatus>` (sin las entradas y salidas de reclamo) | `fromStatus`, `toStatus`, `reason`                                                                                         |
| `claims`   | `RECLAMO_PRESENTADO`, `RECLAMO_RESUELTO`                       | —                                                                                                                          |
| `offers`   | `OFERTA_<OfferEventType>`. El trabajador ve solo las suyas     | `offerId`, `round`, `amount`, `workerId`, `clientId`; en la aceptación además `agreedAmount`, `requiresVisit`, `visitCost` |
| `workflow` | `VISITA_COSTO`                                                 | `visitCost`                                                                                                                |
| `workflow` | `ADICIONAL_PROPUESTO` / `ADICIONAL_ACEPTADO`                   | `budgetId`, `amount` (la propuesta también `reason`, `materials`)                                                          |
| `workflow` | `PLAZO_CONFORMIDAD`, `CONFORMIDAD_CONFIRMADA`                  | `deadline` en el plazo                                                                                                     |
| `workflow` | `INASISTENCIA_REPORTADA`                                       | `description`                                                                                                              |
| `payments` | `CONSTANCIA_SERVICIO`                                          | `agreedAmount`                                                                                                             |
| `payments` | `PAGO_<concepto>_<CLIENTE\|TRABAJADOR>`                        | `concept`, `method`, `amount`                                                                                              |

No incluye dirección, contactos ni ubicación en vivo.

## Rechazo del adicional, búsqueda y reportes (#113–#115)

| #   | Método | Ruta                                                       | Acceso          | Entrada                                         | Respuesta              | Éxito |
| --- | ------ | ---------------------------------------------------------- | --------------- | ----------------------------------------------- | ---------------------- | ----- |
| 113 | POST   | `/api/orders/:orderId/additional-budgets/:budgetId/reject` | `CLIENTE` dueño | `RejectAdditionalBudgetDto`                     | `{ status, budget }`   | 200   |
| 114 | GET    | `/api/workers/search`                                      | `CLIENTE`       | query `categoryId`, `zoneId`, `page?`, `limit?` | `WorkerSearchPage`     | 200   |
| 115 | GET    | `/api/admin/reports/:type`                                 | `ADMINISTRADOR` | query `from`, `to`, `format?`                   | `Report` o archivo CSV | 200   |

### #113 Rechazar un presupuesto adicional (RF-27)

- `reason`: opcional, hasta 400 caracteres; `""` equivale a ausente.
- Requiere el pedido en `PRESUPUESTO_ADICIONAL_PENDIENTE`. El adicional queda
  `RECHAZADO` y el pedido **`CERRADO`**, con el motivo en su historial
  (`"Presupuesto adicional rechazado: …"`); se avisa al trabajador.
- Después solo queda el cobro de la visita (#84, #101 `VISITA`). El saldo
  responde 409, #99 informa `balance.status: "NO_APLICA"` y no se puede
  calificar (el trabajo no terminó).
- Errores: 400 motivo; 404 pedido ajeno o `"El presupuesto adicional no
existe"`; 409 estado o ya respondido.

### #114 Buscar trabajadores (RF-16)

`categoryId` y `zoneId` (UUID, obligatorios); `limit` de 1 a 50 (10). Solo
trabajadores aprobados, con cuenta activa, sin cambio de zona pendiente y que no
sean el propio cliente. Categoría o zona inactiva: lista vacía; inexistente: 404.

`WorkerSearchPage`: `data`, `meta`, `message` (aviso cuando no hay resultados,
si no `null`). Cada elemento: `workerId`, `firstName`, `lastName`,
`yearsOfExperience`, `description`, `zone`, `specialties`, `schedules`
(`{ dayOfWeek, startTime, endTime }`, no son reservas) y
`rating: { average, count }`. Sin teléfono ni correo.

### #115 Reportes (RF-52)

`:type` = `pedidos`, `trabajadores`, `calificaciones`, `cancelaciones` o
`reclamos`. `from` y `to` (`AAAA-MM-DD`, obligatorios) incluyen ambos días en
hora de Bolivia. `format`: `json` (por defecto) o `csv`.

`Report`: `report`, `from`, `to`, `basis` (qué fecha se usa), `columns`,
`rows` (la última columna es `total`), `total` y `message` (sin datos en el
rango).

| `:type`          | Columnas antes de `total`                              | Fecha que cuenta    |
| ---------------- | ------------------------------------------------------ | ------------------- |
| `pedidos`        | categoria, zona, estado (almacenado)                   | publicación         |
| `trabajadores`   | zona, estado actual                                    | creación del perfil |
| `calificaciones` | autor, estrellas, visible                              | calificación        |
| `cancelaciones`  | categoria, zona, estado_anterior                       | cancelación         |
| `reclamos`       | categoria, zona, estado actual (incluye la resolución) | presentación        |

Errores: 400 tipo, formato o rango no válido; 401; 403 si no es administrador.
