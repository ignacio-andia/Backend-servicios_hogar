# 02. DTOs de entrada

Se documentan los **28 DTOs** que recibe la API por HTTP. `CreateUserDto` es interno (lo usa AuthModule) y no se recibe por HTTP.

## Columna "Omitir / null"

| Valor | Significado |
|---|---|
| **Obligatoria** | No se puede omitir ni enviar `null` |
| **Omitible, admite null** | `@IsOptional()`: se puede omitir o enviar `null` |
| **Omitible, no admite null** | `@ValidateIf(v !== undefined)`: se puede omitir, pero `null` responde 400 |

## Reglas globales

- Toda propiedad no declarada responde 400 (`property X should not exist`).
- `@Trim()` recorta los espacios antes de validar: `"  hola "` llega como `"hola"`.
- En multipart todos los campos de texto llegan como strings.
- Los query params se convierten con `@Type(() => Number)` o con un parser propio de booleanos (`"true"`/`"false"`).
- Los parámetros de ruta `:id`, `:orderId`, `:imageId`, `:documentId` y `:requestId` deben ser UUID (`ParseUUIDPipe`); si no, responden 400 `"Validation failed (uuid is expected)"`.

---

## AuthModule

### `RegisterDto`: `POST /api/auth/register` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Validadores y transformaciones | Reglas de negocio |
|---|---|---|---|---|---|
| `firstName` | string | Obligatoria | 1 a 100 caracteres después de recortar | `@Trim @IsString @IsNotEmpty @MaxLength(100)` | — |
| `lastName` | string | Obligatoria | 1 a 100 | ídem | — |
| `email` | string | Obligatoria | email válido, ≤ 255 | `@Trim @IsEmail @MaxLength(255)` | Se guarda en minúsculas; 409 si ya existe |
| `password` | string | Obligatoria | ≥ 8 caracteres, ≤ 72 **bytes**, al menos una letra y un número | `@IsString @MinLength(8) @IsByteLength(0,72) @Matches(/(?=.*\p{L})(?=.*\d)/u)` | Sin `@Trim` (los espacios cuentan) |
| `phone` | string | Omitible, admite null. `""` o solo espacios se tratan como **ausente** | `^\+?[1-9]\d{6,14}$` (7 a 15 dígitos, `+` opcional, sin espacios ni guiones) | `@TrimEmptyAs(undefined) @IsOptional @Matches` | Si no se envía un valor válido, se guarda `null`. Es necesario para enviar el perfil de trabajador a revisión |

No se aceptan `roles` ni `status`: el registro siempre crea una cuenta `CLIENTE` y `ACTIVO`.

```json
{ "firstName": "Ana", "lastName": "Pérez", "email": "ana@example.com", "password": "Clave1234", "phone": "70000000" }
```

También es válido sin teléfono, o con `"phone": ""` o `"phone": "   "`: el usuario se registra con `phone: null`.

Ejemplos inválidos:
- `{ "password": "abcdefgh" }`: no tiene número y faltan campos.
- `{ ..., "roles": ["ADMINISTRADOR"] }`: 400 `property roles should not exist`.
- `{ ..., "confirmPassword": "Clave1234" }`: 400 `property confirmPassword should not exist`.
- `{ ..., "phone": "7000-0000" }`: 400 (el teléfono no admite separadores).

> **Angular no debe enviar `confirmPassword`** ni ningún otro campo propio del formulario. La confirmación de contraseña se valida solo en el cliente y se quita del objeto antes del `POST`.

### `LoginDto`: `POST /api/auth/login` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Validadores |
|---|---|---|---|---|
| `email` | string | Obligatoria | email, ≤ 255 | `@Trim @IsEmail @MaxLength(255)` (se compara en minúsculas) |
| `password` | string | Obligatoria | 1 a 255 | `@IsString @IsNotEmpty @MaxLength(255)` |

```json
{ "email": "ana@example.com", "password": "Clave1234" }
```

---

## UsersModule

### `ListUsersQueryDto`: `GET /api/users` (query)

| Propiedad | Tipo | Omitir | Restricciones | Validadores |
|---|---|---|---|---|
| `page` | number | Omitible (por defecto 1) | entero ≥ 1 | `@Type(Number) @IsInt @Min(1)` |
| `limit` | number | Omitible (por defecto 20) | entero de 1 a 100 | `@Type(Number) @IsInt @Min(1) @Max(100)` |

No hay filtros ni búsqueda.

### `UpdateUserDto`: `PATCH /api/users/:id` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Validadores | Reglas |
|---|---|---|---|---|---|
| `firstName` | string | Omitible, **no admite null** | 1 a 100 | `@Trim @ValidateIf(!==undefined) @IsString @IsNotEmpty @MaxLength(100)` | — |
| `lastName` | string | Omitible, **no admite null** | 1 a 100 | ídem | — |
| `phone` | string \| null | Omitible, **admite null** | patrón de teléfono | `@TrimEmptyAs(null) @IsOptional @Matches` | `null`, `""` o solo espacios **borran** el teléfono (se guarda `null`). Si se omite, no cambia |

Hay que enviar al menos una propiedad (400 si no). `email`, `roles`, `status` y la contraseña **no** se pueden modificar: 400.

```json
{ "phone": null }
```

`{ "phone": "" }` tiene el mismo efecto. `{ "lastName": "Rojas" }` no modifica el teléfono.

### `UpdateUserStatusDto`: `PATCH /api/users/:id/status` (JSON)

| Propiedad | Tipo | Omitir / null | Valores | Reglas |
|---|---|---|---|---|
| `status` | `UserStatus` | Obligatoria | `ACTIVO`, `INACTIVO`, `SUSPENDIDO` | Un usuario no admin solo puede enviar `INACTIVO` sobre su propia cuenta. No se puede dejar la plataforma sin administradores activos. `SUSPENDIDO` cancela la solicitud de cambio de zona pendiente (T4-F3); `INACTIVO` no |

---

## CatalogsModule

### `CreateCatalogItemDto`: `POST /api/catalogs/{categories|zones}` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Validadores | Reglas |
|---|---|---|---|---|---|
| `name` | string | Obligatoria | 2 a 100 | `@Trim @IsString @IsNotEmpty @MinLength(2) @MaxLength(100)` | Se compactan los espacios internos; único sin distinguir mayúsculas (409) |
| `description` | string | Omitible, admite null | ≤ 500 | `@Trim @IsOptional @IsString @MaxLength(500)` | `""` o `null` se guardan como `null` |

```json
{ "name": "Carpintería", "description": "Muebles y puertas" }
```

### `UpdateCatalogItemDto`: `PATCH /api/catalogs/{categories|zones}/:id` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Reglas |
|---|---|---|---|---|
| `name` | string | Omitible, **no admite null** | 2 a 100 | único (409) |
| `description` | string \| null | Omitible, admite null | ≤ 500 | `null` o `""` borra la descripción |

Hay que enviar al menos una propiedad (400). Si no hay cambios reales, responde 200 con el registro sin modificarlo. `isActive` no se acepta: se desactiva con su endpoint propio.

### `ListCatalogQueryDto`: `GET /api/catalogs/admin/{categories|zones}` (query)

| Propiedad | Tipo | Omitir | Valores |
|---|---|---|---|
| `isActive` | boolean | Omitible (sin valor devuelve activos e inactivos) | `"true"` o `"false"`; cualquier otro valor responde 400 `"isActive debe ser true o false"` |

---

## AuditModule

### `ListAuditLogsQueryDto`: `GET /api/audit-logs` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `entityType` | `AuditEntityType` | Omitible | `CATEGORIA_SERVICIO`, `ZONA`, `PERFIL_TRABAJADOR`, `SOLICITUD_CAMBIO_ZONA` |
| `action` | `AuditAction` | Omitible | `CREACION`, `EDICION`, `DESACTIVACION`, `CAMBIO_ESTADO`, `APROBACION`, `RECHAZO` |
| `actorId` | string | Omitible | UUID del administrador |
| `entityId` | string | Omitible | UUID del registro afectado |
| `from` | string | Omitible | ISO 8601 estricto. Una fecha sin hora (`2026-11-01`) se interpreta en UTC; es inclusiva |
| `to` | string | Omitible | ISO 8601. Una fecha sin hora incluye **todo ese día** (UTC); con hora es inclusiva |
| `page` | number | Omitible (1) | ≥ 1 |
| `limit` | number | Omitible (20) | 1 a 100 |

`from` posterior a `to` responde 400.

---

## WorkerProfileModule

### `ScheduleItemDto` (elemento de `schedules[]`)

| Propiedad | Tipo | Omitir / null | Restricciones |
|---|---|---|---|
| `dayOfWeek` | `WeekDay` | Obligatoria | `LUNES` … `DOMINGO` |
| `startTime` | string | Obligatoria | `HH:mm` (`00:00`–`23:59`; el patrón también admite `24:00`) |
| `endTime` | string | Obligatoria | `HH:mm` o `24:00` |
| `isActive` | boolean | Omitible, admite null (por defecto `true`) | — |

**Reglas del service** (400 con un **arreglo** de problemas):
- El fin debe ser posterior al inicio.
- Los intervalos del mismo día no pueden superponerse, estén activos o no.

Máximo 50 elementos.

### `CreateWorkerProfileDto`: `POST /api/worker-profile` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Validadores | Reglas |
|---|---|---|---|---|---|
| `yearsOfExperience` | number | Obligatoria | entero de 0 a 70 | `@IsInt @Min(0) @Max(70)` | En JSON debe ser un número; `"5"` responde 400 |
| `description` | string | Omitible, admite null | ≤ 1000 | `@Trim @IsOptional @IsString @MaxLength(1000)` | `""` se guarda como `null` |
| `zoneId` | string | Obligatoria | UUID | `@IsUUID` | 404 si no existe, 400 si está inactiva |
| `categoryIds` | string[] | Obligatoria | 1 a 10 UUID únicos | `@IsArray @ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique @IsUUID('all',{each})` | 400 (arreglo) si alguna no existe o está inactiva |
| `schedules` | `ScheduleItemDto[]` | Omitible, admite null | ≤ 50 | `@IsOptional @IsArray @ValidateNested @Type` | Ver reglas de horarios |

Nombre, correo y teléfono **no** van aquí: son de la cuenta (UsersModule). `status` no se acepta.

```json
{
  "yearsOfExperience": 5,
  "description": "Plomero con experiencia en instalaciones sanitarias",
  "zoneId": "3f1d6c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
  "categoryIds": ["2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4"],
  "schedules": [{ "dayOfWeek": "LUNES", "startTime": "08:00", "endTime": "12:00" }]
}
```

Ejemplo inválido: `"schedules": [{ "dayOfWeek": "LUNES", "startTime": "10:00", "endTime": "09:00" }]` → 400 `["Horario 1 (LUNES): la hora de fin debe ser posterior a la de inicio"]`.

### `UpdateWorkerProfileDto`: `PATCH /api/worker-profile/me` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Reglas |
|---|---|---|---|---|
| `yearsOfExperience` | number | Omitible, **no admite null** | 0 a 70 | — |
| `description` | string \| null | Omitible, admite null | ≤ 1000 | `null` o `""` borra la descripción |
| `zoneId` | string | Omitible, **no admite null** | UUID | Solo se puede **cambiar** en `BORRADOR` (403 en otro estado); enviar la misma zona no cuenta como cambio |

Hay que enviar al menos una propiedad (400). El perfil debe estar en `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO` (409). En `RECHAZADO` y `SUSPENDIDO` se corrigen los datos, pero la zona sigue fija (403), igual que en `OBSERVADO`. Editar no cambia el estado: un perfil `SUSPENDIDO` sigue suspendido (T4-F7).

### `UpdateSpecialtiesDto`: `PUT /api/worker-profile/me/specialties` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones |
|---|---|---|---|
| `categoryIds` | string[] | Obligatoria | 1 a 10 UUID únicos, todos existentes y activos. **Reemplaza** el conjunto completo |

### `UpdateSchedulesDto`: `PUT /api/worker-profile/me/schedules` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones |
|---|---|---|---|
| `schedules` | `ScheduleItemDto[]` | Obligatoria | 0 a 50 elementos. **Reemplaza** el conjunto completo; `[]` borra todos los horarios. Se permite en cualquier estado del perfil |

### `UploadDocumentDto`: `POST /api/worker-profile/me/documents` (multipart)

| Campo multipart | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `type` | `WorkerDocumentType` (texto) | Obligatorio | `IDENTIDAD`, `ANTECEDENTES`, `CERTIFICADO`, `REFERENCIA` |
| `file` | archivo | Obligatorio (400 si falta o está vacío) | PDF, JPG o PNG; 5 MB por defecto. Ver [06](06-file-contracts.md) |

El reemplazo (`POST …/documents/:documentId/replace`) solo usa el campo `file`: el controller no declara `@Body()`, así que los campos de texto no se validan y se ignoran. El tipo del documento nuevo se copia del documento reemplazado. Envíe solo `file`.

En la subida (`POST …/documents`), en cambio, sí hay DTO: un campo de texto distinto de `type` responde 400.

### `CreateZoneChangeRequestDto`: `POST /api/worker-profile/me/zone-change-requests` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Reglas |
|---|---|---|---|---|
| `toZoneId` | string | Obligatoria | UUID | Distinta de la actual (400); activa (400; 404 si no existe) |
| `reason` | string | Obligatoria | 5 a 500 después de recortar | — |

```json
{ "toZoneId": "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", "reason": "Me mudé a la zona sur" }
```

`POST /api/worker-profile/me/zone-change-requests/:requestId/withdraw` (retiro, T4.3) no lleva cuerpo.

### `DecideZoneChangeRequestDto`: `PATCH /api/worker-profile/admin/zone-change-requests/:requestId` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Reglas |
|---|---|---|---|---|
| `decision` | `'APROBADA' \| 'RECHAZADA'` | Obligatoria | Solo esos dos valores (`PENDIENTE` responde 400) | — |
| `comment` | string | Omitible al aprobar; **obligatorio al rechazar** (T4.2, especificación v1.0 §4) | ≤ 500 después de recortar | Al rechazar, ausente, `null`, `""` o solo espacios responden 400 `"Debe indicar el motivo del rechazo"`. Es el motivo que recibe el trabajador en su notificación |

### `ListZoneChangeRequestsQueryDto`: `GET /api/worker-profile/admin/zone-change-requests` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `status` | `ZoneChangeRequestStatus` | Omitible | `PENDIENTE`, `APROBADA`, `RECHAZADA`, `CANCELADA` |
| `resolved` | boolean | Omitible | `"true"`: solo resueltas; `"false"`: solo pendientes. Se combina con `status` mediante AND |
| `workerUserId` | string | Omitible | UUID de la **cuenta** del trabajador |
| `page` / `limit` | number | Omitibles (1 / 20) | `limit` ≤ 100 |

### `ListAdminWorkerProfilesQueryDto`: `GET /api/worker-profile/admin/profiles` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `status` | `WorkerProfileStatus` | Omitible (sin valor: todos los estados) | Uno de los 6 valores; por ejemplo `PENDIENTE` para la cola de revisión |
| `zoneId` | string | Omitible | UUID de la zona del perfil |
| `categoryId` | string | Omitible | UUID: perfiles que tienen esa especialidad |
| `page` | number | Omitible (1) | ≥ 1 |
| `limit` | number | Omitible (20) | 1 a 100 |

Cualquier otro parámetro responde 400.

### `ChangeWorkerProfileStatusDto`: `PATCH /api/worker-profile/admin/profiles/:profileId/status` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Validadores | Reglas de negocio |
|---|---|---|---|---|---|
| `status` | `'APROBADO' \| 'OBSERVADO' \| 'RECHAZADO' \| 'SUSPENDIDO'` | Obligatoria | Solo esos cuatro valores (400 con `PENDIENTE`, `BORRADOR` u otro) | `@IsIn(ADMIN_TARGET_STATUSES)` | La transición debe estar permitida desde el estado actual (ver 04); si no, 409 |
| `reason` | string | **Obligatoria** para `OBSERVADO`, `RECHAZADO` y `SUSPENDIDO`; omitible al aprobar. **No admite null** | 1 a 1000 después de recortar; `""` o solo espacios responden 400 | `@Trim @ValidateIf(exige motivo \|\| enviado) @IsString @IsNotEmpty @MaxLength(1000)` | Es el motivo privado que ve el trabajador (`statusReason`); queda en el historial y en la bitácora |

No se envía el id del administrador: sale del token. Cualquier propiedad extra (por ejemplo `adminId`) responde 400.

```json
{ "status": "OBSERVADO", "reason": "Suba una foto legible de su cédula" }
```

```json
{ "status": "APROBADO" }
```

Ejemplos inválidos:
- `{ "status": "RECHAZADO" }` o `{ "status": "RECHAZADO", "reason": "   " }`: 400, falta el motivo.
- `{ "status": "PENDIENTE" }`: 400, estado no permitido.

### `ReassignRejectedProfileZoneDto`: `PATCH /api/worker-profile/admin/profiles/:profileId/zone` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Reglas |
|---|---|---|---|---|
| `zoneId` | string | **Obligatoria** | UUID | Debe existir (404), estar activa (400) y ser distinta de la zona actual (400) |
| `justification` | string | **Obligatoria**, no admite null | 1 a 500 después de recortar; `""` o solo espacios responden 400 | Queda en la bitácora; no se envía al trabajador |

No acepta otras propiedades (400): la operación no cambia el estado ni otros datos del perfil. Solo para perfiles `RECHAZADO`, `OBSERVADO`, `PENDIENTE` o `SUSPENDIDO` cuya zona actual está inactiva (T4.4, T4-F2 y T4-F7). El perfil conserva su estado.

### `ListInactiveZoneProfilesQueryDto`: `GET /api/worker-profile/admin/inactive-zone-profiles` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `zoneId` | string | Omitible | UUID. Limita el resultado a una zona inactiva concreta |

---

## OrdersModule

### `CreateOrderDto`: `POST /api/orders` (multipart)

| Campo multipart | Tipo | Omitir | Restricciones | Validadores y transformaciones | Reglas |
|---|---|---|---|---|---|
| `categoryId` | string | Obligatorio | UUID | `@IsUUID` | 404 si no existe; 400 si está inactiva |
| `zoneId` | string | Obligatorio | UUID | `@IsUUID` | 404 o 400, igual que la categoría |
| `description` | string | Obligatorio | 10 a 2000 después de recortar | `@Trim @IsString @MinLength(10) @MaxLength(2000)` | Aviso `POSIBLE_DATO_PERSONAL` si parece contener un teléfono o un correo (no bloquea) |
| `budgetAmount` | string | Obligatorio | `^(?!0+(?:\.0{1,2})?$)\d{1,8}(?:\.\d{1,2})?$`: mayor que 0, hasta 8 enteros y 2 decimales, punto decimal | `@Transform(número→string) @IsString @Matches` | Se devuelve con 2 decimales (`"150.50"`) |
| `addressLine` | string | Obligatorio | 1 a 255 | `@Trim @IsString @IsNotEmpty @MaxLength(255)` | Dato privado: solo lo ve el dueño |
| `addressReference` | string | Omitible | ≤ 255 | `@Trim @IsOptional @IsString @MaxLength(255)` | Ver la inconsistencia en 09: `""` se guarda como `""` |
| `images` | archivo(s) | Obligatorio | 1 a 4 fotos (T5.3; el máximo de 4 es fijo) | multer | Ver [06](06-file-contracts.md) |

Ejemplos inválidos de `budgetAmount`: `"0"`, `"0.00"`, `"-5"`, `"150,50"`, `"1.234"`, `"123456789"`.

### `DuplicateCheckDto`: `POST /api/orders/duplicate-check` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones |
|---|---|---|---|
| `categoryId` | string | Obligatoria | UUID (no se verifica que exista) |
| `zoneId` | string | Obligatoria | UUID |
| `description` | string | Obligatoria | 10 a 2000 |

### `UpdateOrderDto`: `PATCH /api/orders/me/:orderId` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Reglas |
|---|---|---|---|---|
| `categoryId` | string | Omitible, **no admite null** | UUID | T5.2: debe existir (404) y estar activa (400). Se valida con un bloqueo compartido dentro de la edición. El pedido pasa a ser visible para los trabajadores de la nueva categoría y deja de serlo para los de la anterior |
| `description` | string | Omitible, **no admite null** | 10 a 2000 | — |
| `budgetAmount` | string (o número JSON) | Omitible, **no admite null** | mismo patrón que al crear | `"150.5"` y `"150.50"` son el mismo valor: no cuenta como cambio |
| `addressLine` | string | Omitible, **no admite null** | 1 a 255 | — |
| `addressReference` | string \| null | Omitible, admite null | ≤ 255 | `null` o `""` borra la referencia |

- Hay que enviar al menos una propiedad (400).
- `zoneId` **no** se puede editar (400): para otra zona se cancela el pedido (#51) y se crea uno nuevo.
- Tampoco se aceptan `status`, `clientId`, `id`, `publishedAt`, `expiresAt`, `revision`, `assignedWorkerId` ni otros campos internos: cualquier propiedad no declarada responde 400 y no se modifica nada.
- Editar no cambia el estado, la asignación ni las ofertas existentes, que siguen vigentes (T5.2); solo avisa a los módulos registrados con el evento `EDITADO` y la nueva `revision`.
- Si no hay cambios reales, responde 200 sin subir la revisión.
- Todo cambio real sube `revision` y actualiza `lastEditedAt`. **No cambia** `publishedAt` ni `expiresAt` (T5.1): el pedido vence igual a los 7 días de su publicación.

```json
{ "budgetAmount": "200", "addressReference": null }
```

### `CancelOrderDto`: `POST /api/orders/me/:orderId/cancel` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones |
|---|---|---|---|
| `reason` | string | Omitible, admite null | ≤ 500. `""` se guarda como `null` |

### `ListOwnOrdersQueryDto`: `GET /api/orders/me` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `status` | `OrderStatus` | Omitible | Cualquiera de los 13 valores. Se filtra por **estado efectivo** |
| `page` | number | Omitible (1) | ≥ 1 |
| `limit` | number | Omitible (20) | 1 a 50 |

### `ListAvailableOrdersQueryDto`: `GET /api/orders/available` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `categoryId` | string | Omitible | UUID. Si no es una especialidad del trabajador, el resultado queda vacío |
| `page` / `limit` | number | Omitibles (1 / 20) | `limit` ≤ 50 |

### `ImageVariantQueryDto`: descargas de fotos (query)

| Propiedad | Tipo | Omitir | Valores |
|---|---|---|---|
| `variant` | `'full' \| 'thumb'` | Omitible (`full`) | Otro valor responde 400 `"variant debe ser full o thumb"` |

---

## OffersModule

### `CreateOfferDto`: `POST /api/offers/orders/:orderId` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones |
|---|---|---|---|
| `amount` | string (o number) | Obligatorio | Mayor que 0, hasta 8 dígitos enteros y 2 decimales |
| `requiresVisit` | boolean | Obligatorio | RF-24: `true` = "Requiere visita"; `false` = "Cotización por fotos" |
| `visitCost` | string (o number) | **Obligatorio** si `requiresVisit`; **prohibido** si no (400) | 0 o mayor (`"0"` = visita gratis), hasta 8 dígitos enteros y 2 decimales |
| `materialsIncluded` | boolean | Obligatorio | |
| `proposedStartAt` | string | Obligatorio | ISO 8601 con fecha, hora y **zona horaria explícita** (`Z` o `±hh:mm`), y **futuro** (reloj de la BD). Válidos: `2026-11-30T10:00:00-04:00`, `2026-11-30T14:00:00Z`, `2026-11-30T14:00:00.000Z`. Inválidos (400): `2026-11-30T10:00:00`, `2026-11-30`. El horario de atención **no** lo limita |
| `estimatedDurationMinutes` | number | Obligatorio | Entero de 1 a 2147483647 (límite de la columna, no una regla de negocio) |

### `CounterOfferDto`: `POST /api/offers/:offerId/counter` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones |
|---|---|---|---|
| `amount` | string (o number) | Obligatorio | Mismo formato que en `CreateOfferDto`. **Ningún otro campo** (400): las demás condiciones no se negocian |

### `ListOffersQueryDto`: `GET /api/offers/me` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `status` | `OfferStatus` | Omitible | Se filtra por **estado efectivo** (una `VIGENTE` vencida cuenta como `VENCIDA`) |
| `page` | number | Omitible (1) | ≥ 1 |
| `limit` | number | Omitible (20) | 1 a 50 |

### `ListReceivedOffersQueryDto`: `GET /api/offers/received` (query)

Igual que `ListOffersQueryDto`, más:

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `orderId` | string | Omitible | UUID de un pedido **propio** (si no, 404) |

`POST /api/offers/:offerId/reject`, `/withdraw` y `/accept` no tienen cuerpo: lo que se envíe se ignora.

## NotificationsModule

### `ListNotificationsQueryDto`: `GET /api/notifications` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `unread` | boolean | Omitible (todas) | `true`: solo no leídas; `false`: solo leídas. Otro valor responde 400 `"unread debe ser true o false"` |
| `page` | number | Omitible (1) | ≥ 1 |
| `limit` | number | Omitible (20) | 1 a 100 |

No acepta `userId` ni otras propiedades (400). `PATCH /api/notifications/:notificationId/read` y `PATCH /api/notifications/read-all` no llevan cuerpo.
