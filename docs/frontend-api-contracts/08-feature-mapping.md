# 08. Correspondencia entre módulos funcionales y backend

Organizado por los 12 grupos de requerimientos (RF-01 a RF-56). Los números `#` remiten al inventario de [01](01-endpoints-inventory.md).

Leyenda: ✅ implementado · 🟡 parcial · 📐 diseñado, sin endpoint · ⛔ no implementado · ❓ pendiente de decisión.

## 1. Cuentas y roles (RF-01 a RF-05)

| RF | Estado | Contrato disponible | Notas |
|---|---|---|---|
| RF-01 Registro, inicio y cierre de sesión | 🟡 | #1, #2, #3 (`RegisterDto`, `LoginDto` → `AuthResponse`, `PublicUser`) | El cierre de sesión es solo del lado del cliente (no hay endpoint ni revocación) |
| RF-02 Trabajador que también es cliente | ✅ | Roles múltiples en `PublicUser.roles` | `POST /worker-profile` agrega `TRABAJADOR` sin quitar `CLIENTE` |
| RF-03 Funciones de trabajador solo con perfil aprobado | ✅ | `ApprovedWorkerGuard` (#52–#54), #30 elegibilidad | No hay forma de llegar a `APROBADO` por la API (ver grupo 2) |
| RF-04 Administradores creados internamente | ⛔ | — | No hay endpoint, script ni seed: se crean directamente en la BD |
| RF-05 Recuperar contraseña | ⛔ | — | — |
| Gestión de la propia cuenta | ✅ | #5, #6, #7 | Editar nombre y teléfono; desactivar la propia cuenta |
| Gestión de usuarios (admin) | 🟡 | #4 (sin filtros), #5–#7 | No hay asignación ni retiro de roles |

**Dependencias:** todo el resto usa el JWT y `PublicUser.roles`.

## 2. Perfil y verificación del trabajador (RF-06 a RF-13)

| RF | Estado | Contrato disponible | Notas |
|---|---|---|---|
| RF-06 Datos, experiencia, especialidades, zona y horarios | ✅ | #23–#28 (`CreateWorkerProfileDto`, `UpdateWorkerProfileDto`, `UpdateSpecialtiesDto`, `UpdateSchedulesDto` → `WorkerProfileView`) | El teléfono es de la cuenta (#6) y se exige para enviar a revisión |
| RF-07 Documentación de respaldo | ✅ | #31–#34 (`UploadDocumentDto` → `WorkerDocumentView`) | Solo el propio trabajador ve y descarga sus documentos |
| RF-08 Estados del perfil | ✅ (consulta) | #29 `WorkerStatusView` | — |
| RF-09 No aprobado no recibe pedidos | ✅ | Guard en #52–#54 | Búsqueda de trabajadores: ver RF-16 |
| RF-10 Revisión administrativa (aprobar, observar, rechazar) | 🟡 | **Sin endpoint.** Existe `WorkerProfileService.changeStatusByAdmin` con sus reglas, historial y bitácora | ❗ Bloquea los flujos de trabajador de punta a punta |
| RF-11 Perfil público (especialidades, zona, calificación, opiniones) | ⛔ | — | Depende de calificaciones (grupo 10) |
| RF-12 Indicación de perfil revisado | ❓ | — | Texto pendiente con el docente |
| RF-13 Zona fija y cambio por solicitud | 🟡 | #35–#41 (`CreateZoneChangeRequestDto`, `DecideZoneChangeRequestDto` → `ZoneStatusView`, `ZoneChangeRequestView`, `AdminZoneChangeRequestView`) | La solicitud se bloquea siempre (`VERIFICACION_NO_DISPONIBLE`) hasta que exista la fuente `OFERTAS` |

**Dependencias:**
- Catálogos (zonas y categorías activas).
- Cuentas (teléfono y rol).
- OffersModule, para habilitar los cambios de zona.
- Un futuro módulo de verificación, para RF-10.

## 3. Pedidos (RF-14 a RF-18)

| RF | Estado | Contrato disponible | Notas |
|---|---|---|---|
| RF-14 Crear pedido (descripción, categoría, fotos, ubicación, monto) | ✅ | #42 (multipart `CreateOrderDto` + `images` → `OrderWithWarnings`) | Vence a las 48 h |
| RF-15 Varios pedidos activos, uno por categoría | 🟡 | #43 aviso de duplicado; avisos en #42 y #47 | Hoy **no se bloquea** un segundo pedido de la misma categoría: solo se avisa (decisión provisional del equipo) |
| RF-16 Encontrar trabajadores de su zona | ⛔ | — | Falta decidir qué datos del trabajador son públicos |
| RF-17 Visibilidad para trabajadores aprobados de la categoría y zona | ✅ | #52–#54 (`WorkerOrderView`) | Regla completa en 05 |
| RF-18 Editar o cancelar sin acuerdo | ✅ | #47–#51 (`UpdateOrderDto`, `CancelOrderDto` → `OwnerOrderView`) | Categoría y zona no editables (❓) |
| Consulta propia | ✅ | #44–#46 | — |

**Dependencias:**
- Catálogos.
- WorkerProfile (elegibilidad y especialidades).
- OffersModule (para pasar a `EN_NEGOCIACION`).

❓ Pendientes con el docente:
- Si vence `EN_NEGOCIACION`.
- Si se pueden editar la categoría o la zona.
- Cantidad definitiva de fotos y soporte de HEIC.
- Retención de fotos de pedidos vencidos.

## 4. Ofertas y negociación (RF-19 a RF-24)

| RF | Estado | Contrato |
|---|---|---|
| RF-19 a RF-24 | 📐 / ⛔ | **No existe OffersModule ni ningún endpoint, DTO o modelo de ofertas.** |

Solo hay puntos de integración internos en OrdersModule:
- `OrdersService.transition()` con las transiciones `PUBLICADO → EN_NEGOCIACION`, `EN_NEGOCIACION → ACORDADO` (asigna al trabajador) y `EN_NEGOCIACION → PUBLICADO`.
- `OrderVisibilityService.assertOpenForOffers()`.
- Eventos `EDITADO`, `CANCELADO` y `VENCIDO`.

No son contratos HTTP. ❓ Decisión pendiente del equipo: qué pasa con las ofertas enviadas si se desactiva un catálogo o se suspende al cliente.

## 5. Visitas, presupuestos y ejecución (RF-25 a RF-28)

⛔ No implementado. Los estados `ANTICIPO_REGISTRADO`, `VISITA_REALIZADA`, `PRESUPUESTO_ADICIONAL_PENDIENTE`, `EN_EJECUCION` y `TERMINADO` existen en `OrderStatus`, pero ninguna operación los alcanza. Depende de ofertas.

## 6. Agenda (RF-29 a RF-31)

| RF | Estado | Contrato |
|---|---|---|
| RF-29 Días y horarios de atención | ✅ | #27 `UpdateSchedulesDto` → `WorkerProfileView.schedules` |
| RF-30 Impedir cruces de trabajos | ⛔ | — |
| RF-31 Duración estimada en la oferta | ⛔ | Depende de ofertas |

Los horarios de atención **no son reservas**: no existe agenda de trabajos.

## 7. Seguimiento (RF-32, RF-33)

| RF | Estado | Contrato |
|---|---|---|
| RF-32 Línea de tiempo del pedido | 🟡 | El historial se **registra** (`order_status_history`, actor `USUARIO` o `SISTEMA`), pero **no hay endpoint** para consultarlo |
| RF-33 Avisos dentro de la plataforma | ⛔ | Solo existe el punto de integración `OrderLifecycleRegistry`; no hay módulo ni endpoint de notificaciones |

## 8. Cancelaciones y situaciones especiales (RF-34 a RF-38)

| RF | Estado | Contrato |
|---|---|---|
| RF-34 "Cancelar trabajo" (con acuerdo) | ⛔ ❓ | Los 409 de edición y cancelación sugieren usarlo, pero no existe |
| RF-35 Vencimiento del pedido | 🟡 | Vencimiento automático implementado (48 h, cada 15 min; el estado efectivo se ve en #44–#45). El **aviso al cliente** no existe |
| RF-36 Inasistencia del trabajador | ⛔ | — |
| RF-37, RF-38 Reclamos | ⛔ | — |
| Cancelación antes del acuerdo (RF-18) | ✅ | #51 |

## 9. Constancias de servicios y pagos (RF-39 a RF-43)

⛔ No implementado: no hay modelos, estados ni endpoints de anticipo, pago, comprobante o constancia.

## 10. Calificaciones (RF-44 a RF-46)

⛔ No implementado.

## 11. Administración (RF-47 a RF-53)

| RF | Estado | Contrato |
|---|---|---|
| RF-47 Revisar y suspender trabajadores | 🟡 | Sin endpoint (igual que RF-10). Sí existe #41 (perfiles con zona inactiva) y la decisión de cambios de zona (#38–#40) |
| RF-48 Categorías | ✅ | #8, #9, #12, #13, #16–#18 (sin reactivación) |
| RF-49 Zonas | ✅ | #10, #11, #14, #15, #19–#21 (sin reactivación) |
| RF-50 Supervisar pedidos | ⛔ | No hay vista administrativa de pedidos |
| RF-51 Atender reclamos | ⛔ | — |
| RF-52 Reportes | ⛔ | — |
| RF-53 Bitácora | ✅ | #22 (catálogos y decisiones de zona; los cambios de estado de perfil se registrarán cuando exista su endpoint) |
| Gestión de usuarios | 🟡 | #4–#7 (sin roles ni filtros) |

## 12. Privacidad (RF-54 a RF-56)

| RF | Estado | Contrato |
|---|---|---|
| RF-54 Visitante solo ve información pública | 🟡 | Hoy lo único público son los catálogos (#8–#11). Todo lo demás exige sesión |
| RF-55 Dirección exacta a quien la necesita | 🟡 ❓ | Solo la ve el cliente dueño. Para el trabajador, pendiente con el docente (no hay acuerdos todavía) |
| RF-56 Documentación solo para administradores | 🟡 | La ve y descarga **solo el propio trabajador**; el administrador no tiene endpoint. Ningún otro rol accede |
| Protección de datos en pedidos | ✅ | `WorkerOrderView` excluye la dirección, el cliente y `clientId`; aviso `POSIBLE_DATO_PERSONAL` |
| Privacidad de fotos | ✅ | Sin metadatos; rutas autorizadas; borrado físico al cancelar |
