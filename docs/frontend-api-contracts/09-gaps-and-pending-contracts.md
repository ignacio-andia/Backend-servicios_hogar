# 09. Faltantes, inconsistencias y contratos pendientes

Solo se documentan los hallazgos y su impacto: no se modificó el backend. Prioridad para la integración con Angular: **Alta** bloquea un flujo; **Media** obliga a un rodeo en el frontend; **Baja** es solo una molestia.

## A. Problemas que conviene resolver antes de integrar Angular

| # | Hallazgo | Impacto en Angular | Prioridad |
|---|---|---|---|
| A1 | **Resuelto (T2.2, T2.3 y T3.2).** Listado (#56), detalle (#57), documentos con bitácora (#58–#60), decisión (#55) y notificaciones internas (#61–#64) | La verificación funciona de punta a punta, con avisos al trabajador y a los administradores | — |
| A2 | El commit `207f2cb` (OrdersModule, cambio de zona, cola de archivos y 2 migraciones) **no está publicado** en `origin/main` | Quien clone el repositorio remoto no tiene esos endpoints | **Alta** (se resuelve con un push) |
| A3 | **Resuelto (T2.1).** El primer `ADMINISTRADOR` se crea con el comando interno `npm run admin:create-first` (README, sección H, paso 5). Sigue sin existir un mecanismo para administradores adicionales | Para probar las pantallas de administración basta con ejecutar el comando una vez | Baja |
| A4 | Descargas (fotos y documentos) solo con Bearer | `<img src>` no funciona: hay que descargar como Blob (ver 06) | Media |
| A5 | Sin OpenAPI o Swagger | Los contratos se mantienen a mano (esta carpeta) | Media |
| A6 | Sin refresh token; expiración de 1 h por defecto | Hay que volver a iniciar sesión; manejar el 401 globalmente | Media |

## B. Inconsistencias entre endpoints similares

| # | Hallazgo | Detalle | Impacto |
|---|---|---|---|
| B1 | `addressReference` vacío se trata distinto al crear y al editar | Al crear, `""` se guarda como `""`: el service usa `dto.addressReference ?? null`. Al editar, `""` se guarda como `null` | Angular debe omitir el campo si está vacío al crear; al leer, tratar `""` y `null` como "sin referencia" |
| B2 | Códigos de éxito distintos para acciones parecidas | `POST …/submit`, `POST …/cancel`, `POST /orders/duplicate-check` y `POST /auth/login`: **200**. `POST …/documents/:id/replace` y `POST /orders/me/:id/images`: **201**. `PUT …/images/:id` y `DELETE …/images/:id`: **200 con cuerpo** | Use `ok` (2xx), no un código exacto |
| B3 | Paginación desigual | Paginados: usuarios, bitácora, pedidos y solicitudes (admin). Arreglos simples: catálogos, documentos, solicitudes propias, perfiles con zona inactiva | Dos patrones de listado |
| B4 | `limit` máximo distinto | 100 en usuarios, bitácora y solicitudes; 50 en pedidos | Ajustar los paginadores por recurso |
| B5 | Tres formas de "referencia a catálogo" | `CatalogOption {id,name,description}` (público), `CatalogRef {id,name,isActive}` (embebido), `AffectedProfile.zone {id,name}` | Tipos distintos en Angular (ver 07) |
| B6 | Mismo concepto con nombres distintos | Zona: `zone` (perfil, pedido), `currentZone` (zona, solicitud admin), `fromZone` y `toZone`. Estado: `status` frente a `accountStatus` y `profileStatus` (solicitud admin). Comentario: `comment` (entrada) frente a `decisionComment` (respuesta). Motivo: `statusReason` (estado) frente a `reason` (elegibilidad e historial) | Mapear con cuidado; no renombrar en los modelos |
| B7 | `message` de error string o arreglo | Arreglo en validación, categorías, horarios, envío del perfil, bloqueos de zona y requisitos de aprobación | El interceptor debe normalizar a `string[]` |
| B8 | Mensajes de validación mixtos | Los automáticos de class-validator usan inglés y el nombre del campo (`email must be an email`); los de negocio están en español | Mapear los errores de validación a mensajes propios por campo en los formularios |
| B9 | Estado efectivo frente a almacenado | Un `PUBLICADO` vencido llega como `VENCIDO` aunque en la BD siga `PUBLICADO` | Confiar siempre en `status`, `canEdit` y `canCancel` de la respuesta |

## C. Validaciones ambiguas o permisivas

| # | Hallazgo | Impacto |
|---|---|---|
| C1 | `TIME_PATTERN` admite `"24:00"` también como `startTime`; luego el service lo rechaza (fin posterior al inicio) | Validar en el cliente que `24:00` solo se use como fin |
| C2 | `status` y `resolved` se pueden combinar de forma contradictoria en `GET /admin/zone-change-requests` (`status=PENDIENTE&resolved=true` → vacío) | Ofrecer un solo filtro en la interfaz |
| C3 | `yearsOfExperience` debe ser un **número** JSON (`"5"` responde 400) | Usar `type="number"` y convertir a número |
| C4 | El teléfono es opcional al registrarse, pero obligatorio para enviar el perfil a revisión | Pedirlo en el flujo de alta del trabajador (`pendingRequirements` lo indica) |
| C5 | Un trabajador `APROBADO` no puede editar sus datos ni especialidades (409), pero sí sus horarios | Usar `canEdit` solo para datos, especialidades y documentos |
| C6 | `categoryId` y `zoneId` de `duplicate-check` no se verifican | Sin impacto: solo afectan a los avisos |
| C7 | **Resuelto (T1.1).** `phone: ""` o solo espacios: en el registro se trata como ausente (se guarda `null`); en `PATCH /users/:id` borra el teléfono. Antes respondía 400 | Los formularios pueden enviar el campo vacío. **Sigue prohibido enviar `confirmPassword`** u otras propiedades no declaradas (400) |

## D. Información que Angular necesitaría y la API no devuelve

| # | Falta | Para qué |
|---|---|---|
| D1 | Historial de estados del pedido (se guarda, no se expone) | Línea de tiempo (RF-32) |
| D2 | `assignedWorkerId` u otro dato del trabajador asignado en `OwnerOrderView` | Mostrar con quién se acordó (cuando existan acuerdos) |
| D3 | Datos del trabajador para el cliente o un perfil público | RF-11, RF-16 |
| D4 | **Resuelto (T2.2 y T2.3).** Vista de un perfil y sus documentos para el administrador | RF-10, RF-47, RF-56 |
| D5 | Vista administrativa de pedidos y reportes | RF-50, RF-52 |
| D6 | Filtros o búsqueda en `GET /users` | Administración de usuarios |
| D7 | Configuración pública (mínimo y máximo de fotos, tamaños, vencimiento) | Hoy hay que reproducir los valores en el frontend (1–3 fotos, 10 MB, 48 h); si el backend cambia su configuración, el frontend no se entera |
| D8 | Endpoint de reactivación de catálogos | Administración |
| D9 | Nombre del archivo en la descarga (header no expuesto por CORS) | Usar `originalName` del listado |

## E. Contratos pendientes (no existen: no inventar)

| Módulo o funcionalidad | Estado | Depende de |
|---|---|---|
| Logout, refresh, recuperación o cambio de contraseña (RF-01, RF-05) | ⛔ | — |
| Administradores adicionales y gestión de roles (RF-04). El primero ya tiene comando interno (T2.1) | ⛔ | Decisión del equipo |
| Verificación de perfiles (RF-10, RF-47) | ✅ Listado, detalle, documentos y decisión (#55–#60) | — |
| Notificaciones de verificación de perfiles | ✅ (T3.2) Decisiones al trabajador y envíos a los administradores; tipos en 04 | — |
| Cambio de zona: retiro voluntario de la solicitud, bloqueo de ofertas y de nuevos trabajos mientras está pendiente, salida para perfiles `RECHAZADO` con la zona desactivada | ⛔ | Tareas siguientes de T4 (especificación v1.0 §4) |
| Notificaciones de pedidos, ofertas, visitas y reclamos | ⛔ | Sus módulos. Deben usar `NotificationsService.create` o `createForRole` con el cliente de su transacción |
| Notificaciones por correo, SMS o push | ⛔ Fuera de alcance | — |
| Indicación de perfil revisado (RF-12) | ❓ | Texto del docente |
| Perfil público y búsqueda de trabajadores (RF-11, RF-16) | ⛔ | Calificaciones; decisión sobre datos públicos |
| **Ofertas y negociación (RF-19 a RF-24)** | 📐 (solo integración interna) | OffersModule |
| Visitas, presupuesto adicional y ejecución (RF-25 a RF-28) | ⛔ | Ofertas |
| Agenda de trabajos y cruces (RF-30, RF-31) | ⛔ | Ofertas |
| Línea de tiempo y avisos (RF-32, RF-33) | 🟡 | Endpoint de historial; avisos de pedidos (la bandeja #61–#64 ya existe) |
| Cancelar trabajo (RF-34), inasistencia (RF-36), reclamos (RF-37, RF-38, RF-51) | ⛔ ❓ | Decisiones del docente |
| Aviso de vencimiento (RF-35) | 🟡 | Integrarlo con `NotificationsService` (la bandeja ya existe) |
| Pagos y constancias (RF-39 a RF-43) | ⛔ | Ofertas y acuerdos |
| Calificaciones (RF-44 a RF-46) | ⛔ | Trabajo terminado |
| Supervisión de pedidos y reportes (RF-50, RF-52) | ⛔ | — |

## F. Decisiones pendientes que afectan a la interfaz

**Del docente**
- Si vence `EN_NEGOCIACION`.
- Cuándo se llega a `SIN_ACUERDO`.
- Cómo se sale de `ACORDADO` (RF-34).
- Qué estados cuentan como activos.
- Si el trabajador ve la dirección exacta (RF-55).
- Si se pueden editar la categoría o la zona del pedido.
- Cantidad definitiva de fotos y soporte de HEIC.
- Retención de fotos de pedidos vencidos.
- Si aprobar un cambio de zona devuelve el perfil a revisión.
- Si se vuelve a verificar el trabajo activo al aprobar.
- Texto de RF-12.

**Del equipo**
- Qué pasa con las ofertas enviadas si se desactiva un catálogo o se suspende al cliente.
- Cómo se crean administradores adicionales. El primero ya está resuelto (T2.1).
- Perfil `RECHAZADO` cuya zona se desactivó: no puede cambiar la zona ni pedir un cambio (`ZONE_REQUEST_ALLOWED_STATUSES`), y por eso tampoco puede reenviar (`pendingRequirements` pide una zona activa). Hoy necesita que un administrador reactive la zona.
