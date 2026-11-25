# 08. Correspondencia entre módulos funcionales y backend

Organizado por los 12 grupos de requerimientos (RF-01 a RF-56). Los números `#` remiten al inventario de [01](01-endpoints-inventory.md).

Leyenda: ✅ implementado · 🟡 parcial · 📐 diseñado, sin endpoint · ⛔ no implementado · ❓ pendiente de decisión.

## 1. Cuentas y roles (RF-01 a RF-05)

| RF                                                     | Estado | Contrato disponible                                                   | Notas                                                                                                                                             |
| ------------------------------------------------------ | ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-01 Registro, inicio y cierre de sesión              | 🟡     | #1, #2, #3 (`RegisterDto`, `LoginDto` → `AuthResponse`, `PublicUser`) | El cierre de sesión es solo del lado del cliente (no hay endpoint ni revocación). Registro y login limitan los intentos abusivos (429)            |
| RF-02 Trabajador que también es cliente                | ✅     | Roles múltiples en `PublicUser.roles`                                 | `POST /worker-profile` agrega `TRABAJADOR` sin quitar `CLIENTE`                                                                                   |
| RF-03 Funciones de trabajador solo con perfil aprobado | ✅     | `ApprovedWorkerGuard` (#52–#54), #30 elegibilidad                     | Un administrador aprueba con #55                                                                                                                  |
| RF-04 Administradores creados internamente             | 🟡     | Sin contrato HTTP (a propósito)                                       | El **primer** administrador se crea con el comando interno `npm run admin:create-first` (T2.1). No hay mecanismo para administradores adicionales |
| RF-05 Recuperar contraseña                             | ⛔     | —                                                                     | —                                                                                                                                                 |
| Gestión de la propia cuenta                            | ✅     | #5, #6, #7                                                            | Editar nombre y teléfono; desactivar la propia cuenta                                                                                             |
| Gestión de usuarios (admin)                            | 🟡     | #4 (sin filtros), #5–#7                                               | No hay asignación ni retiro de roles                                                                                                              |

**Dependencias:** todo el resto usa el JWT y `PublicUser.roles`.

> Estado verificado por requerimiento, con evidencia: [matriz de requerimientos](../MATRIZ_REQUERIMIENTOS.md).

## 2. Perfil y verificación del trabajador (RF-06 a RF-13)

| RF                                                                   | Estado        | Contrato disponible                                                                                                                                                                                            | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-06 Datos, experiencia, especialidades, zona y horarios            | ✅            | #23–#28 (`CreateWorkerProfileDto`, `UpdateWorkerProfileDto`, `UpdateSpecialtiesDto`, `UpdateSchedulesDto` → `WorkerProfileView`)                                                                               | El teléfono es de la cuenta (#6) y se exige para enviar a revisión                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| RF-07 Documentación de respaldo                                      | ✅            | #31–#34 (`UploadDocumentDto` → `WorkerDocumentView`)                                                                                                                                                           | Solo el propio trabajador ve y descarga sus documentos                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| RF-08 Estados del perfil                                             | ✅ (consulta) | #29 `WorkerStatusView`                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| RF-09 No aprobado no recibe pedidos                                  | ✅            | Guard en #52–#54                                                                                                                                                                                               | Búsqueda de trabajadores: ver RF-16                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| RF-10 Revisión administrativa (aprobar, observar, rechazar)          | ✅            | Listado #56, detalle #57 y decisión #55 (`ChangeWorkerProfileStatusDto` → `WorkerProfileView`): transiciones, motivo obligatorio, requisitos de aprobación, historial y bitácora; nunca sobre el propio perfil | Documentos #58–#60 (T2.3). Tras un rechazo, el trabajador corrige y reenvía con #28 (T3.1). Cada decisión notifica al trabajador y cada envío a los administradores (T3.2, #61–#64)                                                                                                                                                                                                                                                                                                                  |
| RF-11 Perfil público (especialidades, zona, calificación, opiniones) | 🟡            | #106, #107                                                                                                                                                                                                     | No incluye horarios ni foto                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| RF-12 Indicación de perfil revisado                                  | ❓            | —                                                                                                                                                                                                              | Texto pendiente con el docente                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RF-13 Zona fija y cambio por solicitud                               | ✅            | #35–#41 y #65 (`CreateZoneChangeRequestDto`, `DecideZoneChangeRequestDto` → `ZoneStatusView`, `ZoneChangeRequestView`, `AdminZoneChangeRequestView`)                                                           | Solo desde `APROBADO` y sin pedidos ni ofertas activos; rechazo con motivo obligatorio; no se aprueba para perfiles `SUSPENDIDO` o `RECHAZADO`; suspender cancela la pendiente; notificaciones al trabajador (T4.2); retiro voluntario (#65). Bloquea solo las oportunidades nuevas (ver pedidos disponibles, crear ofertas y asignaciones sin negociación abierta); las negociaciones abiertas y los trabajos acordados continúan ([05](05-auth-and-permissions.md#cambio-de-zona-pendiente-rf-13)) |

**Dependencias:**

- Catálogos (zonas y categorías activas).
- Cuentas (teléfono y rol).

## 3. Pedidos (RF-14 a RF-18)

| RF                                                                   | Estado | Contrato disponible                                               | Notas                                                                                                             |
| -------------------------------------------------------------------- | ------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| RF-14 Crear pedido (descripción, categoría, fotos, ubicación, monto) | ✅     | #42 (multipart `CreateOrderDto` + `images` → `OrderWithWarnings`) | Vence a los 7 días de la publicación (T5.1)                                                                       |
| RF-15 Varios pedidos activos, uno por categoría                      | ✅     | #43 aviso de duplicado; avisos en #42 y #47                       | Hoy **no se bloquea** un segundo pedido de la misma categoría: solo se avisa (decisión provisional del equipo)    |
| RF-16 Encontrar trabajadores de su zona                              | ✅     | #114                                                              | Categoría y zona; solo aprobados disponibles, con especialidades, horarios y promedio; avisa si no hay resultados |
| RF-17 Visibilidad para trabajadores aprobados de la categoría y zona | ✅     | #52–#54 (`WorkerOrderView`)                                       | Regla completa en 05                                                                                              |
| RF-18 Editar o cancelar sin acuerdo                                  | 🟡     | #47–#51 (`UpdateOrderDto`, `CancelOrderDto` → `OwnerOrderView`)   | Categoría editable (T5.2); la zona no (cancelar y crear otro). Las ofertas existentes siguen vigentes             |
| Consulta propia                                                      | ✅     | #44–#46                                                           | —                                                                                                                 |

**Dependencias:**

- Catálogos.
- WorkerProfile (elegibilidad y especialidades).
- OffersModule: lleva el pedido a `EN_NEGOCIACION` con la primera oferta (#69), a `ACORDADO` al aceptar (#77) y de vuelta a `PUBLICADO` cuando no quedan ofertas vigentes.

❓ Pendientes con el docente:

- Soporte de HEIC (la cantidad ya está definida: hasta 4 fotos, T5.3).

## 4. Ofertas y negociación (RF-19 a RF-24)

| RF                                        | Estado | Contrato                                                                                                                                                                                                               |
| ----------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-19 Enviar una oferta                   | ✅     | #69 `CreateOfferDto` → `OfferDetail<OfferView>`                                                                                                                                                                        |
| RF-20 Aceptar, rechazar o contraofertar   | 🟡     | #74 `CounterOfferDto`, #75 rechazar, #76 retirar, #77 aceptar (asigna al trabajador). Sin `SIN_ACUERDO`: sin ofertas vigentes el pedido vuelve a `PUBLICADO`                                                           |
| RF-21 Historial de la negociación         | ✅     | `history` en #71 y #73 (solo inserción). El administrador consulta la negociación en el seguimiento del pedido (#112)                                                                                                  |
| RF-22 Condiciones claras antes de aceptar | ✅     | `OfferView`: monto, visita y su costo, materiales, horario y duración                                                                                                                                                  |
| RF-23 Vigencia y máximo de rondas         | 🟡 ❓  | 24 h (se reinicia en cada contraoferta) y 3 rondas, **fijos en el código** (`offers.rules.ts`). RF-23 pide parámetros configurables por el administrador (marcado «por confirmar»): no existen. Vencimiento automático |
| RF-24 Cotización por fotos o visita       | ✅     | `requiresVisit` / `visitCost`                                                                                                                                                                                          |
| Contacto entre las partes                 | ✅     | #78, #79: enlace de WhatsApp (canal externo, T6.6). No hay chat interno                                                                                                                                                |

Reglas y ejemplos: [`src/modules/offers/README.md`](../../src/modules/offers/README.md). Las ofertas se cierran solas al cancelarse o vencer el pedido y al suspenderse la cuenta del cliente, la del trabajador o su perfil.

## 5. Visitas, presupuestos y ejecución (RF-25 a RF-28)

| RF                            | Estado | Contrato                                                                                                                |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| RF-25 Visita y cobro          | ✅     | #83, #84                                                                                                                |
| RF-26 Presupuesto adicional   | ✅     | #86, #88                                                                                                                |
| RF-27 Rechazo del adicional   | 🟡     | #113: detiene y cierra el pedido, con motivo y aviso; solo queda la visita. La contraoferta (CU-27 A1) no está definida |
| RF-28 Terminado y conformidad | ✅     | #85, #87, #89 y cierre automático a los 7 días                                                                          |

## 6. Agenda (RF-29 a RF-31)

| RF                                   | Estado | Contrato                                                                            |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------- |
| RF-29 Días y horarios de atención    | ✅     | #27 `UpdateSchedulesDto` → `WorkerProfileView.schedules`                            |
| RF-30 Impedir cruces de trabajos     | ✅     | Al aceptar (#77): 409 si hay cruce. Consulta de agenda y disponibilidad: #110, #111 |
| RF-31 Duración estimada en la oferta | 🟡     | `proposedStartAt` y `estimatedDurationMinutes` en #69                               |

Los horarios de atención **no son reservas**: la agenda (#110) muestra además los trabajos acordados.

## 7. Seguimiento (RF-32, RF-33)

| RF                                   | Estado | Contrato                                                                                        |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| RF-32 Línea de tiempo del pedido     | ✅     | #112                                                                                            |
| RF-33 Avisos dentro de la plataforma | ✅     | Bandeja #61–#64; tipos en [04](04-enums-and-states.md). Quien pierde una oferta no recibe aviso |

## 8. Cancelaciones y situaciones especiales (RF-34 a RF-38)

| RF                                     | Estado | Contrato                                                                                                                                                                                                            |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-34 "Cancelar trabajo" (con acuerdo) | 🟡 ❓  | #90. Tratamiento del anticipo pendiente del docente                                                                                                                                                                 |
| RF-35 Vencimiento del pedido           | 🟡     | Vencimiento automático a los 7 días de la publicación, también en negociación y sin reinicios (T5.1), con aviso `PEDIDO_VENCIDO`. Al vencer se borran las fotos y la dirección y se anonimiza la descripción (T5.4) |
| RF-36 Inasistencia del trabajador      | 🟡 ❓  | #91 registra el hecho; tolerancia y consecuencias pendientes                                                                                                                                                        |
| RF-37, RF-38 Reclamos                  | 🟡     | #92–#98                                                                                                                                                                                                             |
| Cancelación antes del acuerdo (RF-18)  | ✅     | #51                                                                                                                                                                                                                 |

## 9. Constancias de servicios y pagos (RF-39 a RF-43)

| RF                                  | Estado | Contrato                                              |
| ----------------------------------- | ------ | ----------------------------------------------------- |
| RF-39 Anticipo                      | ✅     | #101 (`ANTICIPO`): lo confirma el trabajador asignado |
| RF-40, RF-42 Confirmaciones de pago | 🟡     | #101                                                  |
| RF-41 Constancias                   | 🟡     | #100. No hay subida de comprobantes                   |
| RF-43 Solo registro                 | ✅     | La plataforma no procesa dinero                       |

## 10. Calificaciones (RF-44 a RF-46)

| RF                               | Estado | Contrato                                                 |
| -------------------------------- | ------ | -------------------------------------------------------- |
| RF-44, RF-45 Calificación mutua  | 🟡 ❓  | #103–#105. Deshabilitada sin `REVIEWS_ELIGIBLE_STATUSES` |
| RF-46 Perfil público y opiniones | ✅     | #106–#109                                                |

## 11. Administración (RF-47 a RF-53)

| RF                                     | Estado | Contrato                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-47 Revisar y suspender trabajadores | 🟡     | Listar (#56), ver (#57), documentos (#58–#60), suspender y reactivar (#55; la reactivación exige los requisitos vigentes, T4-F1; mientras está suspendido el trabajador puede regularizar su perfil, T4-F7). Además, #41 (perfiles con zona inactiva), #66 (reasignación de zona) y la decisión de cambios de zona (#38–#40) |
| RF-48 Categorías                       | ✅     | #8, #9, #12, #13, #16–#18 (sin reactivación)                                                                                                                                                                                                                                                                                 |
| RF-49 Zonas                            | ✅     | #10, #11, #14, #15, #19–#21 (sin reactivación). Perfiles afectados: #41; un perfil `RECHAZADO` con la zona desactivada recibe otra zona por reasignación administrativa (#66, T4.4)                                                                                                                                          |
| RF-50 Supervisar pedidos               | 🟡     | Registro mínimo de solo lectura: #67–#68 (T5.4). Sin acciones administrativas sobre pedidos                                                                                                                                                                                                                                  |
| RF-51 Atender reclamos                 | 🟡     | #95–#98. No destaca como urgentes los reclamos sin atender (CU-51 A1)                                                                                                                                                                                                                                                        |
| RF-52 Reportes                         | ✅     | #115: pedidos, trabajadores, calificaciones, cancelaciones y reclamos; JSON o CSV                                                                                                                                                                                                                                            |
| RF-53 Bitácora                         | 🟡     | #22: catálogos, zona, perfiles, documentos, reclamos y estado de cuentas. Falta la ocultación de calificaciones y la edición de otra cuenta                                                                                                                                                                                  |
| Gestión de usuarios                    | 🟡     | #4–#7 (sin roles ni filtros)                                                                                                                                                                                                                                                                                                 |

## 12. Privacidad (RF-54 a RF-56)

| RF                                            | Estado | Contrato                                                                                                                                                                       |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RF-54 Visitante solo ve información pública   | ✅     | Públicos: catálogos (#8–#11) y perfil y opiniones de trabajadores (#106, #107). Todo lo demás exige sesión                                                                     |
| RF-55 Dirección exacta a quien la necesita    | ✅     | El cliente dueño (#45) y el trabajador **asignado** mientras el acuerdo sigue vigente (#80, adenda §2.2). Nadie más                                                            |
| RF-56 Documentación solo para administradores | ✅     | Administradores: #58–#60, con bitácora y nunca sobre su propio perfil. El trabajador ve los suyos (v1.0 §5; ❓ contradicción X2 con el texto de RF-56). Ningún otro rol accede |
| Protección de datos en pedidos                | ✅     | `WorkerOrderView` excluye la dirección, el cliente y `clientId`; aviso `POSIBLE_DATO_PERSONAL`                                                                                 |
| Privacidad de fotos                           | ✅     | Sin metadatos; rutas autorizadas; borrado físico al cancelar                                                                                                                   |
