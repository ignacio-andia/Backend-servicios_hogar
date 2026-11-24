# Prompt Claude Code — Persona B

Trabaja como ingeniero backend senior en el repositorio NestJS existente. Tu alcance es completar agenda, seguimiento/notificaciones, registros de pagos/constancias y calificaciones mutuas.

## Contexto obligatorio

Antes de tocar código, lee:
- `CLAUDE.md` y `AGENTS.md`.
- `SPRINT_BACKEND.md`.
- `Documento_Requerimientos_Servicios_Hogar_v1.2.pdf` (RF-29–33 y RF-39–46, incluyendo HU/CU correspondientes).
- `Aruitectura de desarro Backend.pdf`.
- Especificación funcional v1.0 y adenda v1.1 si están disponibles.
- `docs/frontend-api-contracts/` y `src/modules/offers/README.md`.

La arquitectura es monolito modular NestJS, Prisma centralizado. Controller solo HTTP/DTO; Service lógica de negocio y Prisma. No crear microservicios.

## RF a implementar/completar

- RF-29: días y horarios de atención del trabajador.
- RF-30: impedir solapamiento entre trabajos/visitas/ejecuciones del mismo trabajador.
- RF-31: usar duración estimada de la oferta para calcular intervalo.
- RF-32: línea de tiempo del pedido con eventos requeridos: oferta y partes, costo de visita, finalización y estado.
- RF-33: notificaciones internas de nueva oferta, acuerdo, presupuesto adicional y cancelación (más eventos pertinentes definidos por el requerimiento y contratos).
- RF-39: registrar anticipo del 25% del monto acordado (efectivo o QR).
- RF-40: trabajador confirma recepción del saldo al finalizar.
- RF-41: constancia de servicio y constancia individual por pago: fecha/hora, usuario, monto y método. Comprobante adjunto es referencia, no prueba de pago.
- RF-42: cliente también confirma “Ya pagué”; conservar ambas confirmaciones.
- RF-43: no procesar ni retener dinero.
- RF-44: cliente y trabajador se califican mutuamente de 1 a 5; comentario opcional.
- RF-45: solo tras trabajo terminado y una vez por parte.
- RF-46: promedio y opiniones visibles en perfil del trabajador.

## Inspección focalizada

Revisa como mínimo:
- `src/modules/worker-profile/schedules.ts`, `worker-profile.service.ts`, controller, DTOs y `WorkerSchedule` en Prisma.
- `src/modules/offers/` y campos `proposedStartAt`, `estimatedDurationMinutes`.
- `src/modules/orders/order-transition.ts`, `order-history.ts`, `order-lifecycle.registry.ts`, `orders-active-work.source.ts` y `orders.service.ts`.
- `src/modules/notifications/notifications.service.ts` y enums Notification existentes.
- `src/modules/users/` y vistas públicas del perfil del trabajador.
- `prisma/schema.prisma` y migraciones.

## Aprovechar lo existente — no rehacer

- `WorkerSchedule` y `schedules.ts` ya existen; incluyen normalización, validación de intervalos y zona `America/La_Paz`. Completa lo que falte; no crees otro calendario semanal ni otra tabla de disponibilidad sin demostrar una brecha.
- `Offer` ya contiene fecha/hora propuesta y duración estimada.
- La aceptación de ofertas ya comprueba cruces con trabajos acordados. Revisa su alcance antes de cambiarlo. El sistema NO debe bloquear la creación de ofertas solo porque el horario sea futuro o fuera del horario semanal; la disponibilidad se valida en el punto de acuerdo/planificación según el contrato actual.
- `OrderStatusHistory` y `OfferEvent` ya registran eventos. No crees un historial duplicado.
- `OrderLifecycleRegistry` y `NotificationsService` son los puntos de integración. No agregues una segunda infraestructura de eventos/notificaciones.
- RF-35 ya está implementado en Orders (vencimiento 7 días desde `publishedAt`, incluso en negociación). No dupliques job ni cambies la regla.

## Contrato con Persona A

Persona A es dueña de las transiciones de ciclo de vida de Order y de los módulos de visitas, presupuesto adicional, ejecución, cancelación y reclamos.

- No edites `OrderStatus`, `order-transition.ts`, `order-transition.spec.ts`, `orders.rules.ts` ni actualices `Order.status` directamente.
- Si necesitas una transición, solicita a Persona A un método público exportado desde OrdersModule, con estado de origen/destino, actor y precondiciones.
- Para timeline, consume historiales/eventos y métodos públicos de módulos. No leas ni escribas tablas internas ajenas si puedes usar un contrato de servicio.
- Para pagos y reviews, sé dueño de tus modelos y servicios. Coordina con A los campos inversos en `User`/`Order` y el schema compartido.
- No edites `src/app.module.ts` durante el trabajo paralelo; informa qué módulos deben registrarse.

## Reglas de negocio no negociables

1. Anticipo = 25% del monto acordado del trabajo.
2. Visita se paga en efectivo después de evaluación y se confirma con “Pago confirmado”.
3. Saldo al finalizar; trabajador confirma “Confirmo que me pagaron”.
4. Cliente también confirma “Ya pagué”; mantener las dos confirmaciones sin inferir una de la otra.
5. La plataforma solo registra declaraciones/confirmaciones. No procesa, recibe, retiene ni garantiza pagos.
6. Un comprobante subido es referencia, no prueba de que el dinero llegó.
7. No agregar reembolsos, retenciones, penalizaciones o conciliación financiera.
8. Calificación mutua 1–5, comentario opcional, solo tras trabajo terminado, una por parte; no permitir auto-calificación.
9. RF-36: la penalización por inasistencia y su efecto en estrellas están pendientes de definición del docente. No implementar ajuste automático de calificación.
10. Respetar la privacidad de pedidos, direcciones, archivos y datos de usuario.

## Fase 1 — Plan breve obligatorio

Antes de editar, responde con:
- RF cubiertos y criterios de aceptación.
- Qué existe y se reutiliza; brechas reales.
- Endpoints/DTOs/roles propuestos.
- Modelos Prisma propuestos para pagos/constancias y reviews, incluyendo unicidad y restricciones.
- Cómo se calculan y verifican anticipo/saldo sin procesar dinero.
- Cómo se consumen transiciones/estados expuestos por Persona A.
- Cómo se arma timeline sin duplicar historiales.
- Eventos y destinatarios de notificaciones.
- Conflictos potenciales con Persona A.
- Preguntas bloqueantes. Distingue decisión de negocio de decisión técnica.

No hagas una auditoría interminable: tras el plan, si no hay bloqueo de negocio, implementa los módulos independientes. Si una parte depende de un contrato pendiente de A, deja una interfaz/adapter claramente documentada y continúa con lo demás.

## Fase 2 — Implementación

- Agenda: completa la API existente de WorkerProfile; prueba horario dentro/fuera, límites, cruce de medianoche y zona horaria Bolivia. Para trabajos, valida el rango `[start, start + duration)`.
- Concurrencia: inspecciona y respeta el orden de locks documentado. No introduzcas deadlocks ni llames `lockWorker()` desde un hook que ya tenga el pedido bloqueado.
- Pagos: define registro inmutable de cada pago/confirmación con método `EFECTIVO` o `QR`, monto, fecha/hora y usuario que declara/confirmó. Aclara con tests que una confirmación de cliente y trabajador son afirmaciones independientes.
- Anticipo: calcula exactamente el 25% del monto acordado, con precisión Decimal de PostgreSQL/Prisma; no usar `number` para aritmética monetaria sensible.
- Constancia: cada servicio y pago tiene constancia propia, datos mínimos exigidos y permisos por participante/admin según RF. No presentar recibo subido como verificación bancaria.
- Reviews: una calificación por usuario/rol/servicio según el modelo de dominio; rating entero 1–5; bloquear autoevaluación; elegibilidad basada en trabajo terminado. Promedio agregado sin exponer datos privados.
- Timeline: construir lectura ordenada y paginada si el volumen lo requiere, desde fuentes existentes; incluir eventos nuevos vía hooks/servicios públicos.
- Notificaciones: reutilizar `NotificationsService`; para operaciones transaccionales pasar el `TransactionClient`; evitar duplicados y garantizar destinatarios correctos.
- No agregar dependencias sin justificar.
- Tests unitarios y E2E de permisos, fechas, cálculos Decimal, duplicados, concurrencia, notificaciones y privacidad.

## Fase 3 — Entrega

Ejecuta comandos aplicables: pruebas focalizadas, `npx prisma validate`, `npx prisma generate`, `npm run build`, `npm run lint`, `npm test` y `npm run test:e2e` (si DB de prueba disponible). No reportes pruebas no ejecutadas como exitosas.

Entrega:
1. Resumen por RF.
2. Endpoints, DTOs y permisos.
3. Modelos/Enums y migraciones creadas.
4. Contratos públicos que Persona A debe consumir o implementar.
5. Módulos que deben registrarse en `app.module.ts` (no lo edites ahora).
6. Archivos cambiados y `git diff --stat`.
7. Comandos y resultados reales.
8. Pendientes/bloqueos explícitos.

No hagas commit ni push salvo que el usuario lo pida.
