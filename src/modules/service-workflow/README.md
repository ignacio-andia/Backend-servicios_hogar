# ServiceWorkflowModule (Persona A)

Ciclo de vida del trabajo: visita, presupuesto adicional, ejecución,
conformidad, cancelación e inasistencia (RF-25 a RF-28, RF-34, RF-36).
Los reclamos (RF-37, RF-38) están en `ClaimsModule`.

Todos los cambios de estado pasan por `OrdersService.transition()` (o
`cancelAgreedWork()`); nunca se escribe `Order.status` directamente. El
historial es `OrderStatusHistory`. Rutas bajo el prefijo global `/api`.

## Matriz de transiciones (`orders.rules.ts`)

| Origen | Destino | Quién / operación |
|---|---|---|
| ACORDADO | ANTICIPO_REGISTRADO | PaymentsModule (RF-39) con `transition()` |
| ANTICIPO_REGISTRADO | VISITA_REALIZADA | trabajador, `POST visit` (oferta con visita) |
| ANTICIPO_REGISTRADO, VISITA_REALIZADA | EN_EJECUCION | trabajador, `POST start` |
| VISITA_REALIZADA, EN_EJECUCION | PRESUPUESTO_ADICIONAL_PENDIENTE | trabajador, `POST additional-budgets` |
| PRESUPUESTO_ADICIONAL_PENDIENTE | EN_EJECUCION | cliente acepta |
| EN_EJECUCION | TERMINADO | trabajador, `POST finish` |
| TERMINADO | CERRADO | cliente `confirm-conformity`, o cierre automático al vencer el plazo |
| TERMINADO | EN_RECLAMO | cliente presenta reclamo (`ClaimsModule`) |
| EN_RECLAMO | CERRADO | administrador registra la decisión |
| ACORDADO … EN_EJECUCION (no TERMINADO) | CANCELADO | cliente, `POST cancel-work` |

**No existe** salida de PRESUPUESTO_ADICIONAL_PENDIENTE por rechazo (ver
«Pendientes»).

## Invariantes que ningún módulo puede saltarse

`OrderLifecycleRegistry` tiene un hook nuevo, `beforeTransition(attempt, tx)`,
que `OrdersService.transition()` ejecuta dentro de su transacción, con el pedido
bloqueado y antes de aplicar el cambio (409 si no se cumple). Este módulo
(`WorkflowInvariantHooks`) y `ClaimsModule` (`ClaimsInvariantHooks`) registran
sus invariantes; los módulos que llaman a `transition()` (por ejemplo pagos) no
tienen que hacer nada, pero **no pueden** producir estados incoherentes:

| Destino | Exige |
|---|---|
| VISITA_REALIZADA | oferta con visita y visita registrada |
| EN_EJECUCION | desde ANTICIPO_REGISTRADO: oferta SIN visita; desde VISITA_REALIZADA: visita registrada; desde PRESUPUESTO_ADICIONAL_PENDIENTE: adicional ya respondido |
| PRESUPUESTO_ADICIONAL_PENDIENTE | exactamente un adicional PENDIENTE |
| TERMINADO | registro de ejecución con fin y plazo, sin adicional pendiente |
| CERRADO (desde TERMINADO) | registro de ejecución terminada |
| EN_RECLAMO | reclamo ABIERTO (`ClaimsModule`) |
| CERRADO (desde EN_RECLAMO) | reclamo RESUELTO con decisión (`ClaimsModule`) |

Contrato para B: `ACORDADO → ANTICIPO_REGISTRADO` no tiene restricciones
adicionales; se sigue pidiendo con `transition()` y el actor que B defina. Los
módulos de flujo escriben su registro **antes** de llamar a `transition()`.

## Presupuesto adicional: estados

`PENDIENTE` (esperando al cliente), `ACEPTADO`, `RECHAZADO` (reservado: nadie lo
escribe; decisión pendiente del docente) y **`SIN_EFECTO_POR_CANCELACION`**:
estado terminal que un hook del evento `CANCELADO` aplica a un adicional que
seguía pendiente cuando el cliente canceló el trabajo. No fue aceptado ni
rechazado (`respondedAt` queda vacío), ya no puede aceptarse (409) y no suma al
monto acordado. Un trigger de la BD (`additional_budgets_guard`) impide cambiar
el estado de un adicional que ya no está PENDIENTE.

## Endpoints

| Método y ruta | Rol | Respuesta |
|---|---|---|
| `GET /orders/:orderId/workflow` | cliente dueño o trabajador asignado | `{ orderId, status, visit, additionalBudgets[], execution, noShowReport }` |
| `POST /orders/:orderId/visit` | trabajador asignado aprobado | 201 `{ status, visit }` |
| `POST /orders/:orderId/visit/payment-confirmation` | trabajador asignado | 200 `{ visit }`; **501** hasta integrar pagos |
| `POST /orders/:orderId/start` | trabajador asignado | 200 `{ status, execution }` |
| `POST /orders/:orderId/additional-budgets` | trabajador asignado | 201 `{ status, budget }`; body `{ amount, reason, materials }` |
| `POST /orders/:orderId/additional-budgets/:budgetId/accept` | cliente dueño | 200 `{ status, budget }` |
| `POST /orders/:orderId/finish` | trabajador asignado | 200 `{ status, execution }` con `conformityDeadline` |
| `POST /orders/:orderId/confirm-conformity` | cliente dueño | 200 `{ status, execution }` |
| `POST /orders/:orderId/cancel-work` | cliente dueño | 200 vista del pedido; body `{ reason }` (obligatorio) |
| `POST /orders/:orderId/no-show` | cliente dueño | 200 `{ created, report }`; body `{ description? }` |

- Un pedido ajeno, o una acción de quien no es parte, responde **404**; un rol
  sin acceso a la ruta, **403**; estado de origen inválido o repetición
  (doble clic), **409** sin efectos duplicados; datos inválidos, **400**.
- `amount` es texto decimal positivo con hasta 2 decimales (`"50.00"`).
- Ninguna respuesta incluye dirección, teléfono ni datos privados.

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
  `RECLAMO_EN_REVISION`, `RECLAMO_RESUELTO`. **Sin un hook registrado no se
  generan notificaciones**: los textos y los valores nuevos de
  `NotificationType`/`NotificationResourceType` se coordinan con B (RF-33).
  El hook corre con el pedido bloqueado: no debe llamar a `lockWorker()`.
- `VisitPaymentRegistry.register(recorder)`: PaymentsModule registra su
  implementación de `recordVisitPayment(tx, { orderId, amount, confirmedByUserId })`
  (idempotente por pedido; el monto lo fija A). Mientras no se registre, el
  endpoint de confirmación responde 501 (no hay integración simulada).
- Transiciones que B necesita: `ACORDADO → ANTICIPO_REGISTRADO` con
  `OrdersService.transition()`. B no edita la matriz.
- Agenda: `CANCELADO` y `CERRADO` no están en `ACTIVE_ORDER_STATUSES`, así que
  cancelar libera la franja sin hooks; `TERMINADO` y `EN_RECLAMO` siguen
  ocupándola.
- `OffersService.getAcceptedOfferTerms(db, orderId)` (nuevo, solo lectura)
  expone `requiresVisit`, `visitCost`, `amount`, `proposedStartAt` y la
  duración de la oferta aceptada.

## Registro en `app.module.ts` (hacer al integrar)

```ts
import { ServiceWorkflowModule } from './modules/service-workflow/service-workflow.module.js';
import { ClaimsModule } from './modules/claims/claims.module.js';
// imports: [..., ServiceWorkflowModule, ClaimsModule]
```

## Pendientes y decisiones aisladas (no implementar sin confirmación)

- **Rechazo del adicional (RF-27 / CU-27 A1):** sin endpoint ni transición; el
  valor `RECHAZADO` existe en el enum pero nadie lo escribe. La contraoferta
  del adicional no se implementa ni se descarta (el modelo permite varios
  adicionales por pedido). Hasta decidir, el cliente puede cancelar el trabajo.
- **Inasistencia (RF-36):** solo se registra el hecho (uno por pedido,
  idempotente). La condición de tiempo (`now >= proposedStartAt`, tolerancia)
  está aislada en `no-show-timing.policy.ts` y hoy no restringe; solo se exige
  estado ACORDADO o ANTICIPO_REGISTRADO. Sin republicación, cambio de estado ni
  efecto en estrellas.
- **Cancelación (RF-34):** no decide nada sobre el anticipo.
- **«Días calendario»:** se interpretan como 168 h exactas.
- `materials` del adicional es obligatorio (RF-26 lo lista junto a monto y motivo).
