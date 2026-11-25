# ServiceWorkflowModule (Persona A)

Ciclo de vida del trabajo: visita, presupuesto adicional, ejecución,
conformidad, cancelación e inasistencia (RF-25 a RF-28, RF-34, RF-36).
Los reclamos (RF-37, RF-38) están en `ClaimsModule`.

Todos los cambios de estado pasan por `OrdersService.transition()` (o
`cancelAgreedWork()`); nunca se escribe `Order.status` directamente. El
historial es `OrderStatusHistory`. Rutas bajo el prefijo global `/api`.

## Matriz de transiciones (`orders.rules.ts`)

| Origen                                 | Destino                         | Quién / operación                                                     |
| -------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| ACORDADO                               | ANTICIPO_REGISTRADO             | trabajador asignado, al confirmar el anticipo (PaymentsModule, RF-39) |
| ANTICIPO_REGISTRADO                    | VISITA_REALIZADA                | trabajador, `POST visit` (oferta con visita)                          |
| ANTICIPO_REGISTRADO, VISITA_REALIZADA  | EN_EJECUCION                    | trabajador, `POST start`                                              |
| VISITA_REALIZADA, EN_EJECUCION         | PRESUPUESTO_ADICIONAL_PENDIENTE | trabajador, `POST additional-budgets`                                 |
| PRESUPUESTO_ADICIONAL_PENDIENTE        | EN_EJECUCION                    | cliente acepta                                                        |
| EN_EJECUCION                           | TERMINADO                       | trabajador, `POST finish`                                             |
| TERMINADO                              | CERRADO                         | cliente `confirm-conformity`, o cierre automático al vencer el plazo  |
| TERMINADO                              | EN_RECLAMO                      | cliente presenta reclamo (`ClaimsModule`)                             |
| EN_RECLAMO                             | CERRADO                         | administrador registra la decisión                                    |
| ACORDADO … EN_EJECUCION (no TERMINADO) | CANCELADO                       | cliente, `POST cancel-work`                                           |
| PRESUPUESTO_ADICIONAL_PENDIENTE        | CERRADO                         | cliente rechaza el adicional (RF-27)                                  |

El rechazo (RF-27) detiene el trabajo y cierra el pedido: solo queda pendiente
el cobro de la visita, no hay saldo ni calificación. La contraoferta del
adicional (CU-27 A1) no está definida.

El cobro de una visita ya realizada también se confirma con el pedido
`CANCELADO`.

## Invariantes que ningún módulo puede saltarse

`OrderLifecycleRegistry` tiene un hook nuevo, `beforeTransition(attempt, tx)`,
que `OrdersService.transition()` ejecuta dentro de su transacción, con el pedido
bloqueado y antes de aplicar el cambio (409 si no se cumple). Este módulo
(`WorkflowInvariantHooks`) y `ClaimsModule` (`ClaimsInvariantHooks`) registran
sus invariantes; los módulos que llaman a `transition()` (por ejemplo pagos) no
tienen que hacer nada, pero **no pueden** producir estados incoherentes:

| Destino                                         | Exige                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VISITA_REALIZADA                                | oferta con visita y visita registrada                                                                                                                   |
| EN_EJECUCION                                    | desde ANTICIPO_REGISTRADO: oferta SIN visita; desde VISITA_REALIZADA: visita registrada; desde PRESUPUESTO_ADICIONAL_PENDIENTE: adicional ya respondido |
| PRESUPUESTO_ADICIONAL_PENDIENTE                 | exactamente un adicional PENDIENTE                                                                                                                      |
| TERMINADO                                       | registro de ejecución con fin y plazo, sin adicional pendiente, y que lo declare el trabajador asignado                                                 |
| CERRADO (desde TERMINADO)                       | trabajo terminado y, además, la conformidad del cliente dueño o el cierre automático con el plazo vencido                                               |
| CERRADO (desde PRESUPUESTO_ADICIONAL_PENDIENTE) | un adicional RECHAZADO, ninguno pendiente, y que lo declare el cliente dueño                                                                            |
| EN_RECLAMO                                      | reclamo ABIERTO (`ClaimsModule`)                                                                                                                        |
| CERRADO (desde EN_RECLAMO)                      | reclamo RESUELTO con decisión (`ClaimsModule`)                                                                                                          |

`ACORDADO` exige además la oferta `ACEPTADA` del trabajador asignado: lo
comprueba `OrdersService.transition()` mediante `AcceptedOfferRegistry` (lo
implementa OffersModule). Sin verificador registrado, no se asigna.

Contrato de pagos: `ACORDADO → ANTICIPO_REGISTRADO` lo restringe
`OrdersService.transition()`: solo el trabajador asignado, con su
confirmación del anticipo registrada en PaymentsModule. Los
módulos de flujo escriben su registro **antes** de llamar a `transition()`.

## Presupuesto adicional: estados

`PENDIENTE` (esperando al cliente), `ACEPTADO`, `RECHAZADO` (el cliente lo
rechazó: RF-27) y **`SIN_EFECTO_POR_CANCELACION`**:
estado terminal que un hook del evento `CANCELADO` aplica a un adicional que
seguía pendiente cuando el cliente canceló el trabajo. No fue aceptado ni
rechazado (`respondedAt` queda vacío), ya no puede aceptarse (409) y no suma al
monto acordado. Un trigger de la BD (`additional_budgets_guard`) impide cambiar
el estado de un adicional que ya no está PENDIENTE.

## Endpoints

| Método y ruta                                               | Rol                                 | Respuesta                                                                  |
| ----------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `GET /orders/:orderId/workflow`                             | cliente dueño o trabajador asignado | `{ orderId, status, visit, additionalBudgets[], execution, noShowReport }` |
| `POST /orders/:orderId/visit`                               | trabajador asignado aprobado        | 201 `{ status, visit }`                                                    |
| `POST /orders/:orderId/visit/payment-confirmation`          | trabajador asignado                 | 200 `{ visit }`; registra el cobro en PaymentsModule (idempotente)         |
| `POST /orders/:orderId/start`                               | trabajador asignado                 | 200 `{ status, execution }`                                                |
| `POST /orders/:orderId/additional-budgets`                  | trabajador asignado                 | 201 `{ status, budget }`; body `{ amount, reason, materials }`             |
| `POST /orders/:orderId/additional-budgets/:budgetId/accept` | cliente dueño                       | 200 `{ status, budget }`                                                   |
| `POST /orders/:orderId/additional-budgets/:budgetId/reject` | cliente dueño                       | 200 `{ status, budget }`; body `{ reason? }`; el pedido queda `CERRADO`    |
| `POST /orders/:orderId/finish`                              | trabajador asignado                 | 200 `{ status, execution }` con `conformityDeadline`                       |
| `POST /orders/:orderId/confirm-conformity`                  | cliente dueño                       | 200 `{ status, execution }`                                                |
| `POST /orders/:orderId/cancel-work`                         | cliente dueño                       | 200 vista del pedido; body `{ reason }` (obligatorio)                      |
| `POST /orders/:orderId/no-show`                             | cliente dueño                       | 200 `{ created, report }`; body `{ description? }`                         |

- Un pedido ajeno, o una acción de quien no es parte, responde **404**; un rol
  sin acceso a la ruta, **403**; estado de origen inválido o repetición
  (doble clic), **409** sin efectos duplicados; datos inválidos, **400**.
- `amount` es texto decimal positivo con hasta 2 decimales (`"50.00"`).
- Ninguna respuesta incluye dirección, teléfono ni datos privados.
- Las acciones del trabajador exigen perfil aprobado, cuenta activa y rol (403),
  también la confirmación del cobro de la visita.

## Cambio de zona pendiente (RF-13)

Son **trabajos ya acordados**: registrar la visita, confirmar su cobro, iniciar,
pedir un presupuesto adicional y terminar funcionan con una solicitud de cambio
de zona pendiente. `lockForWorker` usa
`WorkerProfileService.lockApprovedWorkerForAgreedWork`, que no la consulta. Las
oportunidades nuevas se bloquean en Offers y Orders (ver
[WorkerProfileModule](../worker-profile/README.md)).

## Plazo de 7 días y cierre automático (RN-10, RF-28)

- `conformityDeadline = finishedAt + 7 × 24 h`, fijado al terminar
  (`computeConformityDeadline`, única función a cambiar si el docente define
  «días calendario» de otra forma).
- Reclamo o conformidad válidos si `ahora < deadline`; el cierre automático
  solo si `ahora ≥ deadline`. Todos toman `lockOrder` (FOR UPDATE) y deciden
  con `clock_timestamp()` dentro del bloqueo: solo uno gana, el otro ve otro
  estado y responde 409 / no hace nada. Un pedido EN_RECLAMO nunca se cierra
  por plazo.
- `ConformityClosureService` corre cada `WORKFLOW_CLOSURE_INTERVAL_MINUTES`
  (15) salvo `SCHEDULED_JOBS_ENABLED=false`; cada pedido en su transacción;
  idempotente. Actor del historial: `SISTEMA / CIERRE_CONFORMIDAD`.
  Base normativa: RF-28 criterio 2 y CU-28 paso 5 («el sistema cierra el
  pedido»).

## Contratos públicos para Persona B

- `WorkflowQueryService` (solo lectura, acepta el `tx` del llamador):
  `getAgreedAmount(orderId)` → `{ baseAmount, acceptedAdditional, totalAmount }`,
  `getVisit`, `listAdditionalBudgets`, `getExecution`, `hasWorkFinished`,
  `getConformityDeadline`.
- `WorkflowEventRegistry.register({ name, inTransaction?, afterCommit? })`:
  hooks transaccionales (patrón de `OrderLifecycleRegistry`). Eventos:
  `VISITA_REGISTRADA`, `TRABAJO_INICIADO`, `ADICIONAL_PROPUESTO`,
  `ADICIONAL_ACEPTADO`, `TRABAJO_TERMINADO`, `CONFORMIDAD_CONFIRMADA`,
  `CIERRE_POR_PLAZO`, `INASISTENCIA_REPORTADA`, `RECLAMO_PRESENTADO`,
  `RECLAMO_EN_REVISION`, `RECLAMO_RESUELTO`. OrderNotificationsModule
  registra el hook que crea los avisos de todos ellos (RF-33). El hook corre
  con el pedido bloqueado: no debe llamar a `lockWorker()`.
- `VisitPaymentRegistry.register(recorder)`: PaymentsModule registra su
  implementación de `recordVisitPayment(tx, { orderId, amount, confirmedByUserId })`
  (idempotente por pedido; el monto lo fija A).
- `ACORDADO → ANTICIPO_REGISTRADO` la pide PaymentsModule con
  `OrdersService.transition()` (actor: el trabajador asignado). Orders exige la
  confirmación registrada (`AdvanceConfirmationRegistry`).
- Agenda: `CANCELADO` y `CERRADO` no están en `ACTIVE_ORDER_STATUSES`, así que
  cancelar libera la franja sin hooks; `TERMINADO` y `EN_RECLAMO` siguen
  ocupándola.
- `OffersService.getAcceptedOfferTerms(db, orderId)` (nuevo, solo lectura)
  expone `requiresVisit`, `visitCost`, `amount`, `proposedStartAt` y la
  duración de la oferta aceptada.

## Integración

`AppModule` registra este módulo junto con `ClaimsModule`, `PaymentsModule`,
`ReviewsModule`, `TimelineModule`, `OrderNotificationsModule` y
`AgendaModule`. PaymentsModule implementa el puerto del cobro de la visita y
OrderNotificationsModule registra los avisos (RF-33). El 501 solo ocurre si la
aplicación se arma sin PaymentsModule.

## Pendientes y decisiones aisladas (no implementar sin confirmación)

- **Contraoferta del adicional (CU-27 A1):** no se implementa: falta definir
  quién propone, qué cambia y el límite de rondas.
- **Inasistencia (RF-36):** solo se registra el hecho (uno por pedido,
  idempotente). La condición de tiempo (`now >= proposedStartAt`, tolerancia)
  está aislada en `no-show-timing.policy.ts` y hoy no restringe; solo se exige
  estado ACORDADO o ANTICIPO_REGISTRADO. Sin republicación, cambio de estado ni
  efecto en estrellas.
- **Cancelación (RF-34):** no decide nada sobre el anticipo.
- **«Días calendario»:** se interpretan como 168 h exactas.
- `materials` del adicional es obligatorio (RF-26 lo lista junto a monto y motivo).
