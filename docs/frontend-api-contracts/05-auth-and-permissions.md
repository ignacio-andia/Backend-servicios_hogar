# 05. Autenticación, autorización y visibilidad de datos

## Autenticación

| Aspecto                                      | Comportamiento real                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Obtener el token                             | `POST /api/auth/register` (201) o `POST /api/auth/login` (200) → `AuthResponse.accessToken`                                                           |
| Enviar el token                              | Header `Authorization: Bearer <accessToken>` (`ExtractJwt.fromAuthHeaderAsBearerToken`)                                                               |
| Algoritmo                                    | HS256                                                                                                                                                 |
| Payload                                      | `{ sub: userId, email, iat, exp }`. **No incluye roles ni estado**                                                                                    |
| Expiración                                   | `JWT_EXPIRES_IN` (por defecto `1h`; `.env.example` también usa `1h`). Un token vencido responde 401                                                   |
| Validación por petición                      | `JwtStrategy.validate` carga el usuario **desde la BD** en cada petición. Si la cuenta no existe o no está `ACTIVO`, responde 401 `"Sesión inválida"` |
| Usuario actual                               | `GET /api/auth/me` → `PublicUser`, con `roles` y `status` actualizados                                                                                |
| Cierre de sesión                             | **No hay endpoint**: el cliente descarta el token. El token sigue siendo válido hasta `exp`                                                           |
| Refresh, cambio o recuperación de contraseña | **No existen**                                                                                                                                        |
| Cookies                                      | No se usan. CORS no habilita credenciales                                                                                                             |

**Consecuencias para Angular**

- Los roles están en `user.roles` (de `AuthResponse` o de `/auth/me`), no en el JWT.
- Un cambio de rol (por ejemplo, crear el perfil de trabajador otorga `TRABAJADOR`) no requiere un token nuevo: la siguiente petición ya lo reconoce. Basta con volver a pedir `/auth/me` para actualizar la copia local.
- Si un administrador suspende o desactiva la cuenta, el token vigente pasa a responder 401: el interceptor debe cerrar la sesión.
- **Almacenamiento:** las cookies httpOnly no son viables con el backend actual. La opción compatible es mantener el token en memoria (signal) y en `sessionStorage` (o `localStorage` si se quiere persistir), protegiéndose contra XSS.

## Mecanismos de autorización (código)

| Mecanismo                  | Dónde                                                  | Efecto                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Auth(...roles)`          | Rutas de catálogos (admin), bitácora, perfil y pedidos | `JwtAuthGuard` y `RolesGuard`: alguno de los roles indicados; si no, 403 `"No tiene permisos para realizar esta operación"`                                             |
| `@UseGuards(JwtAuthGuard)` | `/auth/me` y todo `/users`                             | Solo exige token. Los permisos de `/users` los aplica el service (propietario o admin)                                                                                  |
| `ApprovedWorkerGuard`      | `/orders/available/*`                                  | Corre después del JWT. Exige cuenta `ACTIVO`, rol `TRABAJADOR` y perfil `APROBADO`; si no, 403 con el motivo (`WorkerEligibility.message`, y `" Motivo: …"` si hay uno) |
| Propietario en el service  | `/users/:id`, `/worker-profile/me/*`, `/orders/me/*`   | Las rutas `me` usan el id del token. Un pedido o documento ajeno responde **404** (no 403), para no revelar que existe                                                  |
| Estado de la entidad       | Perfil, pedidos y solicitudes                          | 409 cuando el estado no permite la acción (ver 04)                                                                                                                      |

## Matriz de acceso por endpoint

Columnas:

- **Pub.**: visitante sin sesión.
- **Cli.**: cuenta con rol `CLIENTE`.
- **Trab.**: rol `TRABAJADOR` (cualquier estado del perfil).
- **Trab. ap.**: trabajador con perfil `APROBADO`.
- **Adm.**: `ADMINISTRADOR`.

✔ permitido · ✘ prohibido · "propio" = solo sobre sus propios datos.

| Endpoint                                                                    | Pub. | Cli.                       | Trab.                               | Trab. ap.                           | Adm.                                     | Restricciones adicionales                                                                       |
| --------------------------------------------------------------------------- | ---- | -------------------------- | ----------------------------------- | ----------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /auth/register`, `POST /auth/login`                                   | ✔    | ✔                          | ✔                                   | ✔                                   | ✔                                        | —                                                                                               |
| `GET /auth/me`                                                              | ✘    | ✔                          | ✔                                   | ✔                                   | ✔                                        | —                                                                                               |
| `GET /users`                                                                | ✘    | ✘                          | ✘                                   | ✘                                   | ✔                                        | —                                                                                               |
| `GET/PATCH /users/:id`                                                      | ✘    | propio                     | propio                              | propio                              | ✔                                        | —                                                                                               |
| `PATCH /users/:id/status`                                                   | ✘    | propio (solo `INACTIVO`)   | propio                              | propio                              | ✔                                        | No dejar la plataforma sin administradores activos                                              |
| `GET /catalogs/{categories,zones}[/:id]`                                    | ✔    | ✔                          | ✔                                   | ✔                                   | ✔                                        | Solo activos                                                                                    |
| `/catalogs/admin/*`, `POST/PATCH /catalogs/*`                               | ✘    | ✘                          | ✘                                   | ✘                                   | ✔                                        | —                                                                                               |
| `GET /audit-logs`                                                           | ✘    | ✘                          | ✘                                   | ✘                                   | ✔                                        | —                                                                                               |
| `/notifications/*`                                                          | ✘    | propio                     | propio                              | propio                              | propio                                   | El destinatario sale del token (no se acepta `userId`). Una notificación ajena responde 404     |
| `POST /worker-profile`                                                      | ✘    | ✔                          | ✔                                   | —                                   | ✘ (salvo que también tenga `CLIENTE`)    | Cuenta `ACTIVO`; un solo perfil por cuenta                                                      |
| `/worker-profile/me/*`                                                      | ✘    | ✘ (403 hasta tener el rol) | propio                              | propio                              | ✘ (salvo que también tenga `TRABAJADOR`) | Ver los estados en 04                                                                           |
| `/worker-profile/admin/*`                                                   | ✘    | ✘                          | ✘                                   | ✘                                   | ✔                                        | Un administrador no resuelve su propia solicitud de zona ni decide sobre su propio perfil (403) |
| `POST /orders`, `POST /orders/duplicate-check`, `/orders/me/*`              | ✘    | propio                     | propio (tiene `CLIENTE`)            | propio                              | ✘ (salvo que también tenga `CLIENTE`)    | Editar y cancelar solo en `PUBLICADO` o `EN_NEGOCIACION`, sin vencer                            |
| `/orders/available/*`                                                       | ✘    | ✘                          | ✘ (403)                             | ✔                                   | ✘                                        | Regla de visibilidad (abajo)                                                                    |
| `GET /orders/assigned/:orderId[/images/:imageId]`                           | ✘    | ✘ (403)                    | solo el **asignado** y **aprobado** | solo el **asignado** y **aprobado** | ✘ (salvo que también sea el asignado)    | Acuerdo vigente (`ACORDADO` a `EN_RECLAMO`); cualquier otro: 404                                |
| `GET /orders/admin`, `GET /orders/admin/:orderId`                           | ✘    | ✘                          | ✘                                   | ✘                                   | ✔                                        | Solo lectura; registro mínimo (T5.4)                                                            |
| `POST /offers/orders/:orderId`                                              | ✘    | ✘                          | ✘ (403)                             | ✔                                   | ✘                                        | Pedido visible para el trabajador (abajo); 404 si no                                            |
| `GET /offers/me[/:offerId]`, `GET /offers/me/:offerId/whatsapp`             | ✘    | ✘ (403)                    | propio                              | propio                              | ✘ (salvo que también tenga `TRABAJADOR`) | Oferta ajena: 404                                                                               |
| `GET /offers/received[/:offerId]`, `GET /offers/received/:offerId/whatsapp` | ✘    | propio                     | propio (tiene `CLIENTE`)            | propio                              | ✘ (salvo que también tenga `CLIENTE`)    | Solo ofertas de pedidos propios: 404 si no                                                      |
| `POST /offers/:offerId/counter`                                             | ✘    | propio, en su turno        | propio, en su turno                 | propio, en su turno                 | ✘                                        | Cliente del pedido o trabajador de la oferta; quien no participa: 404                           |
| `POST /offers/:offerId/reject`, `/accept`                                   | ✘    | propio, en su turno        | —                                   | —                                   | ✘                                        | El trabajador de la oferta recibe 403                                                           |
| `POST /offers/:offerId/withdraw`                                            | ✘    | ✘ (403)                    | propio                              | propio                              | ✘                                        | En cualquier turno                                                                              |

> Toda cuenta registrada tiene `CLIENTE`. Un trabajador también es cliente con la misma cuenta (RF-02, RN-14). El primer administrador, creado con `npm run admin:create-first`, solo tiene el rol `ADMINISTRADOR` (no `CLIENTE`).

## Privacidad del contacto y trabajadores suspendidos

- **#79** (teléfono del cliente): solo con la oferta propia en negociación o
  `ACEPTADA` con el acuerdo vigente, y perfil aprobado. Rechazada, retirada,
  vencida, sin efecto, o con el pedido cerrado o cancelado: 409.
- **#80 y #81** (dirección exacta y fotos): un asignado cuyo perfil deja de
  estar aprobado recibe 403. El cliente dueño y el administrador conservan su
  acceso. Una cuenta suspendida no tiene sesión (401).

- **#78** (teléfono del trabajador): el cliente dueño, con la misma regla de
  vigencia de la oferta (409 si está cerrada o el acuerdo terminó).

## Búsqueda, rechazo del adicional y reportes

| Ruta                       | Quién                                        | Notas                                          |
| -------------------------- | -------------------------------------------- | ---------------------------------------------- |
| #113 rechazar un adicional | `CLIENTE` dueño del pedido (404 si es ajeno) | Pedido en `PRESUPUESTO_ADICIONAL_PENDIENTE`    |
| #114 buscar trabajadores   | `CLIENTE`                                    | Solo datos públicos y horarios; nunca contacto |
| #115 reportes              | `ADMINISTRADOR`                              | Datos agregados, sin datos personales          |

## Cambio de zona pendiente (RF-13)

Con una solicitud `PENDIENTE` el perfil sigue `APROBADO` (`eligible: true`,
`canTakeNewWork: false`). Bloquea solo
las oportunidades nuevas (ver pedidos disponibles, crear ofertas y recibir
asignaciones sin negociación abierta); las negociaciones abiertas y los trabajos
acordados continúan.

| Categoría              | Operaciones                                                                                                                                       | Resultado               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Nuevas oportunidades   | #52–#54 de pedidos que no está negociando; #69 crear una oferta; asignación de un pedido sin oferta vigente suya (interna); `findApprovedWorkers` | Ocultos (404) o **409** |
| Negociaciones abiertas | #74 contraofertar, #75 rechazar, #76 retirar, #77 aceptar                                                                                         | Normal                  |
| Trabajos acordados     | #83–#87, #101 (anticipo y saldo) y las acciones del cliente (#88–#92, #101)                                                                       | Normal                  |
| Consultas              | #70–#73, #78–#82, #93, #99, #100, #103–#112                                                                                                       | Normal                  |

Mensaje del 409: `"Tiene una solicitud de cambio de zona pendiente: no puede
ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire."`.

No cambian las demás validaciones: perfil `APROBADO`, cuenta activa y rol (403),
participación en el pedido (404), turno, estados, monto del anticipo y que solo
el trabajador asignado lo confirme.

**Crear la solicitud (#36)** exige no tener pedidos asignados de `ACORDADO` a
`EN_RECLAMO` ni ofertas `VIGENTE` sin vencer de pedidos abiertos
(`TRABAJO_ACTIVO`). Por eso, en el uso normal, junto a una solicitud pendiente
quedan sobre todo pagos de pedidos `CERRADO`.

**Pedidos disponibles:** mientras está pendiente, #52 devuelve solo los pedidos
en los que el trabajador tiene una oferta vigente (en el uso normal, una lista
vacía con `total: 0`), y #53 y #54 responden 404 para los demás. No es un error:
use `canTakeNewWork` (#30) para explicar la lista vacía. Al retirar o rechazarse
la solicitud vuelven a verse; **tras aprobarse**, corresponden a la zona nueva,
igual que las ofertas nuevas.

## Visibilidad de datos por rol

| Dato                                        | Visitante | Cliente dueño                                                                | Otro cliente | Trabajador aprobado                                                                                  | Administrador                                                                                             |
| ------------------------------------------- | --------- | ---------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Datos de una cuenta (`PublicUser`)          | ✘         | la propia                                                                    | ✘            | la propia                                                                                            | todas                                                                                                     |
| Teléfono y correo de un trabajador          | ✘         | el teléfono, solo dentro del enlace de WhatsApp de una oferta recibida (#78) | ✘            | el propio                                                                                            | ✔ (en solicitudes de zona y usuarios)                                                                     |
| Perfil de trabajador completo               | ✘         | —                                                                            | ✘            | el propio                                                                                            | ✔ listado (#56) y detalle (#57), **salvo el propio**                                                      |
| Motivo de observación, rechazo o suspensión | ✘         | —                                                                            | ✘            | solo el propio (`/me/status`, `/me/eligibility` y su notificación)                                   | lo escribe; lo ve en el detalle (#57) y en la bitácora (#22)                                              |
| Quién decidió cada cambio de estado         | ✘         | —                                                                            | ✘            | solo `TRABAJADOR` o `ADMINISTRADOR`                                                                  | nombre e id (#57)                                                                                         |
| Documentos del trabajador                   | ✘         | —                                                                            | ✘            | los propios (listar y descargar)                                                                     | ✔ listar, ver y descargar (#58–#60), **salvo los de su propio perfil**; cada acceso queda en la bitácora  |
| Pedido (datos generales)                    | ✘         | ✔ (también cerrado: registro histórico)                                      | ✘            | solo los visibles                                                                                    | registro mínimo (#67–#68): sin dirección, fotos ni descripción; sin nombre del cliente si fue anonimizado |
| Dirección exacta del pedido                 | ✘         | ✔                                                                            | ✘            | solo el trabajador **asignado**, con acuerdo vigente (#80; adenda §2.2)                              | ✘                                                                                                         |
| Datos del cliente en el pedido              | ✘         | —                                                                            | ✘            | el asignado: nombre (#80); el teléfono, solo dentro del enlace de WhatsApp de su propia oferta (#79) | ✘                                                                                                         |
| Ofertas e historial de negociación          | ✘         | las de sus pedidos, con nombre del trabajador (#72, #73)                     | ✘            | las propias (#70, #71)                                                                               | ✘ (no hay endpoint)                                                                                       |
| Fotos del pedido                            | ✘         | ✔ (hasta que el pedido vence o se cancela: se borran)                        | ✘            | de pedidos visibles; el asignado, del pedido acordado (#81)                                          | ✘                                                                                                         |
| Historial de estados del pedido             | ✘         | ✘ (no expuesto)                                                              | ✘            | ✘                                                                                                    | ✘                                                                                                         |
| Bitácora                                    | ✘         | ✘                                                                            | ✘            | ✘                                                                                                    | ✔                                                                                                         |
| Notificaciones                              | ✘         | las propias                                                                  | ✘            | las propias                                                                                          | las propias (las de verificación no incluyen datos personales del trabajador ni el motivo)                |

### Regla de visibilidad de pedidos para trabajadores (RF-17)

`OrderVisibilityService.visibleWhere`, aplicada igual al listado, al detalle y a las fotos. Un pedido es visible si se cumplen **todas** estas condiciones:

1. El trabajador tiene perfil `APROBADO`, cuenta `ACTIVO` y rol `TRABAJADOR` (guard).
2. `pedido.zoneId` es la zona del trabajador, y esa zona está **activa**.
3. `pedido.categoryId` está entre sus especialidades, y esa categoría está **activa**.
4. El pedido no es suyo como cliente (RN-14).
5. La cuenta del cliente está `ACTIVO`.
6. El estado es `PUBLICADO` o `EN_NEGOCIACION`, con `expiresAt` todavía en el futuro (T5.1: ambos vencen).

Si no se cumple alguna condición, responde **404** (igual que un pedido inexistente).

### Restricciones que dependen del estado

| Acción                                               | Estado requerido                                                                                                                                                                                                                                                   | Respuesta si no se cumple                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Editar el perfil, especialidades o documentos        | Perfil `BORRADOR`, `OBSERVADO`, `RECHAZADO` o `SUSPENDIDO`. La zona solo en `BORRADOR` (403)                                                                                                                                                                       | 409                                                                                                                                         |
| Cambiar la zona directamente                         | Perfil `BORRADOR`                                                                                                                                                                                                                                                  | 403 (hay que usar una solicitud)                                                                                                            |
| Aprobar un cambio de zona                            | Administrador activo, no su propia solicitud; perfil no `SUSPENDIDO` ni `RECHAZADO`; cuenta del trabajador no `SUSPENDIDO` (T4-F3); zona destino activa                                                                                                            | 403 o 409                                                                                                                                   |
| Aprobar o reactivar un perfil (#55)                  | Requisitos vigentes: teléfono, especialidades activas, zona activa y un horario activo (T4-F1), comprobados con bloqueos dentro de la transacción                                                                                                                  | 409 con la lista                                                                                                                            |
| Rechazar un cambio de zona                           | Administrador activo, no su propia solicitud; motivo no vacío                                                                                                                                                                                                      | 403 o 400                                                                                                                                   |
| Retirar una solicitud de cambio de zona              | Solo la propia (404 si es ajena) y `PENDIENTE`                                                                                                                                                                                                                     | 404 o 409                                                                                                                                   |
| Reasignar la zona de un perfil (#66)                 | Administrador activo, no su propio perfil (403); perfil `RECHAZADO`, `OBSERVADO`, `PENDIENTE` o `SUSPENDIDO` (409), que conserva su estado, con la zona actual inactiva (409); zona destino existente (404), activa y distinta (400); justificación no vacía (400) | 400, 403, 404 o 409                                                                                                                         |
| Contraofertar, rechazar, retirar o aceptar (#74–#77) | Oferta `VIGENTE` sin vencer; pedido `PUBLICADO` o `EN_NEGOCIACION` sin vencer (aceptar: `EN_NEGOCIACION`); turno propio (salvo retirar); contraofertar y aceptar además exigen zona y categoría activas, cliente activo y trabajador aprobado                      | 403, 404 o 409                                                                                                                              |
| Ofertar o recibir un trabajo nuevo                   | Perfil `APROBADO`, cuenta activa y **sin** solicitud de cambio de zona `PENDIENTE` (RF-13). Ver [Cambio de zona pendiente](#cambio-de-zona-pendiente-rf-13)                                                                                                        | 403 o 409 `"Tiene una solicitud de cambio de zona pendiente: no puede ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire."` |
| Enviar a revisión (o reenviar)                       | `BORRADOR`, `OBSERVADO` o `RECHAZADO`, sin requisitos pendientes                                                                                                                                                                                                   | 409 o 400                                                                                                                                   |
| Solicitar cambio de zona                             | Perfil `APROBADO` (T4.2); sin solicitud pendiente; sin pedidos ni ofertas activos (RF-13)                                                                                                                                                                          | 409 con un arreglo de motivos                                                                                                               |
| Editar un pedido o sus fotos, cancelarlo             | Estado efectivo `PUBLICADO` o `EN_NEGOCIACION`                                                                                                                                                                                                                     | 409 (mensaje según el estado)                                                                                                               |
| Decidir una solicitud de zona                        | `PENDIENTE`; al aprobar, zona destino activa y zona del perfil sin cambios                                                                                                                                                                                         | 409                                                                                                                                         |
| Decidir sobre un perfil (#55)                        | Transición permitida por `ADMIN_TRANSITIONS`; al aprobar desde `PENDIENTE`, requisitos de envío vigentes; nunca sobre el propio perfil                                                                                                                             | 409; 403 si es el propio                                                                                                                    |

**Para la interfaz:** use `canEdit` y `canSubmit` (perfil), `canEdit` y `canCancel` (pedido), `canRequestChange` y `blockers` (zona), y `eligible` (trabajador) para mostrar u ocultar acciones. El backend vuelve a validar todo.

## Endpoints del Sprint 1 (#82–#112)

Detalle en [10](10-sprint1-endpoints.md). Un recurso ajeno responde 404.

| Endpoints                                   | Público | Cliente dueño | Trabajador asignado                        | Administrador |
| ------------------------------------------- | ------- | ------------- | ------------------------------------------ | ------------- |
| #82, #93 (consulta del flujo y del reclamo) | ✘       | ✔             | ✔ (el reclamo, solo estado y decisión)     | ✘             |
| #83–#87 (acciones del trabajador)           | ✘       | ✘             | ✔ con perfil aprobado                      | ✘             |
| #88–#92 (acciones del cliente)              | ✘       | ✔             | ✘                                          | ✘             |
| #94 foto del reclamo                        | ✘       | ✔             | ✘                                          | ✔             |
| #95–#98, #102, #108, #109                   | ✘       | ✘             | ✘                                          | ✔             |
| #99, #100, #112                             | ✘       | ✔             | ✔                                          | ✔             |
| #101, #103, #104                            | ✘       | ✔             | ✔ (en #101, el trabajador además aprobado) | ✘             |
| #105 (calificaciones recibidas)             | ✘       | las propias   | las propias                                | ✘             |
| #106, #107 (perfil público)                 | ✔       | ✔             | ✔                                          | ✔             |
| #110, #111 (agenda)                         | ✘       | ✘             | propia, con perfil aprobado                | ✘             |

Una cuenta que solo es `ADMINISTRADOR` recibe 403 donde la tabla marca ✘.
