# 05. Autenticación, autorización y visibilidad de datos

## Autenticación

| Aspecto | Comportamiento real |
|---|---|
| Obtener el token | `POST /api/auth/register` (201) o `POST /api/auth/login` (200) → `AuthResponse.accessToken` |
| Enviar el token | Header `Authorization: Bearer <accessToken>` (`ExtractJwt.fromAuthHeaderAsBearerToken`) |
| Algoritmo | HS256 |
| Payload | `{ sub: userId, email, iat, exp }`. **No incluye roles ni estado** |
| Expiración | `JWT_EXPIRES_IN` (por defecto `1h`; `.env.example` también usa `1h`). Un token vencido responde 401 |
| Validación por petición | `JwtStrategy.validate` carga el usuario **desde la BD** en cada petición. Si la cuenta no existe o no está `ACTIVO`, responde 401 `"Sesión inválida"` |
| Usuario actual | `GET /api/auth/me` → `PublicUser`, con `roles` y `status` actualizados |
| Cierre de sesión | **No hay endpoint**: el cliente descarta el token. El token sigue siendo válido hasta `exp` |
| Refresh, cambio o recuperación de contraseña | **No existen** |
| Cookies | No se usan. CORS no habilita credenciales |

**Consecuencias para Angular**
- Los roles están en `user.roles` (de `AuthResponse` o de `/auth/me`), no en el JWT.
- Un cambio de rol (por ejemplo, crear el perfil de trabajador otorga `TRABAJADOR`) no requiere un token nuevo: la siguiente petición ya lo reconoce. Basta con volver a pedir `/auth/me` para actualizar la copia local.
- Si un administrador suspende o desactiva la cuenta, el token vigente pasa a responder 401: el interceptor debe cerrar la sesión.
- **Almacenamiento:** las cookies httpOnly no son viables con el backend actual. La opción compatible es mantener el token en memoria (signal) y en `sessionStorage` (o `localStorage` si se quiere persistir), protegiéndose contra XSS.

## Mecanismos de autorización (código)

| Mecanismo | Dónde | Efecto |
|---|---|---|
| `@Auth(...roles)` | Rutas de catálogos (admin), bitácora, perfil y pedidos | `JwtAuthGuard` y `RolesGuard`: alguno de los roles indicados; si no, 403 `"No tiene permisos para realizar esta operación"` |
| `@UseGuards(JwtAuthGuard)` | `/auth/me` y todo `/users` | Solo exige token. Los permisos de `/users` los aplica el service (propietario o admin) |
| `ApprovedWorkerGuard` | `/orders/available/*` | Corre después del JWT. Exige cuenta `ACTIVO`, rol `TRABAJADOR` y perfil `APROBADO`; si no, 403 con el motivo (`WorkerEligibility.message`, y `" Motivo: …"` si hay uno) |
| Propietario en el service | `/users/:id`, `/worker-profile/me/*`, `/orders/me/*` | Las rutas `me` usan el id del token. Un pedido o documento ajeno responde **404** (no 403), para no revelar que existe |
| Estado de la entidad | Perfil, pedidos y solicitudes | 409 cuando el estado no permite la acción (ver 04) |

## Matriz de acceso por endpoint

Columnas:
- **Pub.**: visitante sin sesión.
- **Cli.**: cuenta con rol `CLIENTE`.
- **Trab.**: rol `TRABAJADOR` (cualquier estado del perfil).
- **Trab. ap.**: trabajador con perfil `APROBADO`.
- **Adm.**: `ADMINISTRADOR`.

✔ permitido · ✘ prohibido · "propio" = solo sobre sus propios datos.

| Endpoint | Pub. | Cli. | Trab. | Trab. ap. | Adm. | Restricciones adicionales |
|---|---|---|---|---|---|---|
| `POST /auth/register`, `POST /auth/login` | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| `GET /auth/me` | ✘ | ✔ | ✔ | ✔ | ✔ | — |
| `GET /users` | ✘ | ✘ | ✘ | ✘ | ✔ | — |
| `GET/PATCH /users/:id` | ✘ | propio | propio | propio | ✔ | — |
| `PATCH /users/:id/status` | ✘ | propio (solo `INACTIVO`) | propio | propio | ✔ | No dejar la plataforma sin administradores activos |
| `GET /catalogs/{categories,zones}[/:id]` | ✔ | ✔ | ✔ | ✔ | ✔ | Solo activos |
| `/catalogs/admin/*`, `POST/PATCH /catalogs/*` | ✘ | ✘ | ✘ | ✘ | ✔ | — |
| `GET /audit-logs` | ✘ | ✘ | ✘ | ✘ | ✔ | — |
| `POST /worker-profile` | ✘ | ✔ | ✔ | — | ✘ (salvo que también tenga `CLIENTE`) | Cuenta `ACTIVO`; un solo perfil por cuenta |
| `/worker-profile/me/*` | ✘ | ✘ (403 hasta tener el rol) | propio | propio | ✘ (salvo que también tenga `TRABAJADOR`) | Ver los estados en 04 |
| `/worker-profile/admin/*` | ✘ | ✘ | ✘ | ✘ | ✔ | Un administrador no resuelve su propia solicitud (403) |
| `POST /orders`, `POST /orders/duplicate-check`, `/orders/me/*` | ✘ | propio | propio (tiene `CLIENTE`) | propio | ✘ (salvo que también tenga `CLIENTE`) | Editar y cancelar solo en `PUBLICADO` (sin vencer) o `EN_NEGOCIACION` |
| `/orders/available/*` | ✘ | ✘ | ✘ (403) | ✔ | ✘ | Regla de visibilidad (abajo) |

> Toda cuenta registrada tiene `CLIENTE`. Un trabajador también es cliente con la misma cuenta (RF-02, RN-14). Un administrador creado directamente en la BD solo tiene `CLIENTE` si se le asignó.

## Visibilidad de datos por rol

| Dato | Visitante | Cliente dueño | Otro cliente | Trabajador aprobado | Administrador |
|---|---|---|---|---|---|
| Datos de una cuenta (`PublicUser`) | ✘ | la propia | ✘ | la propia | todas |
| Teléfono y correo de un trabajador | ✘ | ✘ | ✘ | el propio | ✔ (en solicitudes de zona y usuarios) |
| Perfil de trabajador completo | ✘ | — | ✘ | el propio | ✘ (**no hay endpoint**) |
| Documentos del trabajador | ✘ | — | ✘ | los propios (listar y descargar) | ✘ (**no hay endpoint**; RF-56 pendiente) |
| Pedido (datos generales) | ✘ | ✔ | ✘ | solo los visibles | ✘ (**no hay endpoint**) |
| Dirección exacta del pedido | ✘ | ✔ | ✘ | ✘ (❓ RF-55, pendiente con el docente) | ✘ |
| Datos del cliente en el pedido | ✘ | — | ✘ | ✘ | ✘ |
| Fotos del pedido | ✘ | ✔ | ✘ | solo de pedidos visibles | ✘ |
| Historial de estados del pedido | ✘ | ✘ (no expuesto) | ✘ | ✘ | ✘ |
| Bitácora | ✘ | ✘ | ✘ | ✘ | ✔ |

### Regla de visibilidad de pedidos para trabajadores (RF-17)

`OrderVisibilityService.visibleWhere`, aplicada igual al listado, al detalle y a las fotos. Un pedido es visible si se cumplen **todas** estas condiciones:

1. El trabajador tiene perfil `APROBADO`, cuenta `ACTIVO` y rol `TRABAJADOR` (guard).
2. `pedido.zoneId` es la zona del trabajador, y esa zona está **activa**.
3. `pedido.categoryId` está entre sus especialidades, y esa categoría está **activa**.
4. El pedido no es suyo como cliente (RN-14).
5. La cuenta del cliente está `ACTIVO`.
6. El estado es `EN_NEGOCIACION`, o `PUBLICADO` con `expiresAt` todavía en el futuro.

Si no se cumple alguna condición, responde **404** (igual que un pedido inexistente).

### Restricciones que dependen del estado

| Acción | Estado requerido | Respuesta si no se cumple |
|---|---|---|
| Editar el perfil, especialidades o documentos | Perfil `BORRADOR` u `OBSERVADO` | 409 |
| Cambiar la zona directamente | Perfil `BORRADOR` | 403 (hay que usar una solicitud) |
| Enviar a revisión | `BORRADOR` u `OBSERVADO`, sin requisitos pendientes | 409 o 400 |
| Solicitar cambio de zona | Perfil `APROBADO`, `PENDIENTE`, `OBSERVADO` o `SUSPENDIDO`; sin solicitud pendiente; sin trabajo activo; fuentes de verificación disponibles | 409 con un arreglo de motivos |
| Editar un pedido o sus fotos, cancelarlo | Estado efectivo `PUBLICADO` o `EN_NEGOCIACION` | 409 (mensaje según el estado) |
| Decidir una solicitud de zona | `PENDIENTE`; al aprobar, zona destino activa y zona del perfil sin cambios | 409 |

**Para la interfaz:** use `canEdit` y `canSubmit` (perfil), `canEdit` y `canCancel` (pedido), `canRequestChange` y `blockers` (zona), y `eligible` (trabajador) para mostrar u ocultar acciones. El backend vuelve a validar todo.
