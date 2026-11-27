# ClaimsModule (Persona A)

Reclamos del cliente y decisión del administrador (RF-37, RF-38). Depende de
`OrdersModule` (transición, procesamiento de fotos) y de
`ServiceWorkflowModule` (plazo de conformidad, eventos). Un reclamo por pedido.

## Endpoints

| Método y ruta | Rol | Notas |
|---|---|---|
| `POST /orders/:orderId/claims` | cliente dueño | `multipart/form-data`: `description` (obligatoria, ≤ 2000) e `images` (opcionales). 201 `ClaimView`. TERMINADO → EN_RECLAMO |
| `GET /orders/:orderId/claim` | cliente dueño / trabajador asignado | cliente: `ClaimView`; trabajador: solo `{ id, orderId, status, decision, justification, decidedAt }` y solo con el reclamo RESUELTO |
| `GET /claims/:claimId/images/:imageId?variant=full\|thumb` | cliente que reclamó o administrador | foto privada (`Cache-Control: private, no-store`) |
| `GET /admin/claims?status=&priority=&situation=&assigneeId=&page=&limit=` | administrador | resumen paginado ordenado por prioridad, fecha límite y antigüedad. `situation`: PENDIENTE, VENCIDO o EN_PLAZO; `assigneeId`: UUID o `none` |
| `GET /admin/claims/:claimId` | administrador | reclamo y fotos; el historial del pedido está en `GET /orders/admin/:id` y las constancias las expone PaymentsModule |
| `POST /admin/claims/:claimId/review` | administrador | ABIERTO → EN_REVISION (CU-38 A1) |
| `POST /admin/claims/:claimId/decision` | administrador | `{ decision, justification }` obligatorios → reclamo RESUELTO y pedido CERRADO |
| `GET /admin/claims/assignees` | administrador | administradores activos que pueden ser responsables |
| `PATCH /admin/claims/:claimId/assignment` | administrador | `{ priority, assignedToId?, dueAt? }` → cambia prioridad, responsable y fecha límite; 400 responsable inválido o fecha fuera de rango; 409 reclamo RESUELTO |

Errores: 400 datos inválidos; 404 reclamo/pedido ajeno; 409 fuera de plazo,
pedido no TERMINADO, reclamo duplicado o ya resuelto; 413 foto demasiado
pesada (peso máximo = `ORDER_IMAGE_MAX_MB`).

**Bitácora (RF-53):** la revisión y la decisión se registran en la misma
transacción (`RECLAMO` / `CAMBIO_ESTADO`, con el pedido y los estados, sin el
texto del reclamo ni de la decisión).

## Plazo y concurrencia

El reclamo bloquea el pedido (FOR UPDATE) y, dentro del bloqueo, exige estado
TERMINADO y `ahora < conformityDeadline` (reloj de la BD). Compite de forma
segura con la conformidad y con el cierre automático (ver README de
ServiceWorkflowModule): o gana el reclamo (EN_RECLAMO) o gana el cierre
(CERRADO), nunca ambos.

## Fotos (evidencia)

- Se procesan con `OrderImageProcessor` (formato real validado, WebP sin
  metadatos) y se guardan con claves generadas por el servidor en el espacio
  `claim-images`; la API nunca expone claves ni rutas.
- **Cantidad configurable, sin regla de negocio fija** (el requerimiento no la
  define): `CLAIM_MIN_IMAGES` (por defecto 0: fotos opcionales) y
  `CLAIM_MAX_IMAGES` (por defecto y tope técnico: 20). Inválido → no arranca.
- Si el reclamo no se confirma, las fotos guardadas se descartan
  (compensación). Una vez confirmado **no existe ningún borrado de evidencia**;
  `OrderRetentionService` no limpia pedidos que tuvieron acuerdo.

## Decisión del administrador

Solo se registra texto (`decision`) y `justification`, con `decidedById` y
fecha. **No** aplica sanciones, suspensiones (RF-47) ni efectos económicos, y
no altera calificaciones. Pendiente del docente: resultados posibles de la
decisión y si el trabajador debe ver más datos del reclamo.

`decidedById` es una columna sin FK a `users` a propósito: agregar la relación
exige tocar `User` (modelo compartido); se resuelve al reconciliar el schema.

## Priorización (prioridad, responsable y fecha límite)

| # | Regla |
|---|---|
| RN-1 | Prioridades URGENTE, ALTA, MEDIA y BAJA. Todo reclamo nace MEDIA. |
| RN-2 | Plazo por prioridad: URGENTE 24 h, ALTA 48 h, MEDIA 72 h, BAJA 120 h. Al crear: `dueAt = ahora + 72 h`. |
| RN-3 | Solo un administrador ACTIVO puede ser responsable. |
| RN-4 | Fecha límite manual: futura y como máximo a 30 días. Sin fecha: si cambió la prioridad se recalcula; si no, se conserva. |
| RN-5 | Un reclamo RESUELTO no se reasigna ni se reprioriza (409). |
| RN-6 | Pendiente = ABIERTO o EN_REVISION. Vencido = pendiente con `dueAt` pasado. Se calcula con el reloj de la BD, no se guarda. |
| RN-7 | Cada cambio queda en la bitácora (`RECLAMO` / `EDICION`) con el antes y el después. |
| RN-8 | Orden del listado: prioridad (URGENTE primero), fecha límite más cercana, más antiguo. |

Las reglas puras están en `claims.rules.ts` y se prueban en `claims.rules.spec.ts`.