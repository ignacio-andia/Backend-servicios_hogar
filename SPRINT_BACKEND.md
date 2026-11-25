# SPRINT BACKEND — Integración de funcionalidades pendientes

**Proyecto:** Plataforma web de servicios técnicos del hogar (Cochabamba)  
**Base:** backend recibido el 23/11/2026; NestJS 12, TypeScript 6, Prisma 7, PostgreSQL, Vitest.  
**Equipo activo:** 2 desarrolladores con Claude Code.  
**Objetivo:** implementar el máximo alcance funcional verificable sin reescribir módulos existentes ni introducir reglas de negocio no aprobadas.

## 1. Fuentes de verdad y precedencia

1. `Documento_Requerimientos_Servicios_Hogar_v1.2.pdf`: requerimientos RF/RN y casos de uso originales.
2. `Aruitectura de desarro Backend.pdf`: arquitectura oficial: monolito modular NestJS; Prisma centralizado; servicios públicos entre módulos; controllers sin lógica de negocio ni acceso directo a Prisma.
3. `Especificacion_Funcional_Decisiones_Proyecto_Servicios_Hogar_v1.0.docx` y `Adenda_Especificacion_Funcional_ArreglaloYA_v1.1.docx`: decisiones posteriores confirmadas y sus asuntos pendientes.
4. Código actual y contratos en `docs/frontend-api-contracts/`: describen el comportamiento implementado, pero no invalidan una regla funcional confirmada.
5. Este archivo: coordinación técnica del sprint; no puede inventar reglas funcionales ni contradecir las fuentes anteriores.

Si hay contradicción o falta una decisión, documentarla como **BLOQUEO DE NEGOCIO** y no implementar una interpretación unilateral.

## 2. Línea base técnica observada

- Módulos actuales: `auth`, `users`, `catalogs`, `audit`, `notifications`, `worker-profile`, `orders`, `offers`.
- `WorkerProfileModule` ya contiene `WorkerSchedule`, CRUD/normalización de horarios, zona `America/La_Paz`, `isWithinSchedules()` y utilidades de validación temporal.
- `Offer` ya contiene `proposedStartAt` y `estimatedDurationMinutes`.
- `OrdersModule` ya contiene estados del ciclo de vida hasta `CERRADO`, `EN_RECLAMO`, `CANCELADO`, etc.; `OrdersService.transition()` es la puerta central para cambios de estado y asignación.
- `OrderLifecycleRegistry` permite hooks transaccionales y post-commit. Un hook ejecutado dentro de la transacción no debe llamar `lockWorker()` porque el pedido ya está bloqueado; el orden de locks documentado es trabajador → pedido → catálogo.
- `WorkerActiveWorkRegistry` y `OrdersActiveWorkSource` permiten consultar trabajo activo sin duplicar la propiedad de los datos.
- `NotificationsService.create()` y `createForRole()` reciben un `Prisma.TransactionClient` para guardar la notificación en la misma transacción que el evento.
- `OrderStatusHistory` es el historial de cambios. No crear un segundo historial genérico de estados del pedido.
- `RF-35`: el vencimiento del pedido ya está implementado en Orders: siete días calendario desde `publishedAt`, incluso en `EN_NEGOCIACION`, sin reiniciar por edición ni republicación. No construir otro job de vencimiento.
- No se identificó `VisitsModule`, `ServiceExecutionModule`, `PaymentsModule`, `ClaimsModule` ni `ReviewsModule` funcionales en el árbol recibido.

## 3. Alcance y responsables

### Persona A — Ciclo de vida, visitas, ejecución y situaciones especiales

**RF asignados:** RF-25, RF-26, RF-27, RF-28, RF-34, RF-36, RF-37 y RF-38.  
**Módulos sugeridos:** `service-workflow` (visita, presupuesto adicional, ejecución/conformidad), `claims` (reclamos y decisión administrativa) o una separación equivalente justificada por el código.  
**Responsabilidad principal:** diseñar y controlar las transiciones de estados de `Order` relacionadas con visita, presupuesto adicional, ejecución, cancelación y reclamo.

Entregables funcionales:
- RF-25: registro de visita y confirmación de cobro en efectivo después de la evaluación.
- RF-26: presupuesto adicional con monto, motivo y materiales; el trabajador no modifica el monto acordado; el cliente acepta o rechaza antes de continuar.
- RF-27: rechazo del presupuesto adicional detiene el trabajo y lo cierra; queda pendiente únicamente el cobro de la visita, según el requerimiento.
- RF-28: trabajador marca terminado; cliente dispone de siete días calendario para confirmar conformidad o presentar reclamo.
- RF-34: cancelación de trabajo, registrando actor, fecha/hora y motivo. No decidir el destino del anticipo.
- RF-36: reporte de inasistencia del trabajador por el cliente y registro auditable. No inventar penalización ni efecto sobre estrellas.
- RF-37: reclamo del cliente con descripción y fotos dentro de los siete días posteriores al trabajo.
- RF-38: administrador registra decisión y se comunica a las partes.

### Persona B — Agenda, seguimiento, pagos/constancias y calificaciones

**RF asignados:** RF-29, RF-30, RF-31, RF-32, RF-33, RF-39, RF-40, RF-41, RF-42, RF-43, RF-44, RF-45 y RF-46.  
**Módulos sugeridos:** completar `worker-profile` para agenda; `payments` (registros/constancias); `reviews` (calificaciones). Seguimiento y notificaciones deben reutilizar `OrderStatusHistory`, `OfferEvent`, `OrderLifecycleRegistry` y `NotificationsService`.

Entregables funcionales:
- RF-29: completar/validar horarios de atención reutilizando `WorkerSchedule` y `schedules.ts`; no crear otro calendario semanal.
- RF-30/RF-31: validar que visitas y ejecuciones no se solapen, usando fecha/hora y duración estimada; revisar la protección concurrente existente antes de agregar locks.
- RF-32: exponer línea de tiempo del pedido con los eventos exigidos, incluyendo quién ofertó/a quién, costo de visita y finalización. Reutilizar historiales existentes y datos de los nuevos módulos; no duplicar historial de estados.
- RF-33: notificaciones internas de eventos relevantes. Reutilizar el servicio actual y guardar dentro de la transacción cuando el evento sea transaccional.
- RF-39: registrar anticipo del 25% del monto acordado, método efectivo o QR.
- RF-40: trabajador confirma cobro del saldo.
- RF-41: constancia separada de servicio y de cada pago con fecha/hora, usuario, monto y método. Un comprobante es referencia, no prueba de recepción.
- RF-42: cliente también puede confirmar “Ya pagué”; mantener ambas confirmaciones.
- RF-43: solo registro/constancia. La plataforma no procesa, recibe, retiene ni garantiza dinero.
- RF-44/RF-45: calificación mutua 1–5, comentario opcional, solo tras trabajo terminado y una vez por parte; bloquear auto-calificación.
- RF-46: promedio y opiniones visibles en perfil público del trabajador, sin filtrar información privada.

## 4. Reglas funcionales que no se pueden reinterpretar

- Pago directo cliente→trabajador; no hay pasarela ni custodia de dinero.
- Anticipo del 25% del monto acordado; saldo al finalizar. La visita se paga en efectivo tras evaluación.
- El trabajador no puede cambiar el monto acordado. Un extra requiere aceptación del cliente.
- El reclamo se presenta dentro de siete días calendario desde el trabajo terminado.
- Calificación mutua solo después de trabajo terminado.
- Un trabajador no puede tener dos trabajos en horarios superpuestos.
- No se promete disponibilidad permanente ni tiempo de llegada.
- No calificar ni aceptar pedidos propios.
- Solo trabajador aprobado participa en el flujo de trabajo.
- Cancelación: el requerimiento deja sin definir el tratamiento del anticipo. No implementar devolución, retención, penalización, crédito ni disputa monetaria sin decisión expresa del docente/equipo.
- Inasistencia: registrar el hecho; la penalización en la calificación queda sujeta a definición del docente. No traducirla a estrellas automáticamente.
- RF-35 ya está implementado como expiración a siete días desde `publishedAt`; no duplicarlo ni modificarlo salvo bug demostrado.

## 5. Contrato de integración entre personas

### Propiedad de archivos y responsabilidades

- **Persona A es dueña** de los cambios en `OrderStatus`, reglas/transiciones de ciclo de vida y servicios de workflow/cancelación/reclamo.
- **Persona B no debe editar** `OrderStatus`, `order-transition.ts`, `order-transition.spec.ts` ni las reglas de transición de Orders. Si necesita una transición, debe solicitar a A un método público de `OrdersService` con origen/destino/actor y precondiciones explícitas.
- **Persona B es dueña** de los modelos propios de pagos/constancias y reviews, más sus servicios/controladores/DTO/tests. Los campos inversos en `User`/`Order` deben coordinarse con A para evitar pisar el schema.
- Cada persona puede crear su módulo y tests, pero **no editar `src/app.module.ts`** durante el trabajo paralelo. Entregar las importaciones y módulos que deben registrarse; se integrarán al final.
- No editar los mismos archivos de contratos/documentación a la vez. Cada PR actualiza solo su documentación de módulo.
- No modificar Orders/Offers ya aprobados sin un bug reproducible o una dependencia funcional documentada.

### Prisma y migraciones

- Cada desarrollador usa una base PostgreSQL local independiente; nunca una DB compartida para `prisma migrate dev`.
- Cada persona puede añadir sus modelos/relaciones en `schema.prisma` solo en el área asignada, ejecutar `prisma format`, `prisma validate` y `prisma generate`.
- La modificación de `schema.prisma` es compartida: antes de cambiar un enum o relación propiedad del otro, coordinarlo.
- Migraciones: generar migraciones draft en la rama propia con nombre descriptivo y no aplicar a una DB compartida. No reescribir migraciones ya existentes.
- Al integrar, un Claude integrador revisará el schema combinado y las migraciones en orden; podrá regenerar/reconciliar migraciones nuevas si es necesario. Nunca ejecutar `prisma migrate reset` en una DB con datos que deban conservarse.
- No commitear `.env`, credenciales ni secretos. Usar `.env.example` como referencia.

### Dependencias públicas

- Persona A expone servicios públicos de workflow/reclamos para consultar estado y ejecutar transiciones autorizadas; Persona B consume esos servicios, nunca escribe `Order.status` directamente.
- Persona B expone consultas públicas para pagos/constancias y reviews cuando otro módulo las necesite; no permite que otros módulos escriban sus tablas directamente.
- Los hooks de `OrderLifecycleRegistry` deben ser idempotentes y transaccionales. No introducir dependencia circular.
- Respetar el orden de bloqueos existente: trabajador → pedido → catálogo. No bloquear trabajador desde un hook cuando el pedido ya está bloqueado.

## 6. Estrategia de ramas y PR

1. Crear `integration/sprint-1` desde el `main` actualizado.
2. Cada persona crea su rama desde `integration/sprint-1` (no desde una copia antigua de `main`).
3. Abrir PR de cada rama hacia `integration/sprint-1`; no fusionar directamente a `main`.
4. Integrador Claude revisa primero los contratos y schema, luego integra PR A y B, resuelve conflictos mecánicos y ejecuta validaciones.
5. El integrador no decide ambigüedades funcionales ni hace cambios destructivos. Eleva cualquier conflicto semántico al equipo.
6. Tras build, lint, unitarias, E2E y migraciones validadas en DB limpia y DB con migraciones previas, crear PR `integration/sprint-1` → `main`.
7. El usuario revisa y realiza el merge final.

## 7. Validación mínima antes de declarar terminado

Comandos disponibles según `package.json`:

```bash
npm ci
npx prisma validate
npx prisma generate
npm run build
npm run lint
npm test
npm run test:e2e
```

- Ejecutar primero las pruebas focalizadas del módulo; después la suite completa.
- E2E requiere PostgreSQL de prueba configurado según `.env.example`/README.
- Reportar comandos ejecutados, resultado y cualquier test omitido. No afirmar que algo pasó si no se ejecutó.
- Añadir pruebas de permisos, límites temporales, concurrencia, transacciones, idempotencia y casos negativos.
- Actualizar contrato API y README del módulo con endpoints, DTOs, respuestas, estados, permisos y ejemplos.

## 8. Protocolo de trabajo con Claude Code

Para cada persona:
1. Leer `CLAUDE.md`, `AGENTS.md`, este archivo, requerimientos y arquitectura.
2. Inspeccionar el código real antes de editar.
3. Presentar un plan breve: RF, archivos existentes a reutilizar, nuevos archivos, modelos, endpoints, dependencias, riesgos y preguntas bloqueantes.
4. Si no hay bloqueo de negocio, implementar en incrementos pequeños y probar cada uno.
5. No detenerse en una auditoría genérica; el objetivo es implementar el alcance asignado.
6. Antes de terminar, mostrar `git diff --stat`, lista de archivos, migraciones creadas, comandos/tests ejecutados y limitaciones.

## 9. Definiciones bloqueadas

- Tratamiento del anticipo cuando se cancela un trabajo (RF-34): pendiente de docente.
- Penalización concreta por inasistencia y su impacto en calificaciones (RF-36): pendiente de docente.
- Cualquier efecto económico, devolución o sanción no expresamente definido: no implementar.
- Si el rechazo de presupuesto adicional implica un flujo distinto a “detener y cerrar dejando pendiente solo visita”, solicitar decisión antes de ampliar el comportamiento.
