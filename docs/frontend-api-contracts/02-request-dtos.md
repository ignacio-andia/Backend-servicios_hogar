# 02. DTOs de entrada

Se documentan los **26 DTOs** que recibe la API por HTTP. `CreateUserDto` es interno (lo usa AuthModule) y no se recibe por HTTP.

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
| `phone` | string | Omitible, admite null | `^\+?[1-9]\d{6,14}$` (7 a 15 dígitos, `+` opcional) | `@Trim @IsOptional @Matches` | Es necesario para enviar el perfil de trabajador a revisión |

No se aceptan `roles` ni `status`: el registro siempre crea una cuenta `CLIENTE` y `ACTIVO`.

```json
{ "firstName": "Ana", "lastName": "Pérez", "email": "ana@example.com", "password": "Clave1234", "phone": "70000000" }
```

Ejemplos inválidos:
- `{ "password": "abcdefgh" }`: no tiene número y faltan campos.
- `{ ..., "roles": ["ADMINISTRADOR"] }`: 400 `property roles should not exist`.

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
| `phone` | string \| null | Omitible, **admite null** | patrón de teléfono | `@Trim @IsOptional @Matches` | `null` borra el teléfono |

Hay que enviar al menos una propiedad (400 si no). `email`, `roles`, `status` y la contraseña **no** se pueden modificar: 400.

```json
{ "phone": null }
```

### `UpdateUserStatusDto`: `PATCH /api/users/:id/status` (JSON)

| Propiedad | Tipo | Omitir / null | Valores | Reglas |
|---|---|---|---|---|
| `status` | `UserStatus` | Obligatoria | `ACTIVO`, `INACTIVO`, `SUSPENDIDO` | Un usuario no admin solo puede enviar `INACTIVO` sobre su propia cuenta. No se puede dejar la plataforma sin administradores activos |

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

Hay que enviar al menos una propiedad (400). El perfil debe estar en `BORRADOR` u `OBSERVADO` (409).

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

### `DecideZoneChangeRequestDto`: `PATCH /api/worker-profile/admin/zone-change-requests/:requestId` (JSON)

| Propiedad | Tipo | Omitir / null | Restricciones | Reglas |
|---|---|---|---|---|
| `decision` | `'APROBADA' \| 'RECHAZADA'` | Obligatoria | Solo esos dos valores (`PENDIENTE` responde 400) | — |
| `comment` | string | Omitible, admite null | ≤ 500 | Opcional también al rechazar (❓ pendiente con el docente) |

### `ListZoneChangeRequestsQueryDto`: `GET /api/worker-profile/admin/zone-change-requests` (query)

| Propiedad | Tipo | Omitir | Restricciones |
|---|---|---|---|
| `status` | `ZoneChangeRequestStatus` | Omitible | `PENDIENTE`, `APROBADA`, `RECHAZADA` |
| `resolved` | boolean | Omitible | `"true"`: solo resueltas; `"false"`: solo pendientes. Se combina con `status` mediante AND |
| `workerUserId` | string | Omitible | UUID de la **cuenta** del trabajador |
| `page` / `limit` | number | Omitibles (1 / 20) | `limit` ≤ 100 |

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
| `images` | archivo(s) | Obligatorio | 1 a 3 fotos (configurable con `ORDER_MIN_IMAGES` y `ORDER_MAX_IMAGES`) | multer | Ver [06](06-file-contracts.md) |

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
| `description` | string | Omitible, **no admite null** | 10 a 2000 | — |
| `budgetAmount` | string (o número JSON) | Omitible, **no admite null** | mismo patrón que al crear | `"150.5"` y `"150.50"` son el mismo valor: no cuenta como cambio |
| `addressLine` | string | Omitible, **no admite null** | 1 a 255 | — |
| `addressReference` | string \| null | Omitible, admite null | ≤ 255 | `null` o `""` borra la referencia |

- Hay que enviar al menos una propiedad (400).
- `categoryId` y `zoneId` **no** se pueden editar (400; ❓ pendiente con el docente).
- Si no hay cambios reales, responde 200 sin subir la revisión ni reiniciar el plazo.
- Todo cambio real sube `revision`, actualiza `lastEditedAt` y reinicia el vencimiento (48 h).

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
