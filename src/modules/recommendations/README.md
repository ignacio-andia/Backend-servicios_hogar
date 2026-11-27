# RecommendationsModule

Recomendación de trabajadores para un pedido, basada en **reputación**,
**servicios completados** y **disponibilidad**, mostrando los criterios
usados. Lee datos de los módulos dueños con sus consultas públicas
(`WorkerProfileService`, `OrdersService`, `OffersService`) y guarda sus propias
tablas. Ningún módulo lo importa: no hay ciclos.

## Endpoints

| Método y ruta                               | Rol           | Respuesta                                                     |
| ------------------------------------------- | ------------- | ------------------------------------------------------------- |
| `POST /api/orders/:orderId/recommendations` | CLIENTE       | 201: genera y guarda una recomendación (`RecommendationView`) |
| `GET /api/orders/:orderId/recommendations`  | CLIENTE       | 200: las 10 más recientes del pedido                          |
| `GET /api/admin/recommendation-settings`    | ADMINISTRADOR | 200: versión vigente de los criterios e historial             |
| `PUT /api/admin/recommendation-settings`    | ADMINISTRADOR | 200: crea una versión nueva y la registra en la bitácora      |

Errores: 400 datos inválidos o pesos que no suman 100; 401 sin sesión; 403 sin
el rol; 404 pedido inexistente o de otro cliente; 409 pedido que ya no está
`PUBLICADO` ni `EN_NEGOCIACION`, criterios iguales a los vigentes o dos
administradores guardando a la vez.

## Cálculo (`recommendation-scoring.ts`, funciones puras)

Cada criterio da un puntaje de 0 a 100; el total es el promedio ponderado con
los pesos de la versión vigente (enteros que suman 100). Valores iniciales:
reputación 50 %, servicios 30 %, disponibilidad 20 %.

- **Reputación:** promedio bayesiano de las calificaciones visibles de clientes:
  `(C × 3 + suma) / (C + n)`, con `C` calificaciones neutras (inicial 3). Una
  sola calificación de 5 no le gana a un historial largo de 5. Puntaje =
  `(ajustado − 1) / 4 × 100`.
- **Servicios completados:** pedidos asignados en `TERMINADO` o `CERRADO` con
  fecha de fin del trabajo (un pedido cerrado sin terminar no cuenta).
  Puntaje = `min(n / meta, 1) × 100` (meta inicial: 10).
- **Disponibilidad:** horario semanal de atención menos las horas de trabajos
  acordados en los próximos 7 días (misma fuente que la agenda, RF-30).
  Puntaje = `min(horas libres / meta, 1) × 100` (meta inicial: 20 h).
- **Desempate:** reputación, servicios, horas libres y, por último, el id.

Candidatos: los mismos filtros que la búsqueda de trabajadores (RF-16):
aprobados, de la zona y la categoría del pedido, con cuenta activa, sin cambio
de zona pendiente y distintos del cliente.

## Persistencia (migración `20261126000000_worker_recommendations`)

- `recommendation_settings`: criterios **versionados** (una fila por versión).
  La migración crea la versión 1.
- `worker_recommendations` y `worker_recommendation_items`: cada recomendación
  generada, con la versión de criterios usada y los datos y puntajes de cada
  trabajador en ese momento.
- La BD respalda las reglas: `CHECK` de pesos que suman 100, rangos y puntajes
  de 0 a 100, y un trigger de **solo inserción** en las tres tablas (el
  historial no se modifica ni se borra).
- Bitácora (RF-53): `AuditEntityType.CONFIGURACION_RECOMENDACION`, acción
  `EDICION`, con la versión anterior y la nueva (`before`/`after`).

## Pruebas

- `recommendation-scoring.spec.ts`: cálculo de cada criterio, total, orden y desempate.
- `test/recommendations.e2e-spec.ts`: flujo real sobre un esquema temporal
  (calificaciones, trabajos terminados, agenda, permisos, 409, triggers y CHECK,
  versiones y bitácora).

Para ver calificaciones en una demostración local, el `.env` necesita
`REVIEWS_ELIGIBLE_STATUSES=TERMINADO,CERRADO`; sin ese valor las calificaciones
están deshabilitadas y todos los trabajadores tienen reputación neutra.
