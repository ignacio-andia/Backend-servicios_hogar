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
| `GET /admin/claims?status=&page=&limit=` | administrador | resumen paginado, más antiguos primero |
| `GET /admin/claims/:claimId` | administrador | reclamo y fotos; el historial del pedido está en `GET /orders/admin/:id` y las constancias las expone PaymentsModule |
| `POST /admin/claims/:claimId/review` | administrador | ABIERTO → EN_REVISION (CU-38 A1) |
| `POST /admin/claims/:claimId/decision` | administrador | `{ decision, justification }` obligatorios → reclamo RESUELTO y pedido CERRADO |

Errores: 400 datos inválidos; 404 reclamo/pedido ajeno; 409 fuera de plazo,
pedido no TERMINADO, reclamo duplicado o ya resuelto; 413 foto demasiado
pesada (peso máximo = `ORDER_IMAGE_MAX_MB`).

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
