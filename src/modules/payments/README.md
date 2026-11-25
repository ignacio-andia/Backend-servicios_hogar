# PaymentsModule (Persona B)

Pagos y constancias (RF-39 a RF-43). **La plataforma no procesa, recibe,
retiene ni garantiza dinero** (RN-01, RF-43): solo registra las **declaraciones**
de las partes. Toda respuesta de pagos incluye el aviso de pago directo
(`notice`). Rutas bajo el prefijo global `/api`.

## Modelo (Prisma, migración `20261124200000_payments_reviews_notifications`)

| Tabla                  | Contenido                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments`             | Un pago por pedido y concepto (`VISITA`, `ANTICIPO`, `SALDO`), con `expectedAmount` congelado al crearse (anticipo y visita; el saldo es `null`). Único `(orderId, concept)`. Solo inserción.             |
| `payment_declarations` | Declaración de una parte (`CLIENTE` o `TRABAJADOR`): usuario, método (`EFECTIVO`/`QR`), monto, fecha y hora. **Una por pago y parte**, `amount > 0`. Solo inserción (trigger): es la constancia del pago. |
| `service_receipts`     | Constancia del servicio: una por pedido con acuerdo (cliente, trabajador, monto acordado). Se emite al aceptar la oferta, en la misma transacción. Solo inserción.                                        |

`referenceFileKey` (comprobante de QR como **referencia**, no prueba de cobro)
está reservado en `payment_declarations`; **la subida de comprobantes todavía no
está implementada**.

## Reglas

- **Anticipo (RN-02):** 25 % del **monto de la oferta aceptada**, con
  `Prisma.Decimal`, redondeado a 2 decimales con mitad hacia arriba
  (`100.02 → 25.01`). Se congela en `payments.expectedAmount`. _Pendiente de
  confirmar con el docente:_ si la base debe incluir los presupuestos adicionales
  (hoy no: el anticipo se registra antes de que exista un adicional). El cálculo
  está aislado en `PaymentsService.expectedFor` / `computeAdvanceAmount`.
- **Visita (RN-04):** solo en efectivo. El trabajador confirma con «Pago
  confirmado» en `ServiceWorkflowModule`, que llama a este módulo por
  `VisitPaymentRegistry`. Sin costo (o gratis) no hay concepto de pago.
- **Saldo (RN-03):** declarable con el pedido `TERMINADO` (o `EN_RECLAMO`/`CERRADO`).
  Saldo esperado informativo = monto acordado + adicionales **aceptados** −
  anticipo (`WorkflowQueryService.getAgreedAmount`). El monto real es lo que las
  partes declaran; un monto distinto solo se informa como diferencia. Sin pagos
  parciales encadenados.
- **Confirmaciones distintas por concepto:** `VISITA`, `ANTICIPO` y `SALDO`
  exigen al trabajador asignado. La del cliente («Ya pagué», RF-42) es siempre
  complementaria. **Una declaración nunca completa ni se infiere de la otra.** La
  comparación (`SOLO_CLIENTE`, `SOLO_TRABAJADOR`, `MONTOS_COINCIDEN`,
  `MONTOS_DIFERENTES`) es **informativa**, no una conciliación.
- **Anticipo: lo confirma exclusivamente el trabajador asignado (decisión
  funcional definitiva).**
  - El cliente puede declarar que pagó (`POST …/payments/ANTICIPO/declarations`);
    eso nunca avanza el pedido.
  - La declaración del trabajador asignado en ese mismo endpoint es la
    confirmación de recepción. Debe ser por el monto esperado (25 %); otro monto
    responde **409** y no registra nada.
  - Registra la declaración (usuario, monto, método, fecha) y llama a
    `OrdersService.transition()` en la misma transacción
    (`ACORDADO → ANTICIPO_REGISTRADO`, actor: el trabajador). Los invariantes
    `beforeTransition` siguen aplicando.
  - Repetir la misma confirmación (mismo monto y método) es idempotente: 201 con
    lo ya registrado, sin duplicar declaraciones, avisos ni historial. Con otro
    método, **409**.
  - Un tercero o un administrador recibe **404** y un trabajador sin perfil
    aprobado **403**; el cliente nunca confirma en nombre del trabajador (la
    parte sale del token y del pedido).
  - No hay configuración que cambie esta regla:
    `PAYMENTS_ADVANCE_CONFIRMED_BY` solo admite `TRABAJADOR`.
  - La regla también se exige en `OrdersService.transition()`: para
    `ACORDADO → ANTICIPO_REGISTRADO` el actor debe ser el trabajador asignado
    (si no, **403**) y Orders pide a este módulo, por
    `AdvanceConfirmationRegistry`, la confirmación de ESE pedido por el 25 %
    (si no existe, **409**). Ningún otro módulo puede saltarla.
- **Cambio de zona pendiente (RF-13):** no afecta a las declaraciones, porque son
  pagos de un trabajo ya acordado. La del trabajador usa
  `lockApprovedWorkerForAgreedWork`: sigue exigiendo perfil aprobado, cuenta
  activa y rol (403).
- Pagos y constancias **no cierran el pedido**: `TERMINADO → CERRADO` es de A.
- **Pedido cancelado:** solo admite la **visita ya realizada** y con costo
  (`Pago confirmado` del trabajador y «Ya pagué» del cliente). Ni anticipo ni
  saldo: el tratamiento del anticipo al cancelar está pendiente del docente.
- **Cerrado por rechazo de un adicional (RF-27):** solo la visita; el saldo
  responde 409 y el resumen informa `balance.status: "NO_APLICA"`.

## Endpoints

| Método y ruta                                          | Rol                                               | Respuesta                                                 |
| ------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------- |
| `GET /orders/:orderId/payments`                        | cliente dueño, trabajador asignado, administrador | `PaymentsOverview`                                        |
| `POST /orders/:orderId/payments/:concept/declarations` | cliente dueño o trabajador asignado               | 201 `DeclarationResult`                                   |
| `GET /orders/:orderId/receipts`                        | cliente dueño, trabajador asignado, administrador | `ReceiptsView`                                            |
| `GET /admin/payments/differences?page&limit`           | administrador                                     | pagos cuyas declaraciones difieren en el monto (RF-42 A1) |

`:concept` ∈ `VISITA | ANTICIPO | SALDO`. Body de la declaración:
`{ "amount": "30.13", "method": "EFECTIVO" | "QR" }`. El monto es texto decimal
mayor que 0, con hasta 8 enteros y 2 decimales (un número JSON también se
acepta). **La parte (cliente o trabajador) sale del pedido y del token, nunca del
cuerpo**; campos extra → 400.

Errores: 400 datos inválidos o método no permitido (la visita solo en efectivo);
401 sin sesión; 403 rol sin acceso a la ruta (una cuenta solo administrador en
`POST`) o trabajador no habilitado; **404** pedido ajeno o inexistente; **409**
estado del pedido que no admite el concepto, pedido sin oferta aceptada, ya
declarado (una declaración por parte y concepto) o intento del trabajador de
declarar la visita por este endpoint (se confirma con «Pago confirmado» de la
visita).

### Ejemplo

```json
POST /api/orders/{orderId}/payments/ANTICIPO/declarations
{ "amount": "30.13", "method": "QR" }

201
{
  "notice": "El pago se realiza directamente al trabajador...",
  "orderTransition": "NO_APLICA",
  "payment": {
    "concept": "ANTICIPO", "paymentId": "…", "expectedAmount": "30.13",
    "requiredConfirmation": "TRABAJADOR",
    "comparison": "SOLO_CLIENTE", "difference": null, "methodsMatch": null,
    "declarations": [{ "id": "…", "declaredBy": "CLIENTE", "userId": "…",
      "method": "QR", "amount": "30.13", "createdAt": "…" }]
  }
}
```

## Integración con otros módulos

- Importa (sin ciclos): `OrdersModule` (`findOrderSummary`, `transition`),
  `OffersModule` (`getAcceptedOfferTerms`, `OfferEventRegistry`),
  `ServiceWorkflowModule` (`WorkflowQueryService`, `VisitPaymentRegistry`),
  `WorkerProfileModule`, `NotificationsModule`.
- `PaymentsIntegration` (en `onModuleInit`): registra el puerto del cobro de la
  visita en `VisitPaymentRegistry` y un hook en `OfferEventRegistry` que emite la
  constancia del servicio al aceptar una oferta. **`VisitPaymentRegistry` admite
  un solo registrador**: ninguna prueba ni módulo debe registrar otro junto con
  `PaymentsModule`.
- `PaymentsIntegration` también registra en `AdvanceConfirmationRegistry`
  (OrdersModule) la verificación `hasValidAdvanceConfirmation`.
- Notificaciones (`PAGO_DECLARADO`, `PAGO_CON_DIFERENCIA`) con el `tx` de la
  declaración. Sin llamadas externas.
- Orden de bloqueos: trabajador (si declara el trabajador) → pedido.

## Configuración

| Variable                        | Valores                                      | Efecto                                                                                                |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PAYMENTS_ADVANCE_CONFIRMED_BY` | solo `TRABAJADOR` (opcional; predeterminado) | El anticipo lo confirma el trabajador asignado. `CLIENTE`, `AMBOS` u otro valor detienen el arranque. |

## Pruebas

`payments.rules.spec.ts` (Decimal, redondeo, comparación, saldo, DTO),
`payments.policy.spec.ts` (configuración y políticas) y
`test/payments-reviews.e2e-spec.ts` (permisos, duplicados, concurrencia,
inmutabilidad en la BD, transición con cada política, visita, saldo con
adicionales, avisos).
