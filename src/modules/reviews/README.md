# ReviewsModule (Persona B)

Calificaciones mutuas (RF-44, RF-45) y perfil público del trabajador (RF-46).
Rutas bajo el prefijo global `/api`.

## Modelo (`reviews`)

Una calificación por **autor y pedido** (`@@unique([orderId, authorId])`),
`rating` entero 1–5 (CHECK), comentario opcional (≤ 1000), `authorRole`,
`targetId`, y moderación (`hiddenAt`, `hiddenById`). CHECK de **no
autocalificación** (`author_id <> target_id`). Un trigger impide borrarla y
editar nada salvo ocultarla.

## Reglas

- Solo el **cliente dueño** y el **trabajador asignado** califican, a la otra
  parte. Un tercero (o un administrador) → 404. El autor sale del token; el
  calificado, del pedido.
- **Elegibilidad configurable y sin valor por defecto.** `REVIEWS_ELIGIBLE_STATUSES`
  (lista de estados del pedido, por ejemplo `TERMINADO,CERRADO`). _Pendiente del
  docente:_ CU-45 dice «Terminado o Cerrado» y CU-44 «Cerrado o con el pago final
  confirmado». **Sin configurar, las calificaciones están deshabilitadas**
  (409 con el motivo). La política está aislada en `ReviewEligibilityPolicy`;
  cambiarla no toca las reglas inmutables.
- **No existe ajuste automático de estrellas** por inasistencia u otros hechos
  (RF-36 está pendiente del docente).
- Promedio (2 decimales, mitad hacia arriba) y cantidad cuentan solo las
  opiniones **de clientes** y **visibles**. El administrador puede **ocultar**
  una opinión (RF-46 A1): no se borra, deja de mostrarse y el promedio se
  recalcula. Las calificaciones del trabajador al cliente quedan en el historial
  del cliente (`GET /reviews/received`) y no cuentan en el perfil del trabajador.
- _No implementado:_ marcado automático de lenguaje ofensivo (RF-44 A1); solo
  la ocultación manual.

- Un pedido cerrado porque el cliente rechazó un presupuesto adicional
  (RF-27) no se puede calificar: el trabajo no se terminó (RF-45).

## Búsqueda de trabajadores (RF-16)

`GET /workers/search?categoryId&zoneId&page&limit` (cliente): aprobados
disponibles de esa categoría y zona, con especialidades, horarios y promedio de
las opiniones de clientes visibles. Sin contacto ni datos privados. Sin
resultados responde un aviso que no promete disponibilidad.

## Endpoints

| Método y ruta                               | Acceso                              | Respuesta                                                                            |
| ------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /orders/:orderId/reviews`             | cliente dueño o trabajador asignado | 201 `ReviewView`; body `{ rating: 1..5, comment? }`                                  |
| `GET /orders/:orderId/reviews/mine`         | participante                        | `{ canReview, reason, alreadyReviewed, review }` (CU-45: «si no, muestra el motivo») |
| `GET /reviews/received?page&limit`          | sesión                              | calificaciones recibidas visibles                                                    |
| `GET /workers/:workerId/public-profile`     | **público**                         | perfil público, promedio y opiniones recientes                                       |
| `GET /workers/:workerId/reviews?page&limit` | **público**                         | opiniones visibles paginadas (`limit` ≤ 50)                                          |
| `GET /admin/reviews?page&limit`             | administrador                       | todas, con ids y estado de moderación                                                |
| `PATCH /admin/reviews/:reviewId/hide`       | administrador                       | oculta (idempotente)                                                                 |

Errores: 400 puntaje no entero 1–5, comentario > 1000, campos extra; 404 pedido
ajeno o trabajador no público (inexistente, no aprobado, cuenta inactiva o sin
rol de trabajador); 409 pedido fuera de la política, sin otra parte, o ya
calificado.

## Privacidad (RF-46)

Las rutas `workers/` son **públicas** y devuelven solo: nombre y apellido, años
de experiencia, descripción, zona y especialidades; promedio, cantidad y, por
opinión: puntaje, comentario, fecha y el autor como «Nombre I.». **Nunca** ids de
usuario o de pedido, correo, teléfono, documentos, horarios ni estado de
verificación. Probado en e2e.

## Configuración

| Variable                    | Efecto                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `REVIEWS_ELIGIBLE_STATUSES` | Estados que habilitan calificar. Vacío = deshabilitado. Un estado desconocido detiene el arranque. |

Cada calificación genera el aviso `CALIFICACION_RECIBIDA` para el calificado
(con el `tx`).
