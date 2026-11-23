# 03. Modelos de respuesta

Cada modelo se obtuvo de lo que **construye el service** (selects explícitos, funciones `toView` y mapeos), no del esquema Prisma.

- No hay interceptores de serialización: los objetos `Date` llegan como strings ISO 8601 (UTC) y los `Decimal` se convierten explícitamente a string con 2 decimales.
- Los UUID, nombres y fechas de los ejemplos son ilustrativos.
- Hay **26 modelos JSON** (incluidos los anidados) y **2 respuestas binarias**.

## Endpoint → modelo de respuesta

| Endpoint (ver 01) | Modelo |
|---|---|
| #1 `POST /auth/register`, #2 `POST /auth/login` | `AuthResponse` |
| #3 `GET /auth/me`, #5–#7 usuarios | `PublicUser` |
| #4 `GET /users` | `Paginated<PublicUser>` |
| #8, #10 catálogos públicos (lista) | `CatalogOption[]` |
| #9, #11 catálogo público (uno) | `CatalogOption` |
| #12, #14 catálogos admin (lista) | `CatalogItem[]` |
| #13, #15–#21 catálogo admin (uno, crear, editar, desactivar) | `CatalogItem` |
| #22 bitácora | `Paginated<AuditLog>` |
| #23–#28 perfil | `WorkerProfileView` |
| #29 estado | `WorkerStatusView` |
| #30 elegibilidad | `WorkerEligibility` |
| #31 documentos | `WorkerDocumentView[]` |
| #32, #33 subir o reemplazar documento | `WorkerDocumentView` |
| #34 descarga de documento | Binario |
| #35 zona | `ZoneStatusView` |
| #36 crear solicitud | `ZoneChangeRequestView` |
| #37 solicitudes propias | `ZoneChangeRequestView[]` |
| #65 retirar una solicitud propia | `ZoneChangeRequestView` (ya `CANCELADA`) |
| #38 solicitudes (admin) | `Paginated<AdminZoneChangeRequestView>` |
| #39, #40 solicitud (admin) | `AdminZoneChangeRequestView` |
| #41 perfiles con zona inactiva | `AffectedProfile[]` |
| #55 decisión administrativa sobre un perfil | `WorkerProfileView` (el perfil ya actualizado; **sin** el motivo ni el historial) |
| #66 reasignar la zona de un perfil `RECHAZADO`, `OBSERVADO`, `PENDIENTE` o `SUSPENDIDO` | `AdminWorkerProfileView` (el detalle de #57, con la zona nueva y el mismo estado) |
| #56 perfiles para revisar (admin) | `Paginated<AdminWorkerProfileSummary>` |
| #57 detalle de un perfil (admin) | `AdminWorkerProfileView` |
| #58 documentos de un perfil (admin) | `WorkerDocumentView[]` (los mismos metadatos que ve el trabajador) |
| #59, #60 ver o descargar un documento (admin) | Binario |
| #42 crear pedido, #47 editar pedido | `OrderWithWarnings` |
| #43 aviso de duplicados | `DuplicateCheckResponse` |
| #44 mis pedidos | `Paginated<OwnerOrderView>` |
| #45, #48–#51 pedido propio, fotos, cancelar | `OwnerOrderView` |
| #46, #54 fotos | Binario `image/webp` |
| #52 pedidos disponibles | `Paginated<WorkerOrderView>` |
| #53 pedido disponible | `WorkerOrderView` |
| #80 pedido asignado | `AssignedOrderView` |
| #81 foto del pedido asignado | Binario `image/webp` |
| #67 pedidos (admin) | `Paginated<AdminOrderSummary>` |
| #68 detalle de un pedido (admin) | `AdminOrderView` |
| #69 crear oferta, #71 detalle propio, #76 retirar | `OfferDetail<OfferView>` |
| #70 ofertas propias | `Paginated<OfferView>` |
| #72 ofertas recibidas | `Paginated<ReceivedOfferView>` |
| #73 detalle recibido, #75 rechazar, #77 aceptar | `OfferDetail<ReceivedOfferView>` |
| #74 contraofertar | `OfferDetail<ReceivedOfferView>` si responde el cliente; `OfferDetail<OfferView>` si responde el trabajador |
| #78, #79 contacto | `WhatsAppContact` |
| #61 notificaciones | `Paginated<NotificationView>` |
| #62 no leídas | `{ unread: number }` |
| #63 marcar como leída | `NotificationView` |
| #64 marcar todas como leídas | `{ updated: number }` (cuántas cambiaron; 0 si no había) |
| Cualquier error | `ApiError` |

---

## `ApiError`

Formato estándar de NestJS (`HttpException`). Los filtros de 413 (documentos y fotos) devuelven la misma forma.

| Propiedad | Tipo | Notas |
|---|---|---|
| `statusCode` | number | Código HTTP |
| `message` | string \| string[] | **Arreglo** en los errores de validación del DTO y en algunos de negocio: categorías inválidas, horarios, requisitos de envío del perfil, bloqueos de cambio de zona, requisitos de aprobación |
| `error` | string | Texto del código (`"Bad Request"`, `"Conflict"`, …). En 500 no está y `message` es `"Internal server error"` |

```json
{ "statusCode": 400, "message": ["email must be an email", "password debe contener al menos una letra y un número"], "error": "Bad Request" }
```

```json
{ "statusCode": 409, "message": "La solicitud ya fue resuelta", "error": "Conflict" }
```

---

## Cuentas

### `AuthResponse`

| Propiedad | Tipo | Notas |
|---|---|---|
| `accessToken` | string | JWT HS256. Payload: `{ sub, email, iat, exp }`, **sin roles** |
| `tokenType` | `"Bearer"` | Constante |
| `user` | `PublicUser` | Usuario autenticado |

### `PublicUser`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | string (UUID) | no | |
| `firstName` | string | no | |
| `lastName` | string | no | |
| `email` | string | no | En minúsculas |
| `phone` | string | **sí** | |
| `status` | `UserStatus` | no | |
| `roles` | `RoleName[]` | no | Arreglo plano; una cuenta puede tener varios |
| `createdAt` | string (ISO) | no | |
| `updatedAt` | string (ISO) | no | |

Excluidos: `passwordHash`, y la fecha o el autor de asignación de cada rol.

```json
{
  "id": "8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f",
  "firstName": "Ana", "lastName": "Pérez", "email": "ana@example.com", "phone": "70000000",
  "status": "ACTIVO", "roles": ["CLIENTE", "TRABAJADOR"],
  "createdAt": "2026-11-15T14:30:00.000Z", "updatedAt": "2026-11-15T14:30:00.000Z"
}
```

### `Paginated<T>`

| Propiedad | Tipo |
|---|---|
| `data` | `T[]` |
| `meta.page` | number |
| `meta.limit` | number |
| `meta.total` | number |
| `meta.totalPages` | number (`Math.ceil(total / limit)`; 0 si no hay resultados) |

Orden de cada listado:
- Usuarios: `createdAt` descendente.
- Bitácora: `createdAt` y luego `id`, descendentes.
- Mis pedidos: `createdAt` descendente.
- Pedidos disponibles: `publishedAt` descendente.
- Solicitudes (admin): `createdAt` descendente.

---

## Catálogos

### `CatalogOption` (público)

| Propiedad | Tipo | Nullable |
|---|---|---|
| `id` | string | no |
| `name` | string | no |
| `description` | string | **sí** |

No incluye `isActive` (todos son activos) ni fechas.

```json
[{ "id": "2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4", "name": "Plomería", "description": null }]
```

### `CatalogItem` (administración)

| Propiedad | Tipo | Nullable |
|---|---|---|
| `id` | string | no |
| `name` | string | no |
| `description` | string | **sí** |
| `isActive` | boolean | no |
| `createdAt` | string | no |
| `updatedAt` | string | no |

### `CatalogRef` (embebido en perfiles, pedidos y solicitudes)

| Propiedad | Tipo |
|---|---|
| `id` | string |
| `name` | string |
| `isActive` | boolean (permite marcar en la interfaz una zona o especialidad desactivada) |

---

## Bitácora

### `AuditLog`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | string | no | |
| `action` | `AuditAction` | no | |
| `entityType` | `AuditEntityType` | no | |
| `entityId` | string | no | |
| `details` | objeto JSON | **sí** | Su forma depende de la acción (abajo) |
| `createdAt` | string | no | |
| `actor` | `{ id, firstName, lastName, email }` | no | Administrador que actuó |

Formas de `details` que escribe el código hoy:

| entityType / action | `details` |
|---|---|
| `CATEGORIA_SERVICIO` o `ZONA` / `CREACION` | `{ name: string, description: string \| null }` |
| `CATEGORIA_SERVICIO` o `ZONA` / `EDICION` | `{ before: { name?, description? }, after: { name?, description? } }` (solo los campos cambiados) |
| `CATEGORIA_SERVICIO` o `ZONA` / `DESACTIVACION` | `{ name: string }` |
| `SOLICITUD_CAMBIO_ZONA` / `APROBACION` o `RECHAZO` | `{ profileId, workerUserId, fromZoneId, toZoneId, fromStatus: 'PENDIENTE', toStatus: 'APROBADA' \| 'RECHAZADA', comment: string \| null }` (`fromStatus` y `toStatus` desde T4.2) |
| `SOLICITUD_CAMBIO_ZONA` / `CAMBIO_ESTADO` | Cancelación automática al suspender el perfil (T4.2) o la cuenta (T4-F3): `{ profileId, workerUserId, fromZoneId, toZoneId, fromStatus: 'PENDIENTE', toStatus: 'CANCELADA', cause: 'SUSPENSION_PERFIL' \| 'SUSPENSION_CUENTA' }`. `actor` = administrador que suspendió |
| `PERFIL_TRABAJADOR` / `CONSULTA_DOCUMENTOS` | `{ documentCount: number }`. `entityId` = id del perfil |
| `PERFIL_TRABAJADOR` / `VISUALIZACION_DOCUMENTO` o `DESCARGA_DOCUMENTO` | `{ documentId, documentType: WorkerDocumentType }`. `entityId` = id del perfil |
| `PERFIL_TRABAJADOR` / `CAMBIO_ESTADO` | `{ from, to, reason: string \| null }`. Lo genera la decisión administrativa (#55) |
| `PERFIL_TRABAJADOR` / `EDICION` | Reasignación de zona (#66, T4.4 y T4-F2): `{ operation: 'REASIGNACION_ZONA', workerUserId, profileStatus: 'RECHAZADO' \| 'OBSERVADO' \| 'PENDIENTE', fromZoneId, toZoneId, justification }`. `actor` = administrador; `createdAt` = fecha |

---

## Perfil del trabajador

### `WorkerProfileView`

| Propiedad | Tipo | Nullable | Calculado | Notas |
|---|---|---|---|---|
| `id` | string | no | | Id del perfil |
| `userId` | string | no | | Id de la cuenta |
| `status` | `WorkerProfileStatus` | no | | |
| `yearsOfExperience` | number | no | | |
| `description` | string | **sí** | | |
| `submittedAt` | string | **sí** | | Último envío a revisión |
| `createdAt`, `updatedAt` | string | no | | |
| `zone` | `CatalogRef` | no | | |
| `zoneRequiresChange` | boolean | no | ✔ | `!zone.isActive` |
| `specialties` | `CatalogRef[]` | no | | Ordenadas por nombre |
| `schedules` | `ScheduleView[]` | no | | Por día (LUNES→DOMINGO) y hora de inicio |
| `pendingRequirements` | `PendingRequirement[]` | no | ✔ | Lo que falta para enviar a revisión |
| `canEdit` | boolean | no | ✔ | Estado `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO` (afecta a datos, especialidades y documentos; **no** a los horarios ni a la zona fuera de `BORRADOR`) |
| `canSubmit` | boolean | no | ✔ | Estado `BORRADOR`, `OBSERVADO` o `RECHAZADO` y sin requisitos pendientes. En `SUSPENDIDO` es `false` aunque `canEdit` sea `true`: no puede enviarse a revisión (T4-F7) |

`ScheduleView`:

| Propiedad | Tipo |
|---|---|
| `id` | string |
| `dayOfWeek` | `WeekDay` |
| `startTime` | string `"HH:mm"` |
| `endTime` | string `"HH:mm"` (puede ser `"24:00"`) |
| `isActive` | boolean |

`PendingRequirement`:

| Propiedad | Tipo |
|---|---|
| `field` | `'phone' \| 'specialties' \| 'zone' \| 'schedules'` |
| `message` | string |

Condiciones de cada requisito:
- `phone`: la cuenta no tiene teléfono.
- `specialties`: hay especialidades inactivas o ninguna.
- `zone`: la zona está inactiva.
- `schedules`: no hay ningún horario activo.

```json
{
  "id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  "userId": "8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f",
  "status": "BORRADOR", "yearsOfExperience": 5, "description": null, "submittedAt": null,
  "createdAt": "2026-11-15T14:30:00.000Z", "updatedAt": "2026-11-15T14:30:00.000Z",
  "zone": { "id": "3f1d6c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", "name": "Norte", "isActive": true },
  "zoneRequiresChange": false,
  "specialties": [{ "id": "2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4", "name": "Plomería", "isActive": true }],
  "schedules": [{ "id": "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d", "dayOfWeek": "LUNES", "startTime": "08:00", "endTime": "12:00", "isActive": true }],
  "pendingRequirements": [{ "field": "phone", "message": "Registre un teléfono de contacto en su cuenta" }],
  "canEdit": true, "canSubmit": false
}
```

### `WorkerStatusView`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `status` | `WorkerProfileStatus` | no | |
| `statusReason` | string | **sí** | Motivo del cambio más reciente al estado vigente (observación, rechazo o suspensión). Tras un reenvío vuelve a `null` (el estado vigente es `PENDIENTE`); el motivo anterior sigue en `history` |
| `history` | `StatusHistoryEntry[]` | no | Más reciente primero |

`StatusHistoryEntry`:

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | string | no | |
| `fromStatus` | `WorkerProfileStatus` | **sí** | `null` en la creación |
| `toStatus` | `WorkerProfileStatus` | no | |
| `reason` | string | **sí** | |
| `createdAt` | string | no | |
| `changedBy` | `'TRABAJADOR' \| 'ADMINISTRADOR'` | no | Calculado: no expone quién fue el administrador |

### `WorkerEligibility`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `eligible` | boolean | no | `true` solo con cuenta `ACTIVO`, rol `TRABAJADOR` y perfil `APROBADO` |
| `status` | `WorkerProfileStatus` | **sí** | `null` si la cuenta no está activa, no tiene el rol o no tiene perfil |
| `message` | string | no | Texto para el usuario, por ejemplo `"Su perfil de trabajador está pendiente de revisión."` |
| `reason` | string | **sí** | Motivo registrado por el administrador para el estado vigente |
| `pendingZoneChangeRequest` | `{ id, toZone: CatalogRef, createdAt }` | **sí** | T4-F4: la solicitud de cambio de zona `PENDIENTE`, o `null` |
| `canTakeNewWork` | boolean | no | T4-F4: `eligible` y sin solicitud de cambio de zona pendiente. Con `false` y `eligible: true` puede ver pedidos (#52–#54) pero no ofertar ni recibir asignaciones nuevas (409) |

### `WorkerDocumentView`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | string | no | |
| `type` | `WorkerDocumentType` | no | |
| `originalName` | string | no | Nombre saneado (≤ 255) |
| `mimeType` | string | no | `application/pdf`, `image/jpeg` o `image/png`, detectado por el contenido |
| `sizeBytes` | number | no | |
| `uploadedAt` | string | no | |
| `replacedAt` | string | **sí** | Fecha en que fue reemplazado |
| `replacedById` | string | **sí** | Id del documento que lo reemplazó; `null` = **vigente** |

- Excluidos: `storageKey`, `sha256` y `profileId`.
- El listado incluye los vigentes y los reemplazados, ordenados por `type` y luego por `uploadedAt` descendente.

```json
{ "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a", "type": "IDENTIDAD", "originalName": "cedula.pdf", "mimeType": "application/pdf", "sizeBytes": 183402, "uploadedAt": "2026-11-15T14:35:00.000Z", "replacedAt": null, "replacedById": null }
```

---

## Revisión administrativa de perfiles

### `AdminWorkerProfileSummary` (fila del listado #56)

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | string | no | Id del perfil |
| `userId` | string | no | Id de la cuenta |
| `status` | `WorkerProfileStatus` | no | |
| `account` | `AdminAccountSummary` | no | `{ firstName, lastName, email, phone, status }`. `phone` puede ser `null`. **Sin** hash ni roles |
| `zone` | `CatalogRef` | no | |
| `specialties` | `CatalogRef[]` | no | Ordenadas por nombre |
| `submittedAt` | string | **sí** | Último envío a revisión; `null` si nunca se envió |
| `createdAt`, `updatedAt` | string | no | |

Orden: `submittedAt` ascendente (los nunca enviados al final) y luego `createdAt`. El perfil del propio administrador nunca aparece.

```json
{
  "data": [{
    "id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
    "userId": "8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f",
    "status": "PENDIENTE",
    "account": { "firstName": "Juan", "lastName": "Pérez", "email": "juan@example.com", "phone": "70000000", "status": "ACTIVO" },
    "zone": { "id": "3f1d6c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", "name": "Norte", "isActive": true },
    "specialties": [{ "id": "2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4", "name": "Plomería", "isActive": true }],
    "submittedAt": "2026-11-20T15:00:00.000Z",
    "createdAt": "2026-11-20T14:30:00.000Z",
    "updatedAt": "2026-11-20T15:00:00.000Z"
  }],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### `AdminWorkerProfileView` (detalle #57)

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `profile` | `WorkerProfileView` | no | El mismo modelo que ve el trabajador, incluidos `pendingRequirements`, que indican si se puede aprobar |
| `account` | `AdminAccountSummary` + `roles: RoleName[]` | no | Datos de contacto y estado de la cuenta |
| `statusReason` | string | **sí** | Motivo **privado** del cambio más reciente al estado vigente |
| `history` | `AdminStatusHistoryEntry[]` | no | Más reciente primero |
| `allowedDecisions` | `WorkerProfileStatus[]` | no | Calculado con `ADMIN_TRANSITIONS`: `PENDIENTE` → `[APROBADO, OBSERVADO, RECHAZADO]`; `APROBADO` → `[SUSPENDIDO]`; `SUSPENDIDO` → `[APROBADO]`; los demás → `[]` |

`AdminStatusHistoryEntry` = `StatusHistoryEntry` (ver arriba) más `changedByUser: { id, firstName, lastName }`, que muestra quién hizo el cambio. Esa identidad solo la ve el administrador; el trabajador solo ve `changedBy`.

**No incluye los documentos:** se consultan con #58–#60, que dejan registro en la bitácora.

---

## Zona y solicitudes de cambio

### `ZoneStatusView`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `currentZone` | `CatalogRef` | no | |
| `zoneRequiresChange` | boolean | no | La zona actual está inactiva |
| `pendingRequest` | `ZoneChangeRequestView` | **sí** | |
| `canRequestChange` | boolean | no | `blockers.length === 0` |
| `blockers` | `ZoneChangeBlocker[]` | no | `{ code, message }` |

Valores de `code`:
- `PERFIL_EN_BORRADOR`
- `ESTADO_NO_PERMITIDO`
- `SOLICITUD_PENDIENTE`
- `TRABAJO_ACTIVO`
- `VERIFICACION_NO_DISPONIBLE`: hoy aparece siempre (ver 01, #36).

### `ZoneChangeRequestView`

| Propiedad | Tipo | Nullable |
|---|---|---|
| `id` | string | no |
| `status` | `ZoneChangeRequestStatus` | no |
| `reason` | string | no |
| `fromZone` | `CatalogRef` | no |
| `toZone` | `CatalogRef` | no |
| `createdAt` | string | no |
| `decidedAt` | string | **sí** |
| `decisionComment` | string | **sí** (en la entrada se llama `comment`). Siempre presente en `RECHAZADA`; `null` en `CANCELADA` |
| `cancellationCause` | `ZoneChangeCancellationCause` | **sí**. Solo en `CANCELADA`: `SUSPENSION_PERFIL` (T4.2; `decidedBy` es el administrador que suspendió el perfil), `SUSPENSION_CUENTA` (T4-F3; `decidedBy` es el administrador que suspendió la cuenta) o `RETIRO_TRABAJADOR` (T4.3; `decidedBy` es el propio trabajador). `decidedAt` es la fecha de la cancelación. En `AdminZoneChangeRequestView`, `decidedBy` puede ser entonces el trabajador |

### `AdminZoneChangeRequestView` (extiende `ZoneChangeRequestView`)

| Propiedad | Tipo | Nullable |
|---|---|---|
| `worker.userId` | string | no |
| `worker.profileId` | string | no |
| `worker.firstName` | string | no |
| `worker.lastName` | string | no |
| `worker.email` | string | no |
| `worker.phone` | string | **sí** |
| `worker.accountStatus` | `UserStatus` | no |
| `worker.profileStatus` | `WorkerProfileStatus` | no |
| `worker.currentZone` | `CatalogRef` | no |
| `decidedBy` | `{ id, firstName, lastName }` | **sí** |

### `AffectedProfile`

| Propiedad | Tipo | Notas |
|---|---|---|
| `profileId` | string | |
| `userId` | string | |
| `status` | `WorkerProfileStatus` | |
| `zone` | `{ id, name }` | **Sin** `isActive`: siempre es una zona inactiva |
| `hasPendingZoneChangeRequest` | boolean | |

---

## Pedidos

### `OrderImageView`

| Propiedad | Tipo | Notas |
|---|---|---|
| `id` | string | Se usa en las rutas de descarga y edición |
| `position` | number | 1, 2, 3…; el arreglo viene ordenado por `position` |
| `width`, `height` | number | De la versión `full` (máximo 1600 px de lado) |
| `sizeBytes` | number | Tamaño de `full` |
| `thumbnailSizeBytes` | number | Tamaño de `thumb` |

Excluidos: `storageKey`, `thumbnailKey`, `sha256` y `mimeType` (siempre `image/webp`).

### `WorkerOrderView` (trabajador aprobado)

| Propiedad | Tipo | Nullable | Calculado | Notas |
|---|---|---|---|---|
| `id` | string | no | | |
| `status` | `OrderStatus` | no | ✔ | **Estado efectivo**: un `PUBLICADO` con el plazo cumplido llega como `VENCIDO` |
| `category` | `CatalogRef` | no | | |
| `zone` | `CatalogRef` | no | | |
| `description` | string | no | | |
| `budgetAmount` | string | no | ✔ | 2 decimales (`"150.50"`) |
| `images` | `OrderImageView[]` | no | | |
| `revision` | number | no | | Sube con cada edición efectiva |
| `publishedAt` | string | no | | Fecha de publicación original. No cambia al editar ni al cambiar de estado |
| `expiresAt` | string | no | | `publishedAt` + 7 días calendario (T5.1). Nunca se reinicia |
| `lastEditedAt` | string | **sí** | | |

Excluidos para el trabajador:
- La dirección.
- `clientId` y cualquier dato del cliente.
- `createdAt`, `updatedAt` y `cancelledAt`.
- `assignedWorkerId`.

### `OwnerOrderView` (cliente dueño; extiende `WorkerOrderView`)

| Propiedad | Tipo | Nullable | Calculado | Notas |
|---|---|---|---|---|
| `address` | `{ addressLine: string, reference: string \| null }` | **sí** | | Dato privado. `null` si el pedido se limpió al vencer o cancelarse (T5.4) |
| `cancelledAt` | string | **sí** | | |
| `anonymizedAt` | string | **sí** | | T5.4: cuándo se limpió el pedido (sin dirección ni fotos, descripción "Descripción no disponible por cierre del pedido.") |
| `createdAt`, `updatedAt` | string | no | | |
| `canEdit` | boolean | no | ✔ | Estado efectivo `PUBLICADO` o `EN_NEGOCIACION` |
| `canCancel` | boolean | no | ✔ | Igual que `canEdit` |

Tampoco expone `clientId` ni `assignedWorkerId`. Un pedido vencido o cancelado sin acuerdo se devuelve con `images: []`, `address: null` y la descripción fija (T5.4).

### `AssignedOrderView` (#80; extiende `WorkerOrderView`)

Para el trabajador **asignado** mientras el acuerdo sigue vigente (G2, T6.7).

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `address` | `{ addressLine: string, reference: string \| null }` | **sí** | Dirección exacta (adenda §2.2) |
| `client` | `{ firstName: string, lastName: string }` | no | Sin correo ni teléfono (el contacto es por WhatsApp, #79) |

No incluye `clientId`, `assignedWorkerId` ni datos de la oferta (están en #71).

### `AdminOrderSummary` (#67) y `AdminOrderView` (#68)

Registro mínimo para administradores (T5.4). **Nunca** incluye la dirección, las fotos ni la descripción.

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id`, `clientId` | string | no | |
| `status` | `OrderStatus` | no | Estado efectivo |
| `category`, `zone` | `CatalogRef` | no | |
| `budgetAmount` | string | no | 2 decimales |
| `revision` | number | no | |
| `publishedAt`, `expiresAt`, `createdAt`, `updatedAt` | string | no | |
| `lastEditedAt`, `cancelledAt`, `anonymizedAt` | string | **sí** | |
| `client` | `{ id, firstName, lastName }` | **sí** | `null` si el pedido fue anonimizado |
| `assignedWorkerId` | string | **sí** | |
| `imageCount` | number | no | Fotos vigentes |
| `history` (solo #68) | `{ fromStatus, toStatus, actorType, changedById, actorRole, systemProcess, reason, createdAt }[]` | no | Más antiguo primero. `reason` es `null` si el pedido fue anonimizado |

```json
{
  "id": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b",
  "status": "PUBLICADO",
  "category": { "id": "2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4", "name": "Plomería", "isActive": true },
  "zone": { "id": "3f1d6c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", "name": "Norte", "isActive": true },
  "description": "Fuga de agua debajo del lavaplatos de la cocina",
  "budgetAmount": "150.50",
  "images": [{ "id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c", "position": 1, "width": 1600, "height": 1067, "sizeBytes": 98213, "thumbnailSizeBytes": 12044 }],
  "revision": 1,
  "publishedAt": "2026-11-15T14:40:00.000Z",
  "expiresAt": "2026-11-17T14:40:00.000Z",
  "lastEditedAt": null,
  "address": { "addressLine": "Av. Ejemplo 123", "reference": "Portón verde" },
  "cancelledAt": null,
  "createdAt": "2026-11-15T14:40:00.000Z",
  "updatedAt": "2026-11-15T14:40:00.000Z",
  "canEdit": true,
  "canCancel": true
}
```

### `OrderWarning`

| Propiedad | Tipo | Notas |
|---|---|---|
| `code` | `'POSIBLE_DUPLICADO' \| 'POSIBLE_DATO_PERSONAL'` | |
| `message` | string | Texto para el usuario |
| `orderIds` | string[] | **Solo** en `POSIBLE_DUPLICADO`; la propiedad no existe en el otro código |

Son avisos orientativos: **nunca** bloquean.

### `OrderWithWarnings`

| Propiedad | Tipo |
|---|---|
| `order` | `OwnerOrderView` |
| `warnings` | `OrderWarning[]` (puede ser `[]`) |

Al editar (#47) los avisos solo se calculan si cambió la descripción; si no, `warnings: []`.

### `DuplicateCheckResponse`

```json
{ "warnings": [{ "code": "POSIBLE_DUPLICADO", "message": "Ya tiene un pedido activo muy parecido…", "orderIds": ["e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a8b"] }] }
```

---

## Ofertas

### `OfferView` (#70, y base de los demás)

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id`, `orderId` | string | no | |
| `status` | `OfferStatus` | no | **Estado efectivo**: una `VIGENTE` con `expiresAt` cumplido se devuelve `VENCIDA` |
| `round` | number | no | 1 (propuesta), 2 o 3 (contraofertas) |
| `amount` | string | no | Monto vigente, 2 decimales |
| `turn` | `OfferParty` | no | Quién debe responder |
| `requiresVisit` | boolean | no | |
| `visitCost` | string | **sí** | `null` sin visita; `"0.00"` visita gratis |
| `materialsIncluded` | boolean | no | |
| `proposedStartAt` | string | no | Inicio propuesto (UTC) |
| `estimatedDurationMinutes` | number | no | |
| `expiresAt` | string | no | Vigencia: 24 h desde la última propuesta o contraoferta |
| `closedAt` | string | **sí** | `null` mientras está `VIGENTE` |
| `createdAt`, `updatedAt` | string | no | |

No incluye el id del trabajador, datos del cliente, la dirección, fotos ni teléfonos.

### `ReceivedOfferView` (#72; extiende `OfferView`)

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `worker` | `{ id: string, firstName: string, lastName: string }` | no | Sin correo ni teléfono |

### `OfferDetail<T>` (`T` más `history`)

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `history` | `OfferEventView[]` | no | RF-21: del más antiguo al más reciente; nunca se modifica |

### `OfferEventView`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `type` | `OfferEventType` | no | |
| `round` | number | no | |
| `amount` | string | **sí** | Solo en `PROPUESTA` y `CONTRAOFERTA` |
| `actorType` | `OrderActorType` | no | `USUARIO` o `SISTEMA`. El id del usuario **no** se expone (G4): el autor se identifica por `actorRole`; la BD lo conserva para auditoría |
| `actorRole` | `RoleName` | **sí** | `CLIENTE` o `TRABAJADOR`; `null` si fue el sistema |
| `systemProcess` | string | **sí** | `VENCIMIENTO_OFERTA`, `ACEPTACION_OFERTA` o `CIERRE_OFERTAS` |
| `reason` | string | **sí** | Motivo de los cierres del sistema (ver 04) |
| `createdAt` | string | no | |

### `WhatsAppContact` (#78, #79)

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `available` | boolean | no | `false`: ocultar o deshabilitar el botón |
| `channel` | `"WHATSAPP"` | no | |
| `contactRole` | `"CLIENTE"` o `"TRABAJADOR"` | no | A quién se contacta |
| `url` | string | **sí** | `https://wa.me/<dígitos>?text=<mensaje codificado>`; `null` si `available: false` |
| `reason` | `"TELEFONO_NO_REGISTRADO"` o `"TELEFONO_INVALIDO"` | — | **Solo** cuando `available: false` |

El teléfono nunca viene por separado. Abrir el enlace no envía ni registra nada (ver [`src/modules/offers/README.md`](../../src/modules/offers/README.md)).

---

## Notificaciones

### `NotificationView`

| Propiedad | Tipo | Nullable | Notas |
|---|---|---|---|
| `id` | string | no | |
| `type` | `NotificationType` | no | Ver 04 |
| `title` | string | no | ≤ 150 caracteres, en español, listo para mostrar |
| `message` | string | no | ≤ 2000 caracteres. En las decisiones incluye `Motivo: …` (o `Comentario: …` al aprobar o reactivar si lo hubo) |
| `resourceType` | `NotificationResourceType` | **sí** | `PERFIL_TRABAJADOR` o `SOLICITUD_CAMBIO_ZONA`. Si viene, también viene `resourceId` |
| `resourceId` | string | **sí** | Id del perfil (el administrador lo abre con #57; el trabajador, con `/me`) o de la solicitud de cambio de zona (el trabajador la ve en #37) |
| `readAt` | string | **sí** | `null` = no leída |
| `createdAt` | string | no | Orden del listado: más reciente primero |

No incluye `userId`. La lista usa `Paginated<T>` (`{ data, meta: { page, limit, total, totalPages } }`).

---

## Respuestas binarias

| Endpoint | Content-Type | Content-Disposition | Otros headers |
|---|---|---|---|
| #34 descarga de documento | El `mimeType` del documento | `attachment; filename="<ascii>"; filename*=UTF-8''<utf8>` | `Content-Length`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` |
| #59 ver documento (admin) | El `mimeType` del documento | `inline; filename="<ascii>"; filename*=UTF-8''<utf8>` | Los mismos |
| #60 descargar documento (admin) | El `mimeType` del documento | `attachment; …` (igual que #34) | Los mismos |
| #46, #54 fotos de pedido | `image/webp` | `inline` | Los mismos |

Desde Angular, `Content-Disposition` **no es legible**: CORS no expone headers. Ver [06](06-file-contracts.md).
