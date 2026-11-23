# 01. Inventario de endpoints existentes

Solo se listan endpoints que **existen en el código**. Lo que no aparece aquí no existe: ver [09](09-gaps-and-pending-contracts.md).

- Base: `http://localhost:3000/api`. Todas las rutas siguientes incluyen el prefijo `/api`.
- Total: **66 endpoints**.

| Módulo | Endpoints |
|---|---|
| AuthModule | 3 |
| UsersModule | 4 |
| CatalogsModule | 14 |
| AuditModule | 1 |
| WorkerProfileModule | 27 |
| OrdersModule | 13 |
| NotificationsModule | 4 |

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
| 7 | PATCH | `/api/users/:id/status` | ✅ | El propio usuario (solo `INACTIVO`) o un admin (cualquier estado) | `id` (UUID) | `UpdateUserStatusDto` (JSON) | `PublicUser` | 200, 400, 401, 403, 404, 409 | 403 `"No tiene permisos para modificar este usuario"` o `"Solo puede desactivar su propia cuenta"`; 409 `"No se puede desactivar al único administrador activo"`. Suspender una cuenta (`SUSPENDIDO`) cancela en la misma transacción su solicitud de cambio de zona pendiente (T4-F3); si eso falla, la cuenta no queda suspendida (500) |

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
| 25 | PATCH | `/api/worker-profile/me` | ✅ | `TRABAJADOR`; perfil `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO` | — | `UpdateWorkerProfileDto` (JSON) | `WorkerProfileView` | 200, 400, 401, 403, 404, 409 | 400 `"Debe enviar al menos un dato a modificar"`; 403 cambiar `zoneId` fuera de `BORRADOR`; 409 `"No se puede modificar el perfil en estado X"`; 409 cambio de estado concurrente |
| 26 | PUT | `/api/worker-profile/me/specialties` | ✅ | `TRABAJADOR`; perfil `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO` | — | `UpdateSpecialtiesDto` (JSON) | `WorkerProfileView` | 200, 400, 401, 403, 404, 409 | 400 categorías inexistentes o inactivas (arreglo); 409 estado no editable |
| 27 | PUT | `/api/worker-profile/me/schedules` | ✅ | `TRABAJADOR`; **cualquier estado del perfil** | — | `UpdateSchedulesDto` (JSON) | `WorkerProfileView` | 200, 400, 401, 403, 404 | 400 horarios inválidos o superpuestos (arreglo) |
| 28 | POST | `/api/worker-profile/me/submit` | ✅ | `TRABAJADOR`; perfil `BORRADOR`, `OBSERVADO` o `RECHAZADO` | — | — (sin cuerpo) | `WorkerProfileView` (estado `PENDIENTE`) | 200, 401, 403, 404, 400, 409 | 400 con un arreglo de requisitos faltantes; 409 `"No se puede enviar a revisión un perfil en estado X"`. Desde `OBSERVADO` o `RECHAZADO` es un reenvío: el historial conserva la decisión anterior y su motivo |
| 29 | GET | `/api/worker-profile/me/status` | ✅ | `TRABAJADOR` | — | — | `WorkerStatusView` | 200, 401, 403, 404 | — |
| 30 | GET | `/api/worker-profile/me/eligibility` | ✅ | `TRABAJADOR` | — | — | `WorkerEligibility` | 200, 401, 403 | — (nunca responde 404: sin perfil devuelve `eligible: false`). Desde T4-F4 incluye `pendingZoneChangeRequest` y `canTakeNewWork` |
| 31 | GET | `/api/worker-profile/me/documents` | ✅ | `TRABAJADOR` | — | — | `WorkerDocumentView[]` | 200, 401, 403, 404 | — |
| 32 | POST | `/api/worker-profile/me/documents` | ✅ | `TRABAJADOR`; perfil `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO` | — | `multipart/form-data`: `type` + `file` | `WorkerDocumentView` | 201, 400, 401, 403, 404, 409, 413 | 400 archivo vacío o ausente, o formato no permitido; 409 estado no editable; 413 tamaño |
| 33 | POST | `/api/worker-profile/me/documents/:documentId/replace` | ✅ | `TRABAJADOR`; perfil `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO`; documento propio y vigente | `documentId` | `multipart/form-data`: `file` | `WorkerDocumentView` (el nuevo) | **201**, 400, 401, 403, 404, 409, 413 | 404 `"El documento no existe"`; 409 `"Ese documento ya fue reemplazado; reemplace la versión vigente"` |
| 34 | GET | `/api/worker-profile/me/documents/:documentId/download` | ✅ | `TRABAJADOR`; documento propio (cualquier estado) | `documentId` | — | Binario (`attachment`) | 200, 400, 401, 403, 404 | 404 documento ajeno o inexistente |
| 35 | GET | `/api/worker-profile/me/zone` | ✅ | `TRABAJADOR` | — | — | `ZoneStatusView` | 200, 401, 403, 404 | — |
| 36 | POST | `/api/worker-profile/me/zone-change-requests` | 🟡 (hoy siempre 409, ver nota) | `TRABAJADOR`; perfil **`APROBADO`** (T4.2) | — | `CreateZoneChangeRequestDto` (JSON) | `ZoneChangeRequestView` | 201, 400, 401, 403, 404, 409 | 400 `"La zona solicitada es su zona actual"`; 400 zona inactiva; 404 zona inexistente; 409 con un **arreglo** de motivos (ver `ZoneChangeBlocker`), por ejemplo `"No se puede solicitar un cambio de zona con el perfil en estado X"`; 409 `"Ya tiene una solicitud de cambio de zona pendiente"`. La zona se vuelve a validar con bloqueo dentro de la transacción |
| 65 | POST | `/api/worker-profile/me/zone-change-requests/:requestId/withdraw` | ✅ | `TRABAJADOR`; solicitud **propia** y `PENDIENTE` | `requestId` (UUID) | — (sin cuerpo) | `ZoneChangeRequestView` (`CANCELADA`, `cancellationCause: "RETIRO_TRABAJADOR"`) | **200**, 400, 401, 403, 404, 409 | 404 `"La solicitud de cambio de zona no existe"` (también si es de otro usuario); 409 `"La solicitud ya fue resuelta"` (aprobada, rechazada, cancelada o ya retirada). Notifica al trabajador (T4.3) |
| 37 | GET | `/api/worker-profile/me/zone-change-requests` | ✅ | `TRABAJADOR` | — | — | `ZoneChangeRequestView[]` (más reciente primero) | 200, 401, 403, 404 | — |
| 38 | GET | `/api/worker-profile/admin/zone-change-requests` | ✅ | Admin | Query: `status?`, `resolved?`, `workerUserId?`, `page?`, `limit?` (≤ 100) | `ListZoneChangeRequestsQueryDto` | `Paginated<AdminZoneChangeRequestView>` | 200, 400, 401, 403 | — |
| 39 | GET | `/api/worker-profile/admin/zone-change-requests/:requestId` | ✅ | Admin | `requestId` | — | `AdminZoneChangeRequestView` | 200, 400, 401, 403, 404 | 404 `"La solicitud de cambio de zona no existe"` |
| 40 | PATCH | `/api/worker-profile/admin/zone-change-requests/:requestId` | ✅ | Admin activo; no su propia solicitud | `requestId` | `DecideZoneChangeRequestDto` (JSON) | `AdminZoneChangeRequestView` | 200, 400, 401, 403, 404, 409 | 400 `"Debe indicar el motivo del rechazo"` (rechazo sin `comment` o vacío); 403 `"No puede resolver su propia solicitud de cambio de zona"`; 409 `"La solicitud ya fue resuelta"` (también si se canceló por suspensión o si otra decisión simultánea ganó); 409 `"No se puede aprobar: el perfil del trabajador está en estado SUSPENDIDO"` (o `RECHAZADO`); 409 zona destino desactivada (hay que rechazar); 409 `"La zona del perfil cambió desde que se creó la solicitud"`; 409 `"No se puede aprobar: la cuenta del trabajador está suspendida"` (T4-F3). Notifica al trabajador (T4.2) |
| 41 | GET | `/api/worker-profile/admin/inactive-zone-profiles` | ✅ | Admin | Query: `zoneId?` | `ListInactiveZoneProfilesQueryDto` | `AffectedProfile[]` | 200, 400, 401, 403 | — |
| 56 | GET | `/api/worker-profile/admin/profiles` | ✅ | Admin activo | Query: `status?`, `zoneId?`, `categoryId?`, `page?`, `limit?` (≤ 100) | `ListAdminWorkerProfilesQueryDto` | `Paginated<AdminWorkerProfileSummary>` | 200, 400, 401, 403 | **Nunca incluye el perfil del propio administrador**. Orden: primero los enviados a revisión hace más tiempo; los nunca enviados al final |
| 57 | GET | `/api/worker-profile/admin/profiles/:profileId` | ✅ | Admin activo; **no su propio perfil** | `profileId` (UUID) | — | `AdminWorkerProfileView` | 200, 400, 401, 403, 404 | 403 `"No puede revisar ni decidir sobre su propio perfil de trabajador"`; 404 `"El perfil de trabajador no existe"` |
| 58 | GET | `/api/worker-profile/admin/profiles/:profileId/documents` | ✅ | Admin activo; **no su propio perfil** | `profileId` | — | `WorkerDocumentView[]` (solo metadatos) | 200, 400, 401, 403, 404 | Registra `CONSULTA_DOCUMENTOS` en la bitácora. 403 `"No puede consultar los documentos de su propio perfil de trabajador"`; 404 perfil inexistente |
| 59 | GET | `/api/worker-profile/admin/profiles/:profileId/documents/:documentId/view` | ✅ | Igual que #58; el documento debe pertenecer a ese perfil | `profileId`, `documentId` | — | Binario (`inline`) | 200, 400, 401, 403, 404 | Registra `VISUALIZACION_DOCUMENTO`. 404 `"El documento no existe"` si es de otro perfil, no existe o falta el archivo |
| 60 | GET | `/api/worker-profile/admin/profiles/:profileId/documents/:documentId/download` | ✅ | Igual que #59 | `profileId`, `documentId` | — | Binario (`attachment`) | 200, 400, 401, 403, 404 | Registra `DESCARGA_DOCUMENTO`. Mismos 404 que #59 |
| 66 | PATCH | `/api/worker-profile/admin/profiles/:profileId/zone` | ✅ | Admin activo; **no sobre su propio perfil**; perfil `RECHAZADO`, `OBSERVADO`, `PENDIENTE` o `SUSPENDIDO` con la zona actual **inactiva** | `profileId` (UUID) | `ReassignRejectedProfileZoneDto` (JSON) | `AdminWorkerProfileView` | 200, 400, 401, 403, 404, 409 | 400 justificación ausente o vacía, `zoneId` no UUID, propiedad no permitida, `"La zona seleccionada no está activa"` o `"La zona nueva debe ser distinta de la zona actual"`; 403 `"No puede modificar su propio perfil de trabajador"`; 404 perfil o zona inexistente; 409 `"Solo se puede reasignar la zona de un perfil RECHAZADO, OBSERVADO, PENDIENTE o SUSPENDIDO (estado actual: X)"`; 409 `"La zona actual \"…\" sigue activa: …"`. T4.4 y T4-F2 |
| 55 | PATCH | `/api/worker-profile/admin/profiles/:profileId/status` | ✅ | Admin activo; **no sobre su propio perfil** | `profileId` (UUID) | `ChangeWorkerProfileStatusDto` (JSON) | `WorkerProfileView` | 200, 400, 401, 403, 404, 409 | 400 motivo ausente o vacío (`OBSERVADO`, `RECHAZADO`, `SUSPENDIDO`) o estado no permitido; 403 `"No puede revisar ni decidir sobre su propio perfil de trabajador"`; 404 `"El perfil de trabajador no existe"`; 409 transición inválida (`"No se puede pasar un perfil de X a Y"`); 409 requisitos de aprobación o de **reactivación** no cumplidos (arreglo, T4-F1); 409 cambio de estado concurrente |

> **Nota (#36):** hoy la solicitud de cambio de zona **siempre se bloquea** con el motivo `VERIFICACION_NO_DISPONIBLE`, porque la fuente de trabajo activo `OFERTAS` todavía no existe (OffersModule no está implementado). El endpoint, sus validaciones y la decisión del administrador funcionan.
>
> **Nota (T4.3): trabajo nuevo con una solicitud pendiente.** Mientras el trabajador tenga una solicitud de cambio de zona `PENDIENTE`, `WorkerProfileService.lockApprovedWorker` responde 409 `"Tiene una solicitud de cambio de zona pendiente: no puede ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire."`. Lo usan la asignación de un pedido (`OrdersService.transition` a `ACORDADO`) y `OrderVisibilityService.assertOpenForOffers`, que debe usar el futuro módulo de ofertas. Tampoco aparece en `findApprovedWorkers`. Puede seguir consultando pedidos (#52–#54) y sus trabajos ya acordados no cambian. **No existen endpoints de ofertas**: el bloqueo de ofertas queda listo en ese punto de integración, pero no hay una ruta HTTP que lo ejerza todavía.
>
> **Nota (#66, T4.4 y T4-F2): reasignación de zona de un perfil `RECHAZADO`, `OBSERVADO`, `PENDIENTE` o `SUSPENDIDO`.** Esos perfiles no pueden cambiar su zona ni pedir un cambio, y sin una zona activa no pueden reenviarse ni aprobarse. No se admiten `APROBADO` (pide un cambio de zona) ni `BORRADOR` (elige la zona directamente). Un perfil `SUSPENDIDO` la recibe para regularizarse (T4-F7) y sigue `SUSPENDIDO`. Si su zona fue desactivada, un administrador le asigna otra zona activa con una justificación obligatoria. **No** es un cambio de zona general (exige que la zona actual esté inactiva), no cambia el estado (lo conserva) ni otros datos, y no crea una solicitud de cambio de zona. En una sola transacción cambia la zona, deja constancia en la bitácora (`EDICION` sobre `PERFIL_TRABAJADOR`) y notifica al trabajador (`ZONA_REASIGNADA`). Bloquea la fila del perfil y lee las dos zonas con `FOR SHARE`: un cambio de estado o una desactivación simultánea espera o ya se ve aplicada.
>
> **Nota (#25, #26, #32, #33 y #55, T4-F7): regularización de un perfil `SUSPENDIDO`.** El trabajador suspendido puede corregir sus datos, especialidades, horarios y documentos, pero **no** su zona (403) ni enviar el perfil a revisión (409): sigue `SUSPENDIDO`, sin pedidos, ofertas ni asignaciones nuevas. Si su zona fue desactivada, un administrador se la reasigna (#66). Solo un administrador lo reactiva (#55), y solo si cumple todos los requisitos vigentes.
>
> **Nota (#55, T4-F1 y T4-F5): aprobar y reactivar.** `PENDIENTE` → `APROBADO` y `SUSPENDIDO` → `APROBADO` exigen los requisitos vigentes: teléfono en la cuenta, especialidades activas, zona activa y al menos un horario activo. Se comprueban **dentro de la transacción**, con la cuenta (`FOR SHARE`), el perfil (`FOR UPDATE`) y la zona y las especialidades (`FOR SHARE`) bloqueados, en ese orden. Si falta algo, 409 con un arreglo; el primer mensaje es `"El perfil no cumple los requisitos para ser aprobado. Obsérvelo para que el trabajador lo corrija."` o `"El perfil no cumple los requisitos para ser reactivado. Deben corregirse antes de reactivarlo."`.
>
> **Nota (#40 y #55, T4.2):** suspender un perfil (#55) **cancela** su solicitud de cambio de zona pendiente en la misma transacción: queda `CANCELADA` con `cancellationCause: "SUSPENSION_PERFIL"` (no es un rechazo), el administrador que suspendió queda como `decidedBy`, la zona no cambia, se registra en la bitácora y se notifica al trabajador.
>
> **Nota (#55–#60):** el flujo de revisión es listar (#56), ver el detalle (#57), revisar los documentos (#58–#60) y decidir (#55). Cada acceso **exitoso** a documentos queda en la bitácora; un intento rechazado (401, 403, 404) no deja registro.

## OrdersModule (`/api/orders`)

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 42 | POST | `/api/orders` | ✅ | `CLIENTE` | — | `multipart/form-data`: campos de `CreateOrderDto` y archivos `images` | `OrderWithWarnings` | 201, 400, 401, 403, 404, 413 | 400 cantidad de fotos (`"Debe adjuntar entre 1 y 3 fotografías en el campo \"images\""`); 404 categoría o zona inexistente; 400 categoría o zona inactiva; 400 formato de imagen o imagen dañada; 413 tamaño |
| 43 | POST | `/api/orders/duplicate-check` | ✅ | `CLIENTE` | — | `DuplicateCheckDto` (JSON) | `{ warnings: OrderWarning[] }` | **200**, 400, 401, 403 | Nunca bloquea |
| 44 | GET | `/api/orders/me` | ✅ | `CLIENTE` | Query: `status?`, `page?`, `limit?` (≤ 50) | `ListOwnOrdersQueryDto` | `Paginated<OwnerOrderView>` | 200, 400, 401, 403 | `status` se filtra por **estado efectivo** (un `PUBLICADO` vencido cuenta como `VENCIDO`) |
| 45 | GET | `/api/orders/me/:orderId` | ✅ | `CLIENTE` dueño | `orderId` | — | `OwnerOrderView` | 200, 400, 401, 403, 404 | 404 `"El pedido no existe"` (también si es ajeno) |
| 46 | GET | `/api/orders/me/:orderId/images/:imageId` | ✅ | `CLIENTE` dueño | `orderId`, `imageId`; Query: `variant?` (`full` por defecto o `thumb`) | `ImageVariantQueryDto` | Binario `image/webp` (`inline`) | 200, 400, 401, 403, 404 | 404 `"La fotografía no existe"` |
| 47 | PATCH | `/api/orders/me/:orderId` | ✅ | `CLIENTE` dueño; pedido `PUBLICADO` o `EN_NEGOCIACION`, sin vencer | `orderId` | `UpdateOrderDto` (JSON) | `OrderWithWarnings` | 200, 400, 401, 403, 404, 409 | 400 `"Debe enviar al menos un dato a modificar"`; 400 `categoryId` no UUID o `"La categoría seleccionada no está activa"`; 400 propiedad no editable (`zoneId`, `status`, fechas, etc.); 404 `"La categoría no existe"`; 404 pedido ajeno o inexistente; 409 vencido, con acuerdo (sugiere RF-34) u otro estado. La categoría se puede cambiar (T5.2); la zona no |
| 48 | POST | `/api/orders/me/:orderId/images` | ✅ | Igual que #47 | `orderId` | `multipart/form-data`: `image` (1 archivo) | `OwnerOrderView` | 201, 400, 401, 403, 404, 409, 413 | 409 `"El pedido ya tiene el máximo de 3 fotografías…"`; 400 sin archivo |
| 49 | PUT | `/api/orders/me/:orderId/images/:imageId` | ✅ | Igual que #47 | `orderId`, `imageId` | `multipart/form-data`: `image` | `OwnerOrderView` | 200, 400, 401, 403, 404, 409, 413 | 404 `"La fotografía no existe"` |
| 50 | DELETE | `/api/orders/me/:orderId/images/:imageId` | ✅ | Igual que #47 | `orderId`, `imageId` | — | `OwnerOrderView` (**200 con cuerpo**) | 200, 400, 401, 403, 404, 409 | 409 `"El pedido debe conservar al menos 1 fotografía(s). Use reemplazar."` |
| 51 | POST | `/api/orders/me/:orderId/cancel` | ✅ | `CLIENTE` dueño; pedido `PUBLICADO` o `EN_NEGOCIACION`, sin vencer | `orderId` | `CancelOrderDto` (JSON, puede ser `{}`) | `OwnerOrderView` | **200**, 400, 401, 403, 404, 409 | 409 con acuerdo (`"…Use «Cancelar trabajo» (RF-34)."`), vencido o en otro estado |
| 52 | GET | `/api/orders/available` | ✅ | Trab. aprobado | Query: `categoryId?`, `page?`, `limit?` (≤ 50) | `ListAvailableOrdersQueryDto` | `Paginated<WorkerOrderView>` | 200, 400, 401, 403 | 403 con el motivo de no elegibilidad (por ejemplo `"Su perfil de trabajador está pendiente de revisión."`) |
| 53 | GET | `/api/orders/available/:orderId` | ✅ | Trab. aprobado; pedido visible (ver 05) | `orderId` | — | `WorkerOrderView` | 200, 400, 401, 403, 404 | 404 si no le corresponde verlo |
| 54 | GET | `/api/orders/available/:orderId/images/:imageId` | ✅ | Igual que #53 | `orderId`, `imageId`; Query: `variant?` | `ImageVariantQueryDto` | Binario `image/webp` | 200, 400, 401, 403, 404 | 404 |

> **Nota (#42–#51, T5.1): vencimiento.** Todo pedido vence a los **7 días calendario** desde su publicación original (`expiresAt = publishedAt + 7 días`, reloj de la BD). Ese plazo no se reinicia nunca: ni al editar, ni al cambiar de estado, ni al volver a `PUBLICADO` después de una negociación fallida, y no depende de las ofertas. También vence en `EN_NEGOCIACION`. Pasado `expiresAt`, todas las respuestas lo muestran `VENCIDO` y ya no se edita, cancela, oferta ni cambia de estado (409), aunque la tarea automática todavía no lo haya registrado.
>
> **Nota (#42):** con más de 10 archivos en total, multer rechaza la petición con 400 (`LIMIT_FILE_COUNT`, mensaje de multer en inglés). Entre 4 y 10 fotos, el service responde 400 con el mensaje en español.
>
> **No existen** endpoints de ofertas, historial de estados del pedido, vista administrativa de pedidos, asignación de trabajador ni "Cancelar trabajo".

## NotificationsModule (`/api/notifications`)

| # | Método | Ruta | Estado | Acceso | Params / Query | Entrada | Respuesta | Códigos | Errores de negocio |
|---|---|---|---|---|---|---|---|---|---|
| 61 | GET | `/api/notifications` | ✅ | JWT (cualquier rol); solo las propias | Query: `unread?` (`true` o `false`), `page?`, `limit?` (≤ 100) | `ListNotificationsQueryDto` | `Paginated<NotificationView>` | 200, 400, 401 | 400 `"unread debe ser true o false"`; 400 si se envía `userId` u otra propiedad no declarada |
| 62 | GET | `/api/notifications/unread-count` | ✅ | JWT; solo las propias | — | — | `{ unread: number }` | 200, 401 | — |
| 63 | PATCH | `/api/notifications/:notificationId/read` | ✅ | JWT; notificación propia | `notificationId` (UUID) | — (sin cuerpo) | `NotificationView` | 200, 400, 401, 404 | 404 `"La notificación no existe"` si es ajena o no existe. Idempotente: conserva el primer `readAt` |
| 64 | PATCH | `/api/notifications/read-all` | ✅ | JWT; solo las propias | — | — (sin cuerpo) | `{ updated: number }` | 200, 401 | — |

> **Nota (#61–#64):** el destinatario sale siempre del token; ninguna ruta acepta un `userId`. Una cuenta `SUSPENDIDO` o `INACTIVO` responde 401, como en el resto de la API. **No hay** endpoints para crear ni borrar notificaciones: las genera el backend junto con el evento que las origina (ver 04) y se conservan todas.
