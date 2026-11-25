# WorkerProfileModule: perfil del trabajador y zona (RF-06 a RF-13)

Los endpoints, estados y documentos están en el [README raíz](../../../README.md)
y en los [contratos](../../../docs/frontend-api-contracts/README.md). Este
documento explica las reglas de **RF-13** y cómo debe usarlas otro módulo.

## Cambio de zona (RF-13)

- Solo un perfil `APROBADO` solicita un cambio; una solicitud `PENDIENTE` a la
  vez. El trabajador puede retirarla; el administrador la aprueba o rechaza.
- **No se puede solicitar con trabajo activo** (`TRABAJO_ACTIVO`):
  - `PEDIDOS` (la registra OrdersModule): pedidos asignados en
    `ACTIVE_ORDER_STATUSES`, es decir, de `ACORDADO` a `EN_RECLAMO`.
  - `OFERTAS` (la registra OffersModule): ofertas `VIGENTE` sin vencer de pedidos
    `PUBLICADO` o `EN_NEGOCIACION` sin vencer.
- `CERRADO` y `CANCELADO` no cuentan, ni las ofertas `ACEPTADA` o cerradas.

## Con una solicitud pendiente

| Categoría              | Operaciones                                                                                                                                                 | ¿Permitido? |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Nuevas oportunidades   | Ver pedidos disponibles que no está negociando; crear una oferta; figurar en `findApprovedWorkers`; recibir una asignación sin oferta vigente en ese pedido | **No**      |
| Negociaciones abiertas | Contraofertar (cualquiera de las partes), aceptar, rechazar y retirar                                                                                       | Sí          |
| Trabajos acordados     | Visita y su cobro, anticipo y saldo, inicio, presupuesto adicional, finalización, conformidad y cancelación                                                 | Sí          |
| Consultas              | Pedidos que está negociando, ofertas, agenda, seguimiento, calificaciones                                                                                   | Sí          |

Como la solicitud exige no tener negociaciones ni trabajos activos y no se
pueden crear nuevos mientras está pendiente, en el uso normal conviven con ella
sobre todo los pagos de pedidos `CERRADO`. Las demás filas permitidas son la
garantía de que ningún compromiso existente se detiene.

Al aprobarse, la zona del perfil se reemplaza y los pedidos disponibles, las
ofertas nuevas y `findApprovedWorkers` usan la **zona nueva**. Los trabajos
anteriores no cambian.

## Validaciones para otros módulos

| Método (dentro de la transacción del llamador) | Uso                            | Perfil aprobado, cuenta activa y rol | Solicitud pendiente |
| ---------------------------------------------- | ------------------------------ | ------------------------------------ | ------------------- |
| `lockApprovedWorker(tx, userId)`               | Trabajo nuevo                  | 403                                  | 409                 |
| `lockApprovedWorkerForAgreedWork(tx, userId)`  | Compromisos que ya existen     | 403                                  | No la consulta      |
| `assertNoPendingZoneChange(tx, profileId)`     | Con el trabajador ya bloqueado | —                                    | 409                 |

Ante la duda use `lockApprovedWorker`: es el que protege la regla.
`canTakeNewWork` (elegibilidad) es `false` mientras haya una solicitud pendiente
y se refiere solo a oportunidades nuevas.

`OrdersService.transition()` asigna un trabajador con solicitud pendiente
únicamente si `OpenNegotiationRegistry` (lo implementa OffersModule) confirma una
oferta vigente suya en ese pedido.

## Concurrencia

Orden de bloqueos: **cuenta → trabajador → pedido → oferta → catálogos**.
Solicitar un cambio, ofertar, contraofertar, aceptar, asignar y decidir una
solicitud bloquean la fila del perfil, así que se ejecutan de a una por
trabajador. Contraofertar y aceptar deciden además el vencimiento con
`clock_timestamp()`, ya con los bloqueos, para no continuar una oferta que
venció para una solicitud que ya no la contó.

## Pendiente

Si aprobar un cambio devuelve el perfil a revisión (hoy no) y si al aprobar se
vuelve a verificar el trabajo activo (`recheckActiveWorkOnApproval`,
desactivado).
