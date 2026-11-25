# AgendaModule (Persona B)

Agenda del trabajador (RF-29 a RF-31). **Solo lectura**: reutiliza el horario
semanal de `WorkerProfileModule` (`WorkerSchedule`, `schedules.ts`), los trabajos
acordados de `OffersModule`/`OrdersModule` y `slotsOverlap`. **No cambia** la
aceptación de ofertas ni las reglas de cruces, que siguen en
`OffersService.accept` bajo bloqueo.

## Qué ya existía (RF-29 a RF-31)

- `PUT /api/worker-profile/me/schedules` guarda el horario semanal y rechaza
  rangos superpuestos o con fin ≤ inicio (RF-29). `GET /worker-profile/me` lo
  devuelve dentro del perfil.
- La oferta ya incluye `proposedStartAt` y `estimatedDurationMinutes` (RF-31).
- `OffersService.accept` rechaza (409) un cruce con trabajos acordados (RF-30),
  con el rango `[inicio, inicio + duración)`. CANCELADO y CERRADO liberan la
  franja; TERMINADO y EN_RECLAMO la siguen ocupando (definición de A).
- Por aclaración del docente, el horario semanal **no limita las ofertas**.

## Endpoints nuevos (solo trabajador aprobado)

| Método y ruta               | Respuesta                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/agenda/me`        | `{ timeZone: "America/La_Paz", schedules[], jobs[] }`; cada trabajo: `orderId`, `orderStatus`, `startAt`, `endAt`, `durationMinutes`. Sin dirección. |
| `POST /api/agenda/me/check` | body `{ startAt, durationMinutes }` → `{ startAt, endAt, available, conflicts[], withinSchedule, note }`                                             |

- `startAt`: ISO 8601 **con zona explícita**. `durationMinutes`: entero 1–43200.
- `available` es la regla RF-30 (sin cruce con trabajos acordados; contiguo no
  cruza). `conflicts` muestra los horarios en conflicto (CU-30 A1).
- `withinSchedule`/`note` son **informativos**: indican si el rango cae dentro
  del horario de atención en hora de Bolivia; no bloquean nada.
- 400 datos inválidos; 401 sin sesión; 403 si no es trabajador aprobado.

## Pendiente

RF-31 A1 («si la duración real se extiende, el trabajador lo comunica y el
sistema vuelve a validar el horario») no está definido en los requerimientos ni
en el modelo; no se implementa.
