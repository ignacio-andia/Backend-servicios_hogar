# 04. Enumeraciones y estados

Valores **exactos** que usa el backend: enums de Prisma y literales del código. Las transiciones listadas son solo las **implementadas**; lo que no está implementado se indica expresamente.

## Enums de la base de datos (Prisma)

### `RoleName`

| Valor | Significado en el código | Cómo se obtiene |
|---|---|---|
| `CLIENTE` | Publica y gestiona pedidos | Siempre al registrarse |
| `TRABAJADOR` | Gestiona su perfil de trabajador. Las funciones de trabajador también exigen el perfil `APROBADO` | Al crear el perfil (`POST /worker-profile`), en la misma transacción |
| `ADMINISTRADOR` | Catálogos, bitácora, cambios de zona y usuarios | **No hay endpoint**: se asigna directamente en la BD (RF-04) |

Una cuenta puede tener varios roles (RN-14 y RF-02). Ningún endpoint quita roles.

### `UserStatus`

| Valor | Efecto |
|---|---|
| `ACTIVO` | Puede iniciar sesión y usar la API |
| `INACTIVO` | No puede iniciar sesión (403). Sus tokens existentes responden 401. Sus pedidos se ocultan a los trabajadores |
| `SUSPENDIDO` | Igual que `INACTIVO` |

Transiciones (`PATCH /users/:id/status`):

| Quién | Permitido |
|---|---|
| El propio usuario (no admin) | Solo pasar su propia cuenta a `INACTIVO`. No puede reactivarse |
| Administrador | Cualquier estado sobre cualquier cuenta, salvo dejar la plataforma sin administradores `ACTIVO` (409) |

Si el estado no cambia, responde 200 sin modificar nada.

### `WorkerProfileStatus`

| Valor | Significado | ¿Editable? | ¿Usa funciones de trabajador? | ¿Puede pedir cambio de zona? |
|---|---|---|---|---|
| `BORRADOR` | Creado, aún no enviado | ✔ | ✘ | ✘ (elige la zona directamente) |
| `PENDIENTE` | Enviado a revisión | ✘ | ✘ | ✔ (❓ pendiente con el docente) |
| `OBSERVADO` | Con observaciones que corregir | ✔ | ✘ | ✔ (❓) |
| `APROBADO` | Habilitado | ✘ | ✔ | ✔ |
| `RECHAZADO` | Rechazado | ✘ | ✘ | ✘ |
| `SUSPENDIDO` | Suspendido | ✘ | ✘ | ✔ (❓) |

"Editable" se refiere a datos, especialidades y documentos. Los horarios se pueden reemplazar en **cualquier** estado.

Transiciones:

| Transición | Quién | ¿Disponible por HTTP? |
|---|---|---|
| (nuevo) → `BORRADOR` | Trabajador, `POST /worker-profile` | ✅ |
| `BORRADOR` → `PENDIENTE`, `OBSERVADO` → `PENDIENTE` | Trabajador, `POST /me/submit` | ✅ |
| `PENDIENTE` → `APROBADO` / `OBSERVADO` / `RECHAZADO` | Administrador (`ADMIN_TRANSITIONS`) | 🟡 **No.** Existe `WorkerProfileService.changeStatusByAdmin`, pero ningún endpoint lo llama |
| `APROBADO` → `SUSPENDIDO`, `SUSPENDIDO` → `APROBADO` | Administrador | 🟡 **No**, por la misma razón |

`OBSERVADO`, `RECHAZADO` y `SUSPENDIDO` exigen un motivo (`STATUSES_REQUIRING_REASON`) cuando lo decide el administrador. Hoy, sin endpoint, **ningún perfil puede llegar a `APROBADO` por la API**.

### `WeekDay`

`LUNES`, `MARTES`, `MIERCOLES`, `JUEVES`, `VIERNES`, `SABADO`, `DOMINGO` (sin tildes). Se usa en los horarios del trabajador.

### `WorkerDocumentType`

`IDENTIDAD`, `ANTECEDENTES`, `CERTIFICADO`, `REFERENCIA`. Ninguno es obligatorio para enviar el perfil a revisión.

### `ZoneChangeRequestStatus`

| Valor | Significado |
|---|---|
| `PENDIENTE` | Esperando la decisión. Solo puede haber una por perfil |
| `APROBADA` | Aplicada: la zona del perfil cambió |
| `RECHAZADA` | El perfil conserva su zona |

Transiciones: solo `PENDIENTE` → `APROBADA` o `PENDIENTE` → `RECHAZADA`, por un administrador (`PATCH /admin/zone-change-requests/:id`). Las solicitudes resueltas no cambian más (lo impide un trigger en la BD).

### `OrderStatus`

| Valor | Qué lo produce hoy | Visible para trabajadores | Editable o cancelable por el cliente |
|---|---|---|---|
| `PUBLICADO` | Crear el pedido | ✔ (si no venció) | ✔ (si no venció) |
| `EN_NEGOCIACION` | Solo la API interna (sin endpoint; la usará OffersModule) | ✔ | ✔ |
| `ACORDADO` | Solo la API interna, con asignación de trabajador | ✘ | ✘ (409 sugiere "Cancelar trabajo", RF-34) |
| `ANTICIPO_REGISTRADO`, `VISITA_REALIZADA`, `PRESUPUESTO_ADICIONAL_PENDIENTE`, `EN_EJECUCION`, `TERMINADO`, `EN_RECLAMO` | Nada (módulos futuros) | ✘ | ✘ (409, RF-34) |
| `CERRADO`, `SIN_ACUERDO` | Nada (módulos futuros) | ✘ | ✘ |
| `VENCIDO` | Tarea automática (cada 15 min) o estado efectivo (ver abajo) | ✘ | ✘ |
| `CANCELADO` | `POST /orders/me/:id/cancel` | ✘ | ✘ |

**Estado efectivo:** un pedido `PUBLICADO` cuyo `expiresAt` ya pasó se devuelve como `VENCIDO` en todas las respuestas, aunque la tarea automática todavía no lo haya registrado.

Transiciones implementadas (`ORDER_TRANSITIONS`):

| Desde | Hacia | Cómo | ¿Por HTTP? |
|---|---|---|---|
| (nuevo) | `PUBLICADO` | Crear | ✅ |
| `PUBLICADO` | `CANCELADO` | Cancelar (cliente) | ✅ |
| `EN_NEGOCIACION` | `CANCELADO` | Cancelar (cliente) | ✅ (pero ningún pedido llega hoy a `EN_NEGOCIACION`) |
| `PUBLICADO` | `VENCIDO` | Tarea automática (`SISTEMA`, proceso `VENCIMIENTO`) | — |
| `PUBLICADO` | `EN_NEGOCIACION` | `OrdersService.transition()` (interna) | 📐 No |
| `EN_NEGOCIACION` | `ACORDADO` (asigna al trabajador) | `transition()` (interna) | 📐 No |
| `EN_NEGOCIACION` | `PUBLICADO` (reinicia el plazo de 48 h) | `transition()` (interna) | 📐 No |

Todo lo demás está **sin implementar**: el resto del flujo hasta `CERRADO`, `SIN_ACUERDO` y la salida desde `ACORDADO` (❓ pendientes con el docente).

Todo cambio de estado queda en `order_status_history`, pero **no hay endpoint para consultarlo**.

### `OrderActorType`

`USUARIO` o `SISTEMA`. Lo usa el historial de pedidos, que no se expone por HTTP.

### `AuditAction` y `AuditEntityType`

| Enum | Valores | Uso real hoy |
|---|---|---|
| `AuditAction` | `CREACION`, `EDICION`, `DESACTIVACION`, `CAMBIO_ESTADO`, `APROBACION`, `RECHAZO` | Catálogos (las tres primeras); solicitudes de zona (`APROBACION`, `RECHAZO`). `CAMBIO_ESTADO` solo lo escribiría el cambio de estado del perfil, que no tiene endpoint |
| `AuditEntityType` | `CATEGORIA_SERVICIO`, `ZONA`, `PERFIL_TRABAJADOR`, `SOLICITUD_CAMBIO_ZONA` | Filtro de `GET /audit-logs` |

## Literales de la API (no son enums de la BD)

| Literal | Valores | Dónde |
|---|---|---|
| `tokenType` | `"Bearer"` | `AuthResponse` |
| `PendingRequirement.field` | `phone`, `specialties`, `zone`, `schedules` | `WorkerProfileView` |
| `StatusHistoryEntry.changedBy` | `TRABAJADOR`, `ADMINISTRADOR` | `WorkerStatusView` |
| `ZoneChangeBlocker.code` | `PERFIL_EN_BORRADOR`, `ESTADO_NO_PERMITIDO`, `SOLICITUD_PENDIENTE`, `TRABAJO_ACTIVO`, `VERIFICACION_NO_DISPONIBLE` | `ZoneStatusView` |
| `decision` (entrada) | `APROBADA`, `RECHAZADA` | `DecideZoneChangeRequestDto` |
| `OrderWarning.code` | `POSIBLE_DUPLICADO`, `POSIBLE_DATO_PERSONAL` | Respuestas de pedidos |
| `variant` (query) | `full`, `thumb` | Descarga de fotos |

## Estados que **no existen** en el backend

No hay ningún enum, tabla ni endpoint para:
- Estados de **ofertas** o de negociación (OffersModule no está implementado).
- Estados de **agenda** (visitas y ejecuciones).
- Estados de **reclamos**.
- Estados de **pagos**, anticipos o constancias.
- Estados de **calificaciones**.
- Solicitudes administrativas distintas de las de cambio de zona.

Angular **no debe** definir estos tipos como si fueran contratos: quedan pendientes (ver 09).
