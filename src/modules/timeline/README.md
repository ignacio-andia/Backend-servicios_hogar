# TimelineModule (Persona B)

Seguimiento del pedido (RF-32). **No lee tablas de otros módulos**: cada fuente
usa el servicio público del módulo propietario y se registra en
`TimelineSourceRegistry`. No existe historial duplicado.

## Endpoint

`GET /api/orders/:orderId/timeline?limit=50&cursor=…` — cliente dueño, trabajador
asignado o administrador (CU-32 A1). Cualquier otro, o un pedido inexistente: 404.
`limit` 1–100 (400 si no); `cursor` opaco (400 si es inválido).

Respuesta: `{ data: TimelineEvent[], nextCursor: string | null }`, del evento
más antiguo al más reciente (orden estable: fecha, fuente, id), sin repetir ni
saltar eventos entre páginas.

```ts
interface TimelineEvent {
  id: string;
  source: 'orders' | 'claims' | 'offers' | 'workflow' | 'payments';
  type: string;
  at: string;
  summary: string;
  actor:
    | { type: 'USUARIO'; userId: string | null; role: string | null }
    | { type: 'SISTEMA'; process: string };
  details?: Record<string, string | number | boolean | null>;
}
```

## Fuentes (lectores públicos)

| Fuente     | Servicio que lee                                                     | Eventos                                                                                                                   |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `orders`   | `OrdersService.listStatusHistory`                                    | publicado, negociación, acuerdo, anticipo, visita, ejecución, terminado, cierre, cancelación, vencimiento                 |
| `claims`   | `OrdersService.listStatusHistory` (entrada y salida de `EN_RECLAMO`) | reclamo presentado / resuelto (sin texto, fotos ni decisión)                                                              |
| `offers`   | `OffersService.listNegotiationEvents`, `getAcceptedOfferTerms`       | oferta, contraoferta y cierres con monto, **quién ofertó y a quién**; al acordar, monto acordado y **costo de la visita** |
| `workflow` | `WorkflowQueryService`                                               | costo de la visita, presupuestos adicionales (propuesto/aceptado), plazo de conformidad, conformidad, inasistencia        |
| `payments` | `PaymentsService.listTimelineFacts`                                  | constancia del servicio y cada declaración de pago                                                                        |

## Privacidad

- Sin dirección exacta, teléfono, correo ni ubicación en vivo (RF-32 criterio 2).
- El trabajador asignado **solo ve su propia negociación**, nunca las ofertas de
  otros trabajadores; el cliente y el administrador ven todas.
- El reclamo aparece como hecho, sin el texto del cliente ni la decisión.

## Extensión

Un módulo nuevo registra su lector con
`TimelineSourceRegistry.register({ name, listEvents(db, context) })` en
`onModuleInit` (`TimelineModule` lo exporta). Los nombres son únicos. Una fuente
que falla hace fallar la consulta completa (no oculta eventos en silencio).
