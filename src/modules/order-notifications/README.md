# OrderNotificationsModule (Persona B)

Avisos internos de eventos reales (RF-33; especificación v1.0 §6: canal interno,
historial completo, leído/no leído). Sin endpoints propios: los avisos se
consultan con `GET /api/notifications` (`NotificationsModule`).

Solo **registra hooks** en los puntos de extensión de otros módulos, que nunca
lo importan (sin ciclos). Todos los hooks son `inTransaction`: guardan el aviso
con el `tx` del hecho (si el aviso falla, el hecho se revierte), **sin llamadas
externas** y sin `lockWorker()` (el pedido ya está bloqueado). Quien origina el
hecho no se avisa a sí mismo. Los textos no incluyen dirección ni teléfono.

| Punto de extensión                              | Eventos                                                                                            | Destinatario                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OfferEventRegistry` (OffersModule)             | `PROPUESTA`                                                                                        | cliente (`OFERTA_RECIBIDA`)                                                                        |
|                                                 | `CONTRAOFERTA`                                                                                     | la otra parte (`CONTRAOFERTA_RECIBIDA`)                                                            |
|                                                 | `ACEPTADA` / `RECHAZADA`                                                                           | trabajador                                                                                         |
|                                                 | `RETIRADA`                                                                                         | cliente                                                                                            |
|                                                 | `VENCIDA`                                                                                          | cliente y trabajador (`OFERTA_VENCIDA`)                                                            |
| `OrderLifecycleRegistry` (OrdersModule)         | `CANCELADO`                                                                                        | trabajador asignado y oferentes con oferta abierta (`PEDIDO_CANCELADO`); el cliente que cancela no |
|                                                 | `VENCIDO`                                                                                          | cliente y oferentes con oferta abierta (`PEDIDO_VENCIDO`)                                          |
| `WorkflowEventRegistry` (ServiceWorkflowModule) | `VISITA_REGISTRADA`, `TRABAJO_INICIADO`, `ADICIONAL_PROPUESTO`, `TRABAJO_TERMINADO` (con el plazo) | cliente                                                                                            |
|                                                 | `ADICIONAL_ACEPTADO`, `ADICIONAL_RECHAZADO`, `CONFORMIDAD_CONFIRMADA`                                                     | trabajador                                                                                         |
|                                                 | `CIERRE_POR_PLAZO`, `RECLAMO_RESUELTO`                                                             | cliente y trabajador                                                                               |
|                                                 | `INASISTENCIA_REPORTADA`                                                                           | trabajador y administradores (solo se registra el hecho)                                           |
|                                                 | `RECLAMO_PRESENTADO`                                                                               | trabajador y administradores                                                                       |
|                                                 | `RECLAMO_EN_REVISION`                                                                              | cliente                                                                                            |

Los avisos de pagos (`PAGO_DECLARADO`, `PAGO_CON_DIFERENCIA`) y calificaciones
(`CALIFICACION_RECIBIDA`) los crean `PaymentsService` y `ReviewsService` en su
propia transacción. Pendiente de la matriz definitiva (especificación §7.4):
avisos de «próximo vencimiento» y «nuevo pedido compatible», no implementados.

## Cambios aditivos en módulos de otras personas

Para no editar la lógica de Offers: `OfferEventRegistry` (nuevo, mismo patrón
que `OrderLifecycleRegistry`) y una llamada `emit` dentro de cada transacción
que ya insertaba un `OfferEvent` (`PROPUESTA`, `CONTRAOFERTA`, `ACEPTADA`,
`RECHAZADA`/`RETIRADA`, `VENCIDA`). Sin hooks registrados no hace nada y el
constructor lo recibe como `@Optional()`: las reglas de negociación, aceptación y
cruces no cambian.
