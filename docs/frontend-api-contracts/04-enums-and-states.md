# 04. Enumeraciones y estados

Valores **exactos** que usa el backend: enums de Prisma y literales del código. Las transiciones listadas son solo las **implementadas**; lo que no está implementado se indica expresamente.

## Enums de la base de datos (Prisma)

### `RoleName`

| Valor | Significado en el código | Cómo se obtiene |
|---|---|---|
| `CLIENTE` | Publica y gestiona pedidos | Siempre al registrarse |
| `TRABAJADOR` | Gestiona su perfil de trabajador. Las funciones de trabajador también exigen el perfil `APROBADO` | Al crear el perfil (`POST /worker-profile`), en la misma transacción |
| `ADMINISTRADOR` | Catálogos, bitácora, cambios de zona y usuarios | **No hay endpoint** (RF-04). El primero se crea con el comando interno `npm run admin:create-first` (README, sección H, paso 5), solo con el rol `ADMINISTRADOR`. No hay mecanismo para administradores adicionales |

Una cuenta puede tener varios roles (RN-14 y RF-02). Ningún endpoint quita roles.

### `UserStatus`

| Valor | Efecto |
|---|---|
| `ACTIVO` | Puede iniciar sesión y usar la API |
| `INACTIVO` | No puede iniciar sesión (403). Sus tokens existentes responden 401. Sus pedidos se ocultan a los trabajadores |
| `SUSPENDIDO` | Igual que `INACTIVO`. Además, al suspender se cancela la solicitud de cambio de zona pendiente (`SUSPENSION_CUENTA`, T4-F3). No confundir con suspender el **perfil** de trabajador (#55) |

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
| `PENDIENTE` | Enviado a revisión | ✘ | ✘ | ✘ (si su zona se desactiva, un administrador le asigna otra: #66) |
| `OBSERVADO` | Con observaciones que corregir | ✔ | ✘ | ✘ (si su zona se desactiva, un administrador le asigna otra: #66) |
| `APROBADO` | Habilitado | ✘ | ✔ (sin trabajos nuevos mientras tenga una solicitud de cambio de zona pendiente: `canTakeNewWork`) | ✔ |
| `RECHAZADO` | Rechazado; puede corregir y reenviar | ✔ (salvo la zona) | ✘ | ✘ (si su zona se desactiva, un administrador le asigna otra: #66) |
| `SUSPENDIDO` | Suspendido; puede regularizar su perfil | ✔ (salvo la zona; no puede enviarlo a revisión) | ✘ | ✘ (al suspender se cancela la pendiente; si su zona se desactiva, un administrador le asigna otra: #66) |

"Editable" se refiere a datos, especialidades y documentos. Los horarios se pueden reemplazar en **cualquier** estado.

Transiciones:

| Transición | Quién | ¿Disponible por HTTP? |
|---|---|---|
| (nuevo) → `BORRADOR` | Trabajador, `POST /worker-profile` | ✅ |
| `BORRADOR` → `PENDIENTE`, `OBSERVADO` → `PENDIENTE`, `RECHAZADO` → `PENDIENTE` (reenvío) | Trabajador, `POST /me/submit` | ✅ Exige los mismos requisitos que el primer envío (400 con la lista). Cada envío agrega una entrada al historial (`changedBy: TRABAJADOR`); no se registra en la bitácora administrativa |
| `PENDIENTE` → `APROBADO` / `OBSERVADO` / `RECHAZADO` | Administrador (`ADMIN_TRANSITIONS`), nunca sobre su propio perfil | ✅ `PATCH /worker-profile/admin/profiles/:profileId/status` (#55). Aprobar exige que el perfil siga cumpliendo los requisitos de envío |
| `APROBADO` → `SUSPENDIDO`, `SUSPENDIDO` → `APROBADO` | Administrador, nunca sobre su propio perfil | ✅ #55. La reactivación (`SUSPENDIDO` → `APROBADO`) exige los mismos requisitos vigentes que la aprobación (T4-F1), comprobados dentro de la transacción |

`OBSERVADO`, `RECHAZADO` y `SUSPENDIDO` exigen un motivo no vacío (`STATUSES_REQUIRING_REASON`). Cualquier otra transición responde 409. Rechazar o suspender un perfil **no** cambia los roles ni el estado de la cuenta: el usuario sigue siendo `CLIENTE` y `ACTIVO`.

`RECHAZADO` **no es terminal** (v1.0 §5, T3.1): el trabajador ve el motivo en `/me/status` y `/me/eligibility`, corrige datos, especialidades, horarios y documentos, y reenvía con `POST /me/submit`. La zona sigue fija (RF-13): no puede cambiarla ni pedir un cambio de zona. Si su zona fue desactivada, solo un administrador puede asignarle otra zona activa (#66, T4.4), con justificación y sin cambiar el estado. Lo mismo vale para `OBSERVADO` y `PENDIENTE` (T4-F2).

`SUSPENDIDO` (T4-F7): el trabajador puede regularizar su perfil (datos, especialidades, horarios y documentos), pero no cambiar su zona ni enviarlo a revisión, y sigue sin pedidos, ofertas ni asignaciones nuevas. Si su zona fue desactivada, un administrador se la reasigna (#66) sin cambiar el estado. Nunca se reactiva solo: un administrador lo pasa a `APROBADO` (#55), y solo si cumple todos los requisitos vigentes. Mientras esté `RECHAZADO` o `PENDIENTE` no recibe pedidos; vuelve a recibirlos solo con una nueva aprobación.

### `WeekDay`

`LUNES`, `MARTES`, `MIERCOLES`, `JUEVES`, `VIERNES`, `SABADO`, `DOMINGO` (sin tildes). Se usa en los horarios del trabajador.

### `WorkerDocumentType`

`IDENTIDAD`, `ANTECEDENTES`, `CERTIFICADO`, `REFERENCIA`. Ninguno es obligatorio para enviar el perfil a revisión.

### `ZoneChangeRequestStatus`

| Valor | Significado |
|---|---|
| `PENDIENTE` | Esperando la decisión. Solo puede haber una por perfil |
| `APROBADA` | Aplicada: la zona del perfil cambió |
| `RECHAZADA` | El perfil conserva su zona. Siempre tiene motivo (`decisionComment`) |
| `CANCELADA` | Cerrada sin decisión administrativa (T4.2); el perfil conserva su zona. La causa está en `cancellationCause` |

`ZoneChangeCancellationCause`: `SUSPENSION_PERFIL` (el perfil se suspendió con la solicitud pendiente, T4.2), `SUSPENSION_CUENTA` (la cuenta de usuario se suspendió, T4-F3; migración `20261122500000_zone_change_account_suspension`) o `RETIRO_TRABAJADOR` (el trabajador la retiró con #65, T4.3; migración `20261122300000_zone_change_withdrawal`).

Mientras exista una solicitud `PENDIENTE`, el trabajador no puede ofertar ni recibir trabajos nuevos (409); al aprobarse, rechazarse, retirarse o cancelarse vuelve a poder hacerlo, en la zona vigente. No afecta a los trabajos que ya tiene.

Transiciones: `PENDIENTE` → `APROBADA` o `PENDIENTE` → `RECHAZADA`, por un administrador (`PATCH /admin/zone-change-requests/:id`); `PENDIENTE` → `CANCELADA`, automáticamente al suspender el perfil (#55) o la cuenta (#7), o cuando el trabajador la retira (#65). Solo un perfil `APROBADO` puede crear una solicitud, y no se aprueba una de un perfil `SUSPENDIDO` o `RECHAZADO` ni de una cuenta `SUSPENDIDO`. Las solicitudes resueltas no cambian más (lo impide un trigger en la BD) y una CHECK exige la causa solo en `CANCELADA` (migración `20261122200000_zone_change_cancellation`).

### `OrderStatus`

| Valor | Qué lo produce hoy | Visible para trabajadores | Editable o cancelable por el cliente |
|---|---|---|---|
| `PUBLICADO` | Crear el pedido | ✔ (si no venció) | ✔ (si no venció) |
| `EN_NEGOCIACION` | La primera oferta (#69) | ✔ | ✔ |
| `ACORDADO` | Aceptar una oferta (#77), con asignación de trabajador | ✘ | ✘ (409 sugiere "Cancelar trabajo", RF-34) |
| `ANTICIPO_REGISTRADO`, `VISITA_REALIZADA`, `PRESUPUESTO_ADICIONAL_PENDIENTE`, `EN_EJECUCION`, `TERMINADO`, `EN_RECLAMO` | Nada (módulos futuros) | ✘ | ✘ (409, RF-34) |
| `CERRADO`, `SIN_ACUERDO` | Nada (módulos futuros) | ✘ | ✘ |
| `VENCIDO` | Tarea automática (cada 15 min) o estado efectivo (ver abajo) | ✘ | ✘ |
| `CANCELADO` | `POST /orders/me/:id/cancel` | ✘ | ✘ |

**Vencimiento (T5.1):** todo pedido vence a los **7 días calendario** desde su publicación original (`expiresAt = publishedAt + 7 días`, reloj de la BD). Ese plazo no se reinicia nunca: ni al editar, ni al cambiar de estado, ni al volver a `PUBLICADO` después de una negociación fallida, y no depende de las ofertas.

**Limpieza al cerrar (T5.4):** al vencer o al cancelarlo el cliente, el pedido se **limpia** (T5.4): se borran sus fotos (de la BD y del disco, por la cola de borrado con reintentos) y su dirección exacta, y la descripción se reemplaza por `"Descripción no disponible por cierre del pedido."`; `anonymizedAt` indica cuándo. Se conservan categoría, zona, presupuesto, fechas, estado e historial (nunca se borra). **Nunca** se limpia un pedido que alguna vez tuvo un acuerdo (trabajador asignado o `ACORDADO` o posterior en su historial). Los pedidos cerrados antes de T5.4 se limpian con la misma rutina en cada pasada de la tarea automática.

**Estado efectivo:** un pedido `PUBLICADO` o `EN_NEGOCIACION` cuyo `expiresAt` ya pasó se devuelve como `VENCIDO` en todas las respuestas y ya no admite ediciones, cancelación, ofertas ni cambios de estado, aunque la tarea automática todavía no lo haya registrado. La tarea corre al arrancar el servidor y luego periódicamente; nunca vence dos veces el mismo pedido.

Transiciones implementadas (`ORDER_TRANSITIONS`):

| Desde | Hacia | Cómo | ¿Por HTTP? |
|---|---|---|---|
| (nuevo) | `PUBLICADO` | Crear | ✅ |
| `PUBLICADO` | `CANCELADO` | Cancelar (cliente) | ✅ |
| `EN_NEGOCIACION` | `CANCELADO` | Cancelar (cliente); sus ofertas vigentes quedan `SIN_EFECTO` | ✅ |
| `PUBLICADO` o `EN_NEGOCIACION` | `VENCIDO` | Tarea automática (`SISTEMA`, proceso `VENCIMIENTO`), a los 7 días de la publicación | — |
| `PUBLICADO` | `EN_NEGOCIACION` | Primera oferta (`transition()` desde OffersModule) | ✅ #69 |
| `EN_NEGOCIACION` | `ACORDADO` (asigna al trabajador) | Aceptar una oferta | ✅ #77 |
| `EN_NEGOCIACION` | `PUBLICADO` (conserva el vencimiento original) | Ya no quedan ofertas vigentes: rechazo (#75), retiro (#76), vencimiento de ofertas o cierre por suspensión (`SISTEMA`) | ✅ / tarea |

Todo lo demás está **sin implementar**: el resto del flujo hasta `CERRADO`, `SIN_ACUERDO` y la salida desde `ACORDADO` (❓ pendientes con el docente).

Todo cambio de estado queda en `order_status_history`, pero **no hay endpoint para consultarlo**.

### `OfferStatus` (ofertas, T6.1)

| Valor | Qué lo produce | Final |
|---|---|---|
| `VIGENTE` | Crear la oferta (#69); se mantiene con las contraofertas (#74) | No |
| `ACEPTADA` | Aceptar (#77) | Sí |
| `RECHAZADA` | Rechazar (#75) | Sí |
| `RETIRADA` | Retirar (#76) | Sí |
| `VENCIDA` | 24 h sin respuesta (tarea cada 5 min y al arrancar) o vencimiento del pedido | Sí |
| `SIN_EFECTO` | Se aceptó otra oferta, se canceló el pedido o se suspendió la cuenta del cliente, la cuenta del trabajador o su perfil | Sí |

Una `VIGENTE` con `expiresAt` cumplido se devuelve `VENCIDA` (estado efectivo) y no admite operaciones. Una oferta cerrada no se reabre. Tras `RECHAZADA`, `RETIRADA`, `ACEPTADA` o `SIN_EFECTO` el trabajador no puede volver a ofertar en ese pedido; tras `VENCIDA`, sí.

### `OfferParty`

`CLIENTE` o `TRABAJADOR` (`OfferView.turn`): quién debe responder. La propuesta deja el turno al cliente y cada contraoferta lo pasa a la otra parte. Máximo 3 rondas.

### `OfferEventType` (historial de negociación, RF-21)

`PROPUESTA` (ronda 1, con monto), `CONTRAOFERTA` (rondas 2 y 3, con monto), `ACEPTADA`, `RECHAZADA`, `RETIRADA`, `VENCIDA`, `SIN_EFECTO` (cierres, sin monto). Solo inserción: no se modifica ni se borra.

Motivos de los cierres del sistema (`OfferEventView.systemProcess` / `reason`):

| `systemProcess` | `reason` | Cuándo |
|---|---|---|
| `VENCIMIENTO_OFERTA` | `null` | Pasaron 24 h sin respuesta |
| `ACEPTACION_OFERTA` | `"El cliente aceptó otra oferta para este pedido."` | Se aceptó otra oferta del pedido |
| `CIERRE_OFERTAS` | `PEDIDO_CANCELADO`, `PEDIDO_VENCIDO`, `CLIENTE_SUSPENDIDO`, `TRABAJADOR_SUSPENDIDO`, `PERFIL_SUSPENDIDO` | Cambios externos (T6.5.2) |

### `OrderActorType`

`USUARIO` o `SISTEMA`. Lo usa el historial de pedidos, que no se expone por HTTP.

### `AuditAction` y `AuditEntityType`

| Enum | Valores | Uso real hoy |
|---|---|---|
| `AuditAction` | `CREACION`, `EDICION`, `DESACTIVACION`, `CAMBIO_ESTADO`, `APROBACION`, `RECHAZO`, `CONSULTA_DOCUMENTOS`, `VISUALIZACION_DOCUMENTO`, `DESCARGA_DOCUMENTO` | Catálogos (las tres primeras); solicitudes de zona (`APROBACION`, `RECHAZO`); decisiones sobre perfiles (`CAMBIO_ESTADO`, #55); cancelaciones automáticas de solicitudes de zona (`CAMBIO_ESTADO`); reasignación de zona de un perfil (`EDICION` sobre `PERFIL_TRABAJADOR`, #66); acceso administrativo a documentos (las tres últimas, #58–#60; migración `20261122000000_audit_document_access`) |
| `AuditEntityType` | `CATEGORIA_SERVICIO`, `ZONA`, `PERFIL_TRABAJADOR`, `SOLICITUD_CAMBIO_ZONA` | Filtro de `GET /audit-logs` |

### `NotificationType` y `NotificationResourceType`

Notificaciones internas (T3.2, migración `20261122100000_create_notifications`). Por ahora solo hay eventos de la verificación de perfiles:

| Tipo | Destinatario | Evento que lo genera | ¿Incluye el motivo? |
|---|---|---|---|
| `PERFIL_APROBADO` | El trabajador | `PENDIENTE` → `APROBADO` (#55) | Solo si el administrador escribió un comentario |
| `PERFIL_OBSERVADO` | El trabajador | `PENDIENTE` → `OBSERVADO` (#55) | Sí |
| `PERFIL_RECHAZADO` | El trabajador | `PENDIENTE` → `RECHAZADO` (#55) | Sí |
| `PERFIL_SUSPENDIDO` | El trabajador | `APROBADO` → `SUSPENDIDO` (#55) | Sí |
| `PERFIL_REACTIVADO` | El trabajador | `SUSPENDIDO` → `APROBADO` (#55) | Solo si el administrador escribió un comentario |
| `VERIFICACION_SOLICITADA` | Cada administrador activo, salvo quien envía | `BORRADOR` → `PENDIENTE` (#28) | No (sin datos personales del trabajador) |
| `VERIFICACION_REENVIADA_OBSERVACION` | Ídem | `OBSERVADO` → `PENDIENTE` (#28) | No |
| `VERIFICACION_REENVIADA_RECHAZO` | Ídem | `RECHAZADO` → `PENDIENTE` (#28) | No |
| `SOLICITUD_ZONA_APROBADA` | El trabajador | Su solicitud de cambio de zona se aprobó (#40) | Solo si el administrador escribió un comentario |
| `SOLICITUD_ZONA_RECHAZADA` | El trabajador | Su solicitud se rechazó (#40) | Sí (obligatorio) |
| `SOLICITUD_ZONA_CANCELADA` | El trabajador | Su solicitud pendiente se canceló al suspender su perfil (#55) | No (la suspensión llega en su propia notificación `PERFIL_SUSPENDIDO`) |
| `SOLICITUD_ZONA_RETIRADA` | El trabajador | Confirma que retiró su solicitud (#65, T4.3) | No |
| `BORRADO_ARCHIVO_ESCALADO` | Cada administrador activo | Un archivo privado no se pudo borrar después de 10 intentos (T5.4). Se avisa una sola vez por archivo; se sigue reintentando cada 6 horas | No (incluye el motivo de cola y la clave, sin rutas) |
| `ZONA_REASIGNADA` | El trabajador `RECHAZADO` | Un administrador reasignó su zona desactivada (#66, T4.4; `resourceType: PERFIL_TRABAJADOR`; migración `20261122400000_zone_reassignment_notification`) | No (la justificación queda en la bitácora) |

Cada notificación se crea **en la misma transacción** que el evento: si falla, el cambio de estado o el envío tampoco se confirma. `NotificationResourceType`: `PERFIL_TRABAJADOR` (eventos de verificación) o `SOLICITUD_CAMBIO_ZONA` (T4.2).

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
| `WhatsAppContact.channel` | `WHATSAPP` | #78, #79 |
| `WhatsAppContact.contactRole` | `CLIENTE`, `TRABAJADOR` | #78, #79 |
| `WhatsAppContact.reason` | `TELEFONO_NO_REGISTRADO`, `TELEFONO_INVALIDO` | #78, #79 (solo con `available: false`) |

## Estados que **no existen** en el backend

No hay ningún enum, tabla ni endpoint para:
- Estados de **agenda** (visitas y ejecuciones).
- Estados de **reclamos**.
- Estados de **pagos**, anticipos o constancias.
- Estados de **calificaciones**.
- Solicitudes administrativas distintas de las de cambio de zona.

Angular **no debe** definir estos tipos como si fueran contratos: quedan pendientes (ver 09).
