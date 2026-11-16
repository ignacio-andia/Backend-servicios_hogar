# 01. Inventario de endpoints existentes

Solo se listan endpoints que **existen en el código**. Lo que no aparece aquí no existe: ver [09](09-gaps-and-pending-contracts.md).

- Base: `http://localhost:3000/api`. Todas las rutas siguientes incluyen el prefijo `/api`.
- Total: **54 endpoints**.

| Módulo | Endpoints |
|---|---|
| AuthModule | 3 |
| UsersModule | 4 |
| CatalogsModule | 14 |
| AuditModule | 1 |
| WorkerProfileModule | 19 |
| OrdersModule | 13 |

## Códigos comunes (no se repiten en cada fila)

| Código | Cuándo |
|---|---|
| 400 | Validación del DTO, propiedad no permitida (`forbidNonWhitelisted`) o parámetro de ruta que no es UUID |
| 401 | Ruta protegida sin token, con token inválido o vencido, o con la cuenta que ya no está `ACTIVO` (`"Sesión inválida"`) |
| 403 | Rol insuficiente (`"No tiene permisos para realizar esta operación"`) |
| 500 | Error interno |

**Abreviaturas**
- **JWT**: requiere token, con cualquier rol.
- **Admin**: rol `ADMINISTRADOR`.
- **Trab. aprobado**: rol `TRABAJADOR`, perfil `APROBADO` y cuenta `ACTIVO` (lo verifica `ApprovedWorkerGuard`).

---

## AuthModule (`/api/auth`)

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 1 | POST | `/api/auth/register` | ✅ | Público | — | `RegisterDto` (JSON) | `AuthResponse` | 201, 400, 409 | 409 `"El correo electrónico ya está registrado"` |
| 2 | POST | `/api/auth/login` | ✅ | Público | — | `LoginDto` (JSON) | `AuthResponse` | 200, 400, 401, 403 | 401 `"Credenciales inválidas"`; 403 `"La cuenta no está activa"` |
| 3 | GET | `/api/auth/me` | ✅ | JWT | — | — | `PublicUser` | 200, 401 | — |

No existen: logout, refresh token, cambio de contraseña ni recuperación de contraseña.

## UsersModule (`/api/users`)

Todas las rutas requieren JWT (`@UseGuards(JwtAuthGuard)` a nivel de controller). Los permisos los aplica el service, no un decorador de roles.

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 4 | GET | `/api/users` | ✅ | Admin (lo verifica el service) | Query: `page?`, `limit?` (≤ 100) | `ListUsersQueryDto` | `Paginated<PublicUser>` | 200, 400, 401, 403 | 403 `"Operación reservada a administradores"` |
| 5 | GET | `/api/users/:id` | ✅ | El propio usuario o un admin | `id` (UUID) | — | `PublicUser` | 200, 400, 401, 403, 404 | 403 `"No tiene permisos para acceder a este usuario"`; 404 `"Usuario no encontrado"` |
| 6 | PATCH | `/api/users/:id` | ✅ | El propio usuario o un admin | `id` (UUID) | `UpdateUserDto` (JSON) | `PublicUser` | 200, 400, 401, 403, 404 | 400 `"Debe enviar al menos un dato a actualizar"` |
| 7 | PATCH | `/api/users/:id/status` | ✅ | El propio usuario (solo `INACTIVO`) o un admin (cualquier estado) | `id` (UUID) | `UpdateUserStatusDto` (JSON) | `PublicUser` | 200, 400, 401, 403, 404, 409 | 403 `"No tiene permisos para modificar este usuario"` o `"Solo puede desactivar su propia cuenta"`; 409 `"No se puede desactivar al único administrador activo"` |

## CatalogsModule (`/api/catalogs`)

Mismo comportamiento para categorías (`categories`) y zonas (`zones`). Los mensajes usan "categoría" o "zona" según el caso.

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 8 | GET | `/api/catalogs/categories` | ✅ | Público | — | — | `CatalogOption[]` (solo activas, ordenadas por nombre) | 200 | — |
| 9 | GET | `/api/catalogs/categories/:id` | ✅ | Público | `id` | — | `CatalogOption` | 200, 400, 404 | 404 `"La categoría no existe"` (también si está inactiva) |
| 10 | GET | `/api/catalogs/zones` | ✅ | Público | — | — | `CatalogOption[]` | 200 | — |
| 11 | GET | `/api/catalogs/zones/:id` | ✅ | Público | `id` | — | `CatalogOption` | 200, 400, 404 | 404 `"La zona no existe"` |
| 12 | GET | `/api/catalogs/admin/categories` | ✅ | Admin | Query: `isActive?` (`true`/`false`) | `ListCatalogQueryDto` | `CatalogItem[]` | 200, 400, 401, 403 | — |
| 13 | GET | `/api/catalogs/admin/categories/:id` | ✅ | Admin | `id` | — | `CatalogItem` | 200, 400, 401, 403, 404 | — |
| 14 | GET | `/api/catalogs/admin/zones` | ✅ | Admin | Query: `isActive?` | `ListCatalogQueryDto` | `CatalogItem[]` | 200, 400, 401, 403 | — |
| 15 | GET | `/api/catalogs/admin/zones/:id` | ✅ | Admin | `id` | — | `CatalogItem` | 200, 400, 401, 403, 404 | — |
| 16 | POST | `/api/catalogs/categories` | ✅ | Admin | — | `CreateCatalogItemDto` (JSON) | `CatalogItem` | 201, 400, 401, 403, 409 | 409 `"Ya existe una categoría con ese nombre"` (sin distinguir mayúsculas, incluye inactivas) |
| 17 | PATCH | `/api/catalogs/categories/:id` | ✅ | Admin | `id` | `UpdateCatalogItemDto` (JSON) | `CatalogItem` | 200, 400, 401, 403, 404, 409 | 400 `"Debe enviar el nombre o la descripción a modificar"`; 409 nombre duplicado |
| 18 | PATCH | `/api/catalogs/categories/:id/deactivate` | ✅ | Admin | `id` | — (sin cuerpo) | `CatalogItem` | 200, 400, 401, 403, 404, 409 | 409 `"La categoría ya está inactiva"` |
| 19 | POST | `/api/catalogs/zones` | ✅ | Admin | — | `CreateCatalogItemDto` (JSON) | `CatalogItem` | 201, 400, 401, 403, 409 | 409 `"Ya existe una zona con ese nombre"` |
| 20 | PATCH | `/api/catalogs/zones/:id` | ✅ | Admin | `id` | `UpdateCatalogItemDto` (JSON) | `CatalogItem` | 200, 400, 401, 403, 404, 409 | igual que categorías |
| 21 | PATCH | `/api/catalogs/zones/:id/deactivate` | ✅ | Admin | `id` | — | `CatalogItem` | 200, 400, 401, 403, 404, 409 | 409 `"La zona ya está inactiva"` |

No existe reactivación ni borrado de catálogos. Crear, editar y desactivar quedan registrados en la bitácora.

## AuditModule (`/api/audit-logs`)

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 22 | GET | `/api/audit-logs` | ✅ | Admin | Query: `entityType?`, `action?`, `actorId?`, `entityId?`, `from?`, `to?`, `page?`, `limit?` (≤ 100) | `ListAuditLogsQueryDto` | `Paginated<AuditLog>` | 200, 400, 401, 403 | 400 `"La fecha inicial no puede ser posterior a la final"` |

## WorkerProfileModule (`/api/worker-profile`)

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 23 | POST | `/api/worker-profile` | ✅ | `CLIENTE` o `TRABAJADOR`; cuenta `ACTIVO` | — | `CreateWorkerProfileDto` (JSON) | `WorkerProfileView` (estado `BORRADOR`) | 201, 400, 401, 403, 404, 409 | 409 `"Esta cuenta ya tiene un perfil de trabajador"`; 404 zona inexistente; 400 zona inactiva; 400 categorías inexistentes o inactivas (mensaje en arreglo); 400 horarios superpuestos o inválidos (arreglo). **Otorga el rol `TRABAJADOR`.** |
| 24 | GET | `/api/worker-profile/me` | ✅ | `TRABAJADOR` | — | — | `WorkerProfileView` | 200, 401, 403, 404 | 404 `"Aún no tiene un perfil de trabajador"` |
| 25 | PATCH | `/api/worker-profile/me` | ✅ | `TRABAJADOR`; perfil `BORRADOR` u `OBSERVADO` | — | `UpdateWorkerProfileDto` (JSON) | `WorkerProfileView` | 200, 400, 401, 403, 404, 409 | 400 `"Debe enviar al menos un dato a modificar"`; 403 cambiar `zoneId` fuera de `BORRADOR`; 409 `"No se puede modificar el perfil en estado X"`; 409 cambio de estado concurrente |
| 26 | PUT | `/api/worker-profile/me/specialties` | ✅ | `TRABAJADOR`; perfil `BORRADOR` u `OBSERVADO` | — | `UpdateSpecialtiesDto` (JSON) | `WorkerProfileView` | 200, 400, 401, 403, 404, 409 | 400 categorías inexistentes o inactivas (arreglo); 409 estado no editable |
| 27 | PUT | `/api/worker-profile/me/schedules` | ✅ | `TRABAJADOR`; **cualquier estado del perfil** | — | `UpdateSchedulesDto` (JSON) | `WorkerProfileView` | 200, 400, 401, 403, 404 | 400 horarios inválidos o superpuestos (arreglo) |
| 28 | POST | `/api/worker-profile/me/submit` | ✅ | `TRABAJADOR`; perfil `BORRADOR` u `OBSERVADO` | — | — (sin cuerpo) | `WorkerProfileView` (estado `PENDIENTE`) | 200, 401, 403, 404, 400, 409 | 400 con un arreglo de requisitos faltantes; 409 `"No se puede enviar a revisión un perfil en estado X"` |
| 29 | GET | `/api/worker-profile/me/status` | ✅ | `TRABAJADOR` | — | — | `WorkerStatusView` | 200, 401, 403, 404 | — |
| 30 | GET | `/api/worker-profile/me/eligibility` | ✅ | `TRABAJADOR` | — | — | `WorkerEligibility` | 200, 401, 403 | — (nunca responde 404: sin perfil devuelve `eligible: false`) |
| 31 | GET | `/api/worker-profile/me/documents` | ✅ | `TRABAJADOR` | — | — | `WorkerDocumentView[]` | 200, 401, 403, 404 | — |
| 32 | POST | `/api/worker-profile/me/documents` | ✅ | `TRABAJADOR`; perfil `BORRADOR` u `OBSERVADO` | — | `multipart/form-data`: `type` + `file` | `WorkerDocumentView` | 201, 400, 401, 403, 404, 409, 413 | 400 archivo vacío o ausente, o formato no permitido; 409 estado no editable; 413 tamaño |
| 33 | POST | `/api/worker-profile/me/documents/:documentId/replace` | ✅ | `TRABAJADOR`; perfil `BORRADOR` u `OBSERVADO`; documento propio y vigente | `documentId` | `multipart/form-data`: `file` | `WorkerDocumentView` (el nuevo) | **201**, 400, 401, 403, 404, 409, 413 | 404 `"El documento no existe"`; 409 `"Ese documento ya fue reemplazado; reemplace la versión vigente"` |
| 34 | GET | `/api/worker-profile/me/documents/:documentId/download` | ✅ | `TRABAJADOR`; documento propio (cualquier estado) | `documentId` | — | Binario (`attachment`) | 200, 400, 401, 403, 404 | 404 documento ajeno o inexistente |
| 35 | GET | `/api/worker-profile/me/zone` | ✅ | `TRABAJADOR` | — | — | `ZoneStatusView` | 200, 401, 403, 404 | — |
| 36 | POST | `/api/worker-profile/me/zone-change-requests` | 🟡 (hoy siempre 409, ver nota) | `TRABAJADOR`; perfil `APROBADO`, `PENDIENTE`, `OBSERVADO` o `SUSPENDIDO` | — | `CreateZoneChangeRequestDto` (JSON) | `ZoneChangeRequestView` | 201, 400, 401, 403, 404, 409 | 400 `"La zona solicitada es su zona actual"`; 400 zona inactiva; 409 con un **arreglo** de motivos (ver `ZoneChangeBlocker`); 409 `"Ya tiene una solicitud de cambio de zona pendiente"` |
| 37 | GET | `/api/worker-profile/me/zone-change-requests` | ✅ | `TRABAJADOR` | — | — | `ZoneChangeRequestView[]` (más reciente primero) | 200, 401, 403, 404 | — |
| 38 | GET | `/api/worker-profile/admin/zone-change-requests` | ✅ | Admin | Query: `status?`, `resolved?`, `workerUserId?`, `page?`, `limit?` (≤ 100) | `ListZoneChangeRequestsQueryDto` | `Paginated<AdminZoneChangeRequestView>` | 200, 400, 401, 403 | — |
| 39 | GET | `/api/worker-profile/admin/zone-change-requests/:requestId` | ✅ | Admin | `requestId` | — | `AdminZoneChangeRequestView` | 200, 400, 401, 403, 404 | 404 `"La solicitud de cambio de zona no existe"` |
| 40 | PATCH | `/api/worker-profile/admin/zone-change-requests/:requestId` | ✅ | Admin activo; no su propia solicitud | `requestId` | `DecideZoneChangeRequestDto` (JSON) | `AdminZoneChangeRequestView` | 200, 400, 401, 403, 404, 409 | 403 `"No puede resolver su propia solicitud de cambio de zona"`; 409 `"La solicitud ya fue resuelta"`; 409 zona destino desactivada (hay que rechazar); 409 `"La zona del perfil cambió desde que se creó la solicitud"` |
| 41 | GET | `/api/worker-profile/admin/inactive-zone-profiles` | ✅ | Admin | Query: `zoneId?` | `ListInactiveZoneProfilesQueryDto` | `AffectedProfile[]` | 200, 400, 401, 403 | — |

> **Nota (#36):** hoy la solicitud de cambio de zona **siempre se bloquea** con el motivo `VERIFICACION_NO_DISPONIBLE`, porque la fuente de trabajo activo `OFERTAS` todavía no existe (OffersModule no está implementado). El endpoint, sus validaciones y la decisión del administrador funcionan.
>
> **No hay endpoints** para que un administrador apruebe, observe, rechace o suspenda perfiles, ni para que vea los documentos de un trabajador (ver 08 y 09).

## OrdersModule (`/api/orders`)

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 42 | POST | `/api/orders` | ✅ | `CLIENTE` | — | `multipart/form-data`: campos de `CreateOrderDto` y archivos `images` | `OrderWithWarnings` | 201, 400, 401, 403, 404, 413 | 400 cantidad de fotos (`"Debe adjuntar entre 1 y 3 fotografías en el campo \"images\""`); 404 categoría o zona inexistente; 400 categoría o zona inactiva; 400 formato de imagen o imagen dañada; 413 tamaño |
| 43 | POST | `/api/orders/duplicate-check` | ✅ | `CLIENTE` | — | `DuplicateCheckDto` (JSON) | `{ warnings: OrderWarning[] }` | **200**, 400, 401, 403 | Nunca bloquea |
| 44 | GET | `/api/orders/me` | ✅ | `CLIENTE` | Query: `status?`, `page?`, `limit?` (≤ 50) | `ListOwnOrdersQueryDto` | `Paginated<OwnerOrderView>` | 200, 400, 401, 403 | `status` se filtra por **estado efectivo** (un `PUBLICADO` vencido cuenta como `VENCIDO`) |
| 45 | GET | `/api/orders/me/:orderId` | ✅ | `CLIENTE` dueño | `orderId` | — | `OwnerOrderView` | 200, 400, 401, 403, 404 | 404 `"El pedido no existe"` (también si es ajeno) |
| 46 | GET | `/api/orders/me/:orderId/images/:imageId` | ✅ | `CLIENTE` dueño | `orderId`, `imageId`; Query: `variant?` (`full` por defecto o `thumb`) | `ImageVariantQueryDto` | Binario `image/webp` (`inline`) | 200, 400, 401, 403, 404 | 404 `"La fotografía no existe"` |
| 47 | PATCH | `/api/orders/me/:orderId` | ✅ | `CLIENTE` dueño; pedido `PUBLICADO` (sin vencer) o `EN_NEGOCIACION` | `orderId` | `UpdateOrderDto` (JSON) | `OrderWithWarnings` | 200, 400, 401, 403, 404, 409 | 400 `"Debe enviar al menos un dato a modificar"`; 409 vencido, con acuerdo (sugiere RF-34) u otro estado |
| 48 | POST | `/api/orders/me/:orderId/images` | ✅ | Igual que #47 | `orderId` | `multipart/form-data`: `image` (1 archivo) | `OwnerOrderView` | 201, 400, 401, 403, 404, 409, 413 | 409 `"El pedido ya tiene el máximo de 3 fotografías…"`; 400 sin archivo |
| 49 | PUT | `/api/orders/me/:orderId/images/:imageId` | ✅ | Igual que #47 | `orderId`, `imageId` | `multipart/form-data`: `image` | `OwnerOrderView` | 200, 400, 401, 403, 404, 409, 413 | 404 `"La fotografía no existe"` |
| 50 | DELETE | `/api/orders/me/:orderId/images/:imageId` | ✅ | Igual que #47 | `orderId`, `imageId` | — | `OwnerOrderView` (**200 con cuerpo**) | 200, 400, 401, 403, 404, 409 | 409 `"El pedido debe conservar al menos 1 fotografía(s). Use reemplazar."` |
| 51 | POST | `/api/orders/me/:orderId/cancel` | ✅ | `CLIENTE` dueño; pedido `PUBLICADO` (sin vencer) o `EN_NEGOCIACION` | `orderId` | `CancelOrderDto` (JSON, puede ser `{}`) | `OwnerOrderView` | **200**, 400, 401, 403, 404, 409 | 409 con acuerdo (`"…Use «Cancelar trabajo» (RF-34)."`), vencido o en otro estado |
| 52 | GET | `/api/orders/available` | ✅ | Trab. aprobado | Query: `categoryId?`, `page?`, `limit?` (≤ 50) | `ListAvailableOrdersQueryDto` | `Paginated<WorkerOrderView>` | 200, 400, 401, 403 | 403 con el motivo de no elegibilidad (por ejemplo `"Su perfil de trabajador está pendiente de revisión."`) |
| 53 | GET | `/api/orders/available/:orderId` | ✅ | Trab. aprobado; pedido visible (ver 05) | `orderId` | — | `WorkerOrderView` | 200, 400, 401, 403, 404 | 404 si no le corresponde verlo |
| 54 | GET | `/api/orders/available/:orderId/images/:imageId` | ✅ | Igual que #53 | `orderId`, `imageId`; Query: `variant?` | `ImageVariantQueryDto` | Binario `image/webp` | 200, 400, 401, 403, 404 | 404 |

> **Nota (#42):** con más de 10 archivos en total, multer rechaza la petición con 400 (`LIMIT_FILE_COUNT`, mensaje de multer en inglés). Entre 4 y 10 fotos, el service responde 400 con el mensaje en español.
>
> **No existen** endpoints de ofertas, historial de estados del pedido, vista administrativa de pedidos, asignación de trabajador ni "Cancelar trabajo".
