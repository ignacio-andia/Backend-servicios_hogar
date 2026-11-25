# OffersModule: ofertas y negociación (RF-19 a RF-24)

Guía de mantenimiento e integración del módulo de ofertas (primera entrega, T6.1 a T6.6).

- **Contratos HTTP** (tablas de endpoints, DTO, modelos, enums, permisos y tipos Angular): en [`docs/frontend-api-contracts/`](../../../docs/frontend-api-contracts/README.md), endpoints **#69 a #79**. Este README no los repite campo por campo: explica las reglas y cómo usarlos.
- **Código:** `src/modules/offers/`. Modelo y migración: `prisma/schema.prisma` (`Offer`, `OfferEvent`) y `prisma/migrations/20261124000000_create_offers/`.

## 1. Qué hace y qué no

| Implementado                                                  | Pendiente conocido (no existe)                              |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| Crear y consultar ofertas (trabajador y cliente)              | —                                                           |
| Contraofertas por turnos, hasta 3 rondas                      | Endpoint propio de ofertas para el administrador            |
| Rechazo (cliente), retiro (trabajador) y aceptación (cliente) | Parámetros de vigencia y rondas configurables (RF-23)       |
| Asignación del trabajador al aceptar (`ACORDADO`)             | —                                                           |
| Vencimiento automático a las 24 horas                         | `SIN_ACUERDO` como estado del pedido (decisión: no se usa)  |
| Cierre por pedido cancelado o vencido y por suspensiones      | Cierre de ofertas al **desactivar** (`INACTIVO`) una cuenta |
| Control de cruces con trabajos ya acordados (RF-30)           | Qué pasa con un acuerdo si se suspende una parte (RF-34)    |
| Enlace de WhatsApp entre las partes (T6.6)                    | Chat interno (decisión del docente: no en esta entrega)     |

## 2. Estados

### Oferta (`OfferStatus`)

| Estado       | Significado                                                                    | ¿Abierta?                  |
| ------------ | ------------------------------------------------------------------------------ | -------------------------- |
| `VIGENTE`    | En negociación                                                                 | ✔ (si `expiresAt` no pasó) |
| `ACEPTADA`   | El cliente la aceptó: el pedido pasó a `ACORDADO`                              | ✘                          |
| `RECHAZADA`  | El cliente la rechazó                                                          | ✘                          |
| `RETIRADA`   | El trabajador la retiró                                                        | ✘                          |
| `VENCIDA`    | Pasaron 24 horas sin respuesta, o venció el pedido                             | ✘                          |
| `SIN_EFECTO` | Se aceptó otra oferta, se canceló el pedido o se suspendió una cuenta o perfil | ✘                          |

- Todo estado distinto de `VIGENTE` es **final**: la base de datos impide reabrir o modificar una oferta cerrada (trigger `offers_guard`).
- **Estado efectivo:** una oferta `VIGENTE` con `expiresAt` cumplido se devuelve como `VENCIDA` en todas las respuestas y no admite ninguna operación, aunque la tarea automática todavía no la haya cerrado. El filtro `status` de los listados usa ese mismo criterio.
- `turn` (`OfferParty`): `CLIENTE` o `TRABAJADOR`, la parte que debe responder.

### Pedido (lo cambia siempre OrdersModule)

| Evento de ofertas                                                                | Transición del pedido                                                 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Primera oferta                                                                   | `PUBLICADO` → `EN_NEGOCIACION`                                        |
| Rechazo, retiro, vencimiento o cierre por suspensión, sin otras ofertas vigentes | `EN_NEGOCIACION` → `PUBLICADO` (conserva `publishedAt` y `expiresAt`) |
| Aceptación                                                                       | `EN_NEGOCIACION` → `ACORDADO`, con el trabajador asignado             |
| Cancelación o vencimiento del pedido                                             | Ninguna adicional: las ofertas se cierran                             |

Offers nunca escribe el estado ni el trabajador asignado del pedido: usa `OrdersService.transition()`.

## 3. Reglas funcionales

### Crear una oferta (RF-19, RF-22, RF-24, RF-31)

- Solo un trabajador **aprobado**, con la cuenta activa y **sin** solicitud de cambio de zona pendiente (es una oportunidad nueva, RF-13).
- El pedido debe ser **visible** para él: su zona, una categoría que esté entre sus especialidades **actuales**, zona y categoría activas, cliente activo, pedido `PUBLICADO` o `EN_NEGOCIACION` sin vencer y **no propio** (RN-14). Si no, **404** (igual que un pedido inexistente).
- Datos: `amount` > 0; `requiresVisit` con `visitCost` (≥ 0, `"0"` = gratis) solo si requiere visita; `materialsIncluded`; `proposedStartAt` futuro; `estimatedDurationMinutes` ≥ 1.
- **El horario de atención no limita las ofertas** (aclaración del docente): el trabajador oferta a cualquier hora y negocia el horario con el cliente.
- Nace `VIGENTE`, ronda 1, turno del `CLIENTE`, vigencia de **24 horas** con el reloj de la BD, y su evento `PROPUESTA`.
- **Una oferta por trabajador y pedido**:
  - con otra `VIGENTE` sin vencer: 409;
  - si alguna anterior quedó `ACEPTADA`, `RECHAZADA`, `RETIRADA` o `SIN_EFECTO`: 409 (no puede volver a ofertar);
  - si la anterior está `VENCIDA`: puede volver a ofertar (una `VIGENTE` ya vencida se cierra primero como `VENCIDA`).

### Contraofertas (RF-20, RF-23)

- La propuesta inicial es la ronda 1; la primera contraoferta, la 2; la segunda, la **3** (máximo).
- **Turnos alternos:** tras la propuesta responde el cliente; cada contraoferta pasa el turno a la otra parte. Fuera de turno: 409.
- **Solo cambia el monto.** Visita, materiales, horario y duración son los de la oferta original (la BD lo impone).
- Cada contraoferta **reinicia la vigencia de 24 horas**.
- En la ronda 3 ya no hay contraofertas: quien tiene el turno solo puede aceptar o rechazar (o el trabajador retirar).
- Además exige: oferta `VIGENTE` sin vencer, pedido `PUBLICADO` o `EN_NEGOCIACION` sin vencer, zona y categoría activas, cliente activo y trabajador aprobado (un cambio de zona pendiente no lo impide). **No** exige la especialidad de la categoría actual (si el cliente cambió la categoría, la negociación existente continúa).

### Rechazo y retiro

- **Rechazar:** solo el cliente dueño, **en su turno**. La oferta pasa a `RECHAZADA` y ese trabajador no puede volver a ofertar en el pedido.
- **Retirar:** solo el trabajador de la oferta, **en cualquier turno**. Pasa a `RETIRADA` y no puede volver a ofertar.
- Ambos exigen oferta `VIGENTE` sin vencer y pedido `PUBLICADO` o `EN_NEGOCIACION` sin vencer.
- Si no quedan ofertas vigentes, el pedido vuelve a `PUBLICADO`.

### Aceptación y asignación (RF-20)

- Solo el cliente dueño, **en su turno**, con:
  - oferta `VIGENTE` sin vencer;
  - pedido `EN_NEGOCIACION`, sin vencer y sin trabajador asignado;
  - zona y categoría activas;
  - cuentas del cliente y del trabajador activas;
  - trabajador aprobado (un cambio de zona pendiente no lo impide).
- **No** exige la especialidad de la categoría actual: una oferta creada antes de un cambio de categoría se puede aceptar.
- **Cruces de agenda (RF-30, RF-31):** el horario de la oferta, `[proposedStartAt, proposedStartAt + estimatedDurationMinutes)`, no puede superponerse con otro trabajo activo del trabajador. Cuentan como activos los pedidos asignados en los estados que define OrdersModule (`ACTIVE_ORDER_STATUSES`), con el horario de su oferta aceptada. Un trabajo que empieza justo cuando termina otro no es un cruce. Si hay cruce: 409 con el pedido en conflicto.
- En una sola transacción:
  1. la oferta pasa a `ACEPTADA` (evento `ACEPTADA`);
  2. el pedido pasa a `ACORDADO` con el trabajador asignado (OrdersModule exige
     esa oferta aceptada: `OffersAcceptedOfferSource`);
  3. **todas las demás ofertas `VIGENTE` del pedido** pasan a `SIN_EFECTO`, con un evento del sistema (`ACEPTACION_OFERTA`) y el motivo `"El cliente aceptó otra oferta para este pedido."`.
- Las ofertas de otros pedidos no se tocan.

### Vencimiento automático (T6.5.1)

- `OfferExpirationService` corre **al arrancar** el servidor (recupera lo que venció con el servidor apagado) y luego cada `OFFER_EXPIRATION_INTERVAL_MINUTES` minutos (por defecto **5**, máximo 1440). Se apaga con `SCHEDULED_JOBS_ENABLED=false`.
- Cierra como `VENCIDA` las ofertas `VIGENTE` con `expiresAt <= now()` (reloj de la BD), con un evento del sistema (`VENCIMIENTO_OFERTA`), y devuelve a `PUBLICADO` el pedido que se queda sin ofertas vigentes.
- Un pedido vencido o cancelado no cambia de estado; sus ofertas igual se cierran.

### Cierres por cambios externos (T6.5.2)

Todos con actor `SISTEMA`, proceso `CIERRE_OFERTAS` y el motivo en `OfferEvent.reason`. Solo se cierran ofertas `VIGENTE`; las ya cerradas no se tocan.

| Cambio                           | Ofertas afectadas                 | Estado       | `reason`                | Pedido                                           |
| -------------------------------- | --------------------------------- | ------------ | ----------------------- | ------------------------------------------------ |
| Pedido cancelado por el cliente  | Todas las del pedido              | `SIN_EFECTO` | `PEDIDO_CANCELADO`      | Queda `CANCELADO`                                |
| Pedido vencido (7 días)          | Todas las del pedido              | `VENCIDA`    | `PEDIDO_VENCIDO`        | Queda `VENCIDO`                                  |
| Cuenta del cliente suspendida    | Las de todos sus pedidos abiertos | `SIN_EFECTO` | `CLIENTE_SUSPENDIDO`    | Vuelve a `PUBLICADO` si estaba `EN_NEGOCIACION`  |
| Cuenta del trabajador suspendida | Solo las suyas                    | `SIN_EFECTO` | `TRABAJADOR_SUSPENDIDO` | Vuelve a `PUBLICADO` si no quedan otras vigentes |
| Perfil del trabajador suspendido | Solo las suyas                    | `SIN_EFECTO` | `PERFIL_SUSPENDIDO`     | Igual que la fila anterior                       |

Reactivar una cuenta o un perfil **no** reabre las ofertas.

### Historial (RF-21)

- `offer_events` es **solo inserción**: cada propuesta, contraoferta y cierre queda con tipo, ronda, monto (solo en `PROPUESTA` y `CONTRAOFERTA`), actor (usuario y rol, o proceso del sistema), motivo y fecha.
- La BD impide modificarlo o borrarlo, y admite una sola propuesta o contraoferta por ronda y un solo cierre por oferta.
- El detalle de la oferta lo devuelve en `history`, del más antiguo al más reciente.

### Cambio de zona del trabajador (RF-13)

| Situación                                                      | Con una solicitud pendiente |
| -------------------------------------------------------------- | --------------------------- |
| Nueva oportunidad: crear una oferta                            | **409**                     |
| Negociación abierta: contraofertar, aceptar, rechazar, retirar | Permitido                   |

- `OffersActiveWorkSource` registra la fuente `OFERTAS`: con una oferta
  `VIGENTE` sin vencer en un pedido abierto y sin vencer no se puede **solicitar**
  el cambio. Las `ACEPTADA` y las cerradas no cuentan.
- `OffersOpenNegotiationSource` confirma a OrdersModule que aceptar continúa una
  negociación abierta, para que la asignación no se trate como trabajo nuevo.
- Contraofertar y aceptar deciden el vencimiento de la oferta y del pedido con
  `clock_timestamp()`, ya con los bloqueos: una oferta que la solicitud ya no
  contó no puede continuarse.

## 4. Contacto por WhatsApp (T6.6)

WhatsApp es **solo un canal externo**. Abrir el enlace no envía nada, no acepta ni modifica la oferta y no registra acuerdos: los montos y condiciones oficiales son los de la plataforma. El backend no sabe si el mensaje se envió.

| Endpoint                                     | Quién                         | Contacto                |
| -------------------------------------------- | ----------------------------- | ----------------------- |
| `GET /api/offers/received/:offerId/whatsapp` | Cliente dueño del pedido      | Trabajador de la oferta |
| `GET /api/offers/me/:offerId/whatsapp`       | Trabajador dueño de la oferta | Cliente del pedido      |

**Acceso:** una oferta ajena o de otro pedido responde 404, un rol incorrecto
403 y un visitante 401.

- **Cliente** (teléfono del trabajador) y **trabajador** (teléfono del cliente):
  solo con la oferta `VIGENTE` sin vencer en un pedido abierto, o `ACEPTADA` con
  el trabajador todavía asignado y el acuerdo vigente (`ACORDADO` a
  `EN_RECLAMO`). En cualquier otro caso, **409** sin ningún dato. El trabajador
  necesita además el perfil aprobado (403).

La negociación de una oferta cerrada sigue bloqueada.

**Teléfono:** se usa `users.phone`. No hay un campo específico de WhatsApp. Al registrarse se acepta con o sin `+` (`/^\+?[1-9]\d{6,14}$/`).

**Normalización del número** (solo dígitos, con código de país, sin `+`, espacios, paréntesis ni guiones):

| Guardado                                          | Número para `wa.me`          | Regla                                                                       |
| ------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `70000001`, `61234567`                            | `59170000001`, `59161234567` | Celular boliviano local (8 dígitos que empiezan con 6 o 7): se agrega `591` |
| `59170000001`                                     | `59170000001`                | Ya trae el 591 (11 dígitos)                                                 |
| `+59170000001`, `+591 7000-0001`, `0059170000001` | `59170000001`                | Internacional: se quitan `+`/`00` y separadores (8 a 15 dígitos)            |
| `4123456` (fijo), `80000001`, vacío               | —                            | Sin enlace                                                                  |

**Enlace:** `https://wa.me/NUMERO?text=MENSAJE`, con el mensaje codificado (`encodeURIComponent`). El mensaje solo identifica el pedido por una **referencia corta**: los primeros 8 caracteres de su id, en mayúsculas.

- Del cliente al trabajador: `Hola, te escribo por tu oferta para mi pedido 3F2A9C1D en ArreglaloYA.`
- Del trabajador al cliente: `Hola, te escribo por mi oferta para tu pedido 3F2A9C1D en ArreglaloYA.`

Nunca lleva dirección, nombres, montos ni documentos.

**Respuesta** (siempre 200 si hay acceso):

```json
{
  "available": true,
  "channel": "WHATSAPP",
  "contactRole": "TRABAJADOR",
  "url": "https://wa.me/59170000001?text=Hola%2C%20te%20escribo%20por%20tu%20oferta%20para%20mi%20pedido%203F2A9C1D%20en%20ArreglaloYA."
}
```

```json
{
  "available": false,
  "channel": "WHATSAPP",
  "contactRole": "CLIENTE",
  "url": null,
  "reason": "TELEFONO_NO_REGISTRADO"
}
```

`reason`: `TELEFONO_NO_REGISTRADO` o `TELEFONO_INVALIDO`. Con `available: false`, el frontend oculta o deshabilita el botón. El teléfono nunca se devuelve por separado: solo va dentro de `url`. Ningún listado ni detalle de ofertas o pedidos incluye teléfonos.

## 5. Integración con Angular

Todas las llamadas llevan `Authorization: Bearer <token>`. Los montos se envían como texto (`"120.50"`) o número y se devuelven siempre como texto con 2 decimales. Las fechas se devuelven en ISO 8601 UTC.

> **`proposedStartAt` exige zona horaria** (G1): `2026-11-30T10:00:00-04:00` o `2026-11-30T14:00:00.000Z` (lo que devuelve `toISOString()`). Sin zona (`2026-11-30T10:00:00`) o solo la fecha, responde **400**.

### Crear una oferta (trabajador)

```http
POST /api/offers/orders/7c1e0b2a-5d3f-4e8a-9b61-2f0c4d8e9a10
Content-Type: application/json

{
  "amount": "120.50",
  "requiresVisit": true,
  "visitCost": "0",
  "materialsIncluded": false,
  "proposedStartAt": "2026-11-30T10:00:00-04:00",
  "estimatedDurationMinutes": 90
}
```

Respuesta **201** (`OfferDetail<OfferView>`):

```json
{
  "id": "5b0d9e4c-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  "orderId": "7c1e0b2a-5d3f-4e8a-9b61-2f0c4d8e9a10",
  "status": "VIGENTE",
  "round": 1,
  "amount": "120.50",
  "turn": "CLIENTE",
  "requiresVisit": true,
  "visitCost": "0.00",
  "materialsIncluded": false,
  "proposedStartAt": "2026-11-30T14:00:00.000Z",
  "estimatedDurationMinutes": 90,
  "expiresAt": "2026-11-25T15:00:00.000Z",
  "closedAt": null,
  "createdAt": "2026-11-24T15:00:00.000Z",
  "updatedAt": "2026-11-24T15:00:00.000Z",
  "history": [
    {
      "type": "PROPUESTA",
      "round": 1,
      "amount": "120.50",
      "actorType": "USUARIO",
      "actorRole": "TRABAJADOR",
      "systemProcess": null,
      "reason": null,
      "createdAt": "2026-11-24T15:00:00.000Z"
    }
  ]
}
```

### Consultar ofertas propias (trabajador)

`GET /api/offers/me?status=VIGENTE&page=1&limit=20` responde `Paginated<OfferView>` (sin `history`):

```json
{
  "data": [
    { "id": "…", "orderId": "…", "status": "VIGENTE", "round": 1, "...": "..." }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Para el detalle con historial: `GET /api/offers/me/:offerId`.

### Consultar ofertas recibidas (cliente)

`GET /api/offers/received?orderId=<id>&status=VIGENTE&page=1&limit=20` responde `Paginated<ReceivedOfferView>`. Es igual a `OfferView` más el trabajador, sin datos de contacto:

```json
{ "worker": { "id": "<id>", "firstName": "Ana", "lastName": "Rojas" } }
```

Para el detalle con historial: `GET /api/offers/received/:offerId`. Un `orderId` de otro cliente responde 404.

### Contraofertar (cliente o trabajador, según `turn`)

```http
POST /api/offers/:offerId/counter
Content-Type: application/json

{ "amount": "100" }
```

Responde **200** con el detalle actualizado: `round` +1, `turn` invertido, `amount: "100.00"`, nuevo `expiresAt` y un evento `CONTRAOFERTA` en `history`. Cualquier otro campo del cuerpo responde 400.

### Rechazar (cliente), retirar (trabajador) y aceptar (cliente)

```http
POST /api/offers/:offerId/reject
POST /api/offers/:offerId/withdraw
POST /api/offers/:offerId/accept
```

Van sin cuerpo (lo que se envíe se ignora) y responden **200** con el detalle: `status` en `RECHAZADA`, `RETIRADA` o `ACEPTADA`, `closedAt` y el evento de cierre en `history`.

Después de aceptar, el pedido queda `ACORDADO`:

- el cliente lo consulta en `GET /api/orders/me/:orderId`;
- el trabajador asignado, con la **dirección exacta**, en `GET /api/orders/assigned/:orderId` y sus fotos en `GET /api/orders/assigned/:orderId/images/:imageId` (OrdersModule, G2). Otro trabajador recibe 404.

### Obtener el enlace de WhatsApp

`GET /api/offers/received/:offerId/whatsapp` (cliente) o `GET /api/offers/me/:offerId/whatsapp` (trabajador). Ver la sección 4.

### Qué debe manejar el frontend

| Situación                                                                                                                                                        | Respuesta                                                                                                  | Qué hacer                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mostrar acciones                                                                                                                                                 | `status`, `turn`, `round`, `expiresAt`                                                                     | Solo con `status: "VIGENTE"`. Cliente: aceptar y rechazar con `turn: "CLIENTE"`; contraofertar si además `round < 3`. Trabajador: contraofertar con `turn: "TRABAJADOR"` y `round < 3`; retirar siempre que esté `VIGENTE` |
| Resumen antes de aceptar (RF-22)                                                                                                                                 | `amount`, `requiresVisit`, `visitCost`, `materialsIncluded`, `proposedStartAt`, `estimatedDurationMinutes` | Mostrar todos los datos; `visitCost: "0.00"` = visita gratis                                                                                                                                                               |
| Datos inválidos                                                                                                                                                  | 400 (`message`: texto o arreglo de textos)                                                                 | Mostrar los mensajes en el formulario                                                                                                                                                                                      |
| Sin sesión                                                                                                                                                       | 401                                                                                                        | Ir al inicio de sesión                                                                                                                                                                                                     |
| Rol incorrecto, trabajador no aprobado o suspendido, o acción de la otra parte                                                                                   | 403                                                                                                        | Mostrar el mensaje; no reintentar                                                                                                                                                                                          |
| Pedido u oferta que no le corresponde                                                                                                                            | 404                                                                                                        | Tratar como inexistente                                                                                                                                                                                                    |
| Turno ajeno, oferta cerrada o vencida, pedido no negociable, catálogo inactivo, cruce de agenda, cambio de zona pendiente (solo al crear) u operación simultánea | 409                                                                                                        | Mostrar `message` y **volver a consultar** la oferta (y el pedido)                                                                                                                                                         |
| Contacto sin teléfono válido                                                                                                                                     | 200 con `available: false`                                                                                 | Ocultar o deshabilitar el botón de WhatsApp                                                                                                                                                                                |

El estado puede cambiar sin intervención del usuario (vencimiento automático, aceptación de otra oferta, cancelación o suspensión): ante un 409, la vista debe refrescarse desde el backend.

## 6. Mantenimiento

### Archivos

| Archivo                       | Responsabilidad                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `offers.controller.ts`        | Rutas y roles (sin lógica)                                                                                  |
| `offers.service.ts`           | Crear, contraofertar, rechazar, retirar, aceptar, cerrar por eventos externos, vencer, consultar y contacto |
| `offer-negotiation.ts`        | Reglas puras sobre la oferta bloqueada (turno, ronda, vigencia, cruces de horario)                          |
| `offer-views.ts`              | Vistas, estado efectivo y filtro por estado                                                                 |
| `offer-contact.ts`            | Normalización del teléfono, mensaje y enlace de WhatsApp                                                    |
| `offer-expiration.service.ts` | Tarea programada de vencimiento                                                                             |
| `offers-closure.hooks.ts`     | Registro en los puntos de extensión de otros módulos                                                        |
| `offers.rules.ts`             | Constantes: 24 h, 3 rondas, motivos y procesos del sistema                                                  |
| `dto/`                        | `CreateOfferDto`, `CounterOfferDto`, `ListOffersQueryDto`, `ListReceivedOffersQueryDto`                     |

### Dependencias (sin ciclos: ninguno de estos módulos importa OffersModule)

| Módulo              | Qué usa Offers                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OrdersModule        | `OrderVisibilityService.assertOpenForOffers`, `OrdersService.transition`, `OrdersService.getOwn`, `OrdersService.findActiveAssignedOrderIds`, `lockOrder`, `ORDER_OPEN_FOR_OFFERS_STATUSES`, `OrderLifecycleRegistry`, `OpenNegotiationRegistry` |
| WorkerProfileModule | `ApprovedWorkerGuard`, `WorkerProfileService.lockApprovedWorkerForAgreedWork`, `WorkerActiveWorkRegistry` (`lockWorker` y fuente `OFERTAS`), `WorkerProfileStatusRegistry`                                                                       |
| UsersModule         | `UsersService.findByIdForShare` y `findById`, `AccountStatusRegistry`                                                                                                                                                                            |
| CatalogsModule      | `CatalogsService.findByIdsForShare`                                                                                                                                                                                                              |

### Orden de bloqueos

**cuenta del cliente** (`FOR SHARE`) → **trabajador** (perfil) → **pedido** (`lockOrder`) → **fila de la oferta** (`FOR UPDATE`) → **zona y categoría** (`FOR SHARE`).

- Ninguna operación bloquea un nivel anterior después de uno posterior.
- Toda operación que crea o cierra ofertas bloquea antes el pedido, por eso el conteo de ofertas vigentes que decide la vuelta a `PUBLICADO` es consistente.
- Los hooks de `OrderLifecycleRegistry` corren con el pedido ya bloqueado y nunca bloquean al trabajador.

**Respaldos en la BD:**

- una sola oferta `VIGENTE` por trabajador y pedido;
- una sola `ACEPTADA` por pedido;
- una propuesta o contraoferta por ronda;
- un cierre por oferta;
- condiciones inmutables y ofertas cerradas inmodificables.

Una violación de unicidad se traduce a 409.

### Pruebas

- Unitarias: `src/modules/offers/*.spec.ts`.
- E2E: `test/offers.e2e-spec.ts`. Cubre concurrencia real contra PostgreSQL. La limpieza de datos está en `test/utils/orders-cleanup.ts`: las ofertas y sus eventos se borran antes que los pedidos, con `app.audit_maintenance`.
