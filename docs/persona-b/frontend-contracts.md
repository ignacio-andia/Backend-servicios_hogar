# Contratos para el frontend — Persona B

Pagos y constancias, calificaciones, perfil público, seguimiento, agenda y avisos.
Prefijo global `/api`. Autenticación: `Authorization: Bearer <JWT>` (salvo las
rutas marcadas **público**). Montos: **texto decimal con 2 decimales** (`"30.13"`),
nunca números. Fechas: ISO 8601 UTC. Errores estándar de Nest:
`{ statusCode, message, error }`; los 400 de validación traen `message: string[]`.

Convención de acceso: un pedido ajeno o inexistente responde **404** (no revela
que existe); un rol sin acceso a la ruta responde **403**.

## Enums

```ts
type PaymentConcept = 'VISITA' | 'ANTICIPO' | 'SALDO';
type PaymentMethod = 'EFECTIVO' | 'QR';
type PaymentDeclarer = 'CLIENTE' | 'TRABAJADOR';
type DeclarationComparison =
  | 'SIN_DECLARACIONES'
  | 'SOLO_CLIENTE'
  | 'SOLO_TRABAJADOR'
  | 'MONTOS_COINCIDEN'
  | 'MONTOS_DIFERENTES'; // informativo, NO es conciliación
type RequiredConfirmation = 'TRABAJADOR'; // en los tres conceptos
type OrderTransitionOutcome = 'ANTICIPO_REGISTRADO' | 'NO_APLICA';
```

Nuevos valores de `NotificationType`: `OFERTA_RECIBIDA`, `CONTRAOFERTA_RECIBIDA`,
`OFERTA_ACEPTADA`, `OFERTA_RECHAZADA`, `OFERTA_RETIRADA`, `OFERTA_VENCIDA`,
`PEDIDO_CANCELADO`, `PEDIDO_VENCIDO`, `VISITA_REGISTRADA`, `TRABAJO_INICIADO`,
`PRESUPUESTO_ADICIONAL_PROPUESTO`, `PRESUPUESTO_ADICIONAL_ACEPTADO`,
`PRESUPUESTO_ADICIONAL_RECHAZADO`,
`TRABAJO_TERMINADO`, `CONFORMIDAD_CONFIRMADA`, `PEDIDO_CERRADO_POR_PLAZO`,
`INASISTENCIA_REPORTADA`, `RECLAMO_PRESENTADO`, `RECLAMO_EN_REVISION`,
`RECLAMO_RESUELTO`, `PAGO_DECLARADO`, `PAGO_CON_DIFERENCIA`, `CALIFICACION_RECIBIDA`.
Nuevos valores de `NotificationResourceType`: `PEDIDO`, `OFERTA`, `RECLAMO`, `PAGO`
(navegar al pedido, oferta o reclamo con `resourceId`; `PAGO` está definido pero
ningún aviso lo usa hoy: los de pagos llegan como `PEDIDO`).

## Pagos (cliente, trabajador asignado; el administrador solo consulta)

```ts
interface DeclarationView {
  id: string;
  declaredBy: PaymentDeclarer;
  userId: string;
  method: PaymentMethod;
  amount: string;
  createdAt: string;
}
interface PaymentView {
  concept: PaymentConcept;
  paymentId: string | null;
  expectedAmount: string | null; // anticipo y visita; null en el saldo
  requiredConfirmation: RequiredConfirmation; // la del cliente es siempre opcional
  declarations: DeclarationView[];
  comparison: DeclarationComparison;
  difference: string | null; // trabajador − cliente
  methodsMatch: boolean | null;
}
interface PaymentsOverview {
  orderId: string;
  orderStatus: string;
  notice: string; // RF-43: mostrar siempre en pantallas de pago
  agreement: {
    baseAmount: string;
    acceptedAdditional: string;
    totalAmount: string;
  } | null;
  advanceTransition: 'ACTIVA';
  payments: PaymentView[]; // VISITA solo si la visita tiene costo
  balance: {
    status: 'CALCULADO' | 'PENDIENTE_INTEGRACION' | 'NO_APLICA';
    /* el segundo: sin oferta aceptada */ amount: string | null;
    advanceAmount: string | null;
    additionalBudgetsTotal: string | null;
    note: string;
  };
}
interface DeclarationResult {
  notice: string;
  payment: PaymentView;
  orderTransition: OrderTransitionOutcome;
}
interface ReceiptsView {
  orderId: string;
  notice: string;
  referenceNotice: string;
  service: {
    clientId: string;
    workerId: string;
    agreedAmount: string;
    issuedAt: string;
  } | null;
  payments: {
    concept: PaymentConcept;
    paymentId: string;
    declaration: DeclarationView;
  }[];
}
```

| Llamada                                                | Detalle                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /orders/:orderId/payments`                        | `PaymentsOverview`. Mostrar el `notice`; **no existe botón para pagar a la plataforma**.                                                                                                                                                                             |
| `POST /orders/:orderId/payments/:concept/declarations` | body `{ amount: string, method: PaymentMethod }` → 201 `DeclarationResult`. Cliente: «Ya pagué». Trabajador: «Confirmo que me pagaron» (anticipo y saldo). **La visita la confirma el trabajador con `POST /orders/:id/visit/payment-confirmation` (ya existente).** |
| `GET /orders/:orderId/receipts`                        | `ReceiptsView`. El comprobante es solo referencia: mostrar `referenceNotice`.                                                                                                                                                                                        |
| `GET /admin/payments/differences?page&limit`           | admin: `{ data: { paymentId, orderId, concept, clientAmount, workerAmount, difference, createdAt }[], meta }`                                                                                                                                                        |

### Anticipo (25 %)

Lo confirma **exclusivamente el trabajador asignado**:

- «Ya pagué» del cliente: 201 con `orderTransition: "NO_APLICA"`; el pedido sigue
  `ACORDADO`.
- Confirmación del trabajador: `amount` igual a `expectedAmount`; 201 con
  `orderTransition: "ANTICIPO_REGISTRADO"` y el pedido pasa a ese estado.
- Repetirla con el mismo monto y método devuelve 201 con lo ya registrado
  (idempotente). Otro monto: 409 con el monto esperado. Otro método: 409.

Configuración del backend: `PAYMENTS_ADVANCE_CONFIRMED_BY` solo admite
`TRABAJADOR`, que es además el valor predeterminado; cualquier otro valor impide
arrancar la aplicación.

### Errores

Errores de `POST`: 400 monto inválido / método no permitido (visita: solo
`EFECTIVO`); 403 trabajador sin perfil aprobado; 404 no es parte del pedido; 409
estado que no admite el concepto, sin oferta aceptada, monto del anticipo
distinto del esperado, **ya declaró** (una vez por parte y concepto) o trabajador
declarando la visita. Una solicitud de cambio de zona pendiente no afecta a los
pagos (RF-13).

## Calificaciones y perfil público

```ts
interface ReviewView {
  id: string;
  orderId: string;
  authorRole: 'CLIENTE' | 'TRABAJADOR';
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string | null;
  createdAt: string;
  hidden: boolean;
}
interface MyReviewStatus {
  orderId: string;
  canReview: boolean;
  reason: string | null;
  alreadyReviewed: boolean;
  review: ReviewView | null;
}
interface PublicOpinion {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  author: string;
} // "María P."
interface PublicWorkerProfileView {
  profile: {
    workerId: string;
    firstName: string;
    lastName: string;
    yearsOfExperience: number;
    description: string | null;
    zone: { id: string; name: string; isActive: boolean } | null;
    specialties: { id: string; name: string; isActive: boolean }[];
  };
  rating: { average: number | null; count: number; message: string | null };
  recentOpinions: PublicOpinion[];
}
```

| Llamada                                                                                                            | Acceso                              |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `POST /orders/:orderId/reviews` `{ rating, comment? }` → 201 `ReviewView`                                          | cliente dueño / trabajador asignado |
| `GET /orders/:orderId/reviews/mine` → `MyReviewStatus` (usar `reason` para explicar por qué no se puede calificar) | participante                        |
| `GET /reviews/received?page&limit`                                                                                 | cliente o trabajador                |
| `GET /workers/:workerId/public-profile`                                                                            | **público**                         |
| `GET /workers/:workerId/reviews?page&limit` (`limit` ≤ 50) → `{ data: PublicOpinion[], meta }`                     | **público**                         |
| `GET /admin/reviews?page&limit`, `PATCH /admin/reviews/:reviewId/hide`                                             | administrador                       |

Errores: 400 rating no entero 1–5 o comentario > 1000; 404 pedido ajeno o
trabajador no público; 409 pedido que aún no se puede calificar, sin otra parte
o ya calificado. **Mientras `REVIEWS_ELIGIBLE_STATUSES` no se configure, `canReview`
es siempre `false`** (`reason`: «Las calificaciones todavía no están habilitadas.»).
`average: null` y `message` indican «aún no tiene calificaciones».

## Seguimiento

`GET /orders/:orderId/timeline?limit=50&cursor=` → `{ data: TimelineEvent[], nextCursor: string | null }`.
Pedir la página siguiente con `cursor=nextCursor` hasta que sea `null`.
Orden: del más antiguo al más reciente. `limit` 1–100.

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

Mostrar `summary` y `at`; `details` es opcional (monto, costo de la visita, motivo).
No incluye dirección ni ubicación en vivo. El trabajador solo ve su propia
negociación.

## Agenda (trabajador aprobado)

```ts
GET /agenda/me → { timeZone: 'America/La_Paz';
  schedules: { id: string; dayOfWeek: string; startTime: 'HH:mm'; endTime: 'HH:mm'; isActive: boolean }[];
  jobs: { orderId: string; orderStatus: string; startAt: string; endAt: string; durationMinutes: number }[] }
POST /agenda/me/check { startAt: string /* ISO con zona */, durationMinutes: number /* 1..43200 */ }
  → { startAt; endAt; available: boolean; conflicts: Job[]; withinSchedule: boolean; note: string | null }
```

`available` es el único bloqueo real (cruce con trabajos acordados);
`withinSchedule` es informativo. El horario semanal se guarda con
`PUT /worker-profile/me/schedules` (ya existente).

## Avisos

Se leen con `GET /notifications` (ya existente). Los títulos y mensajes llegan
armados; usar `type`, `resourceType` y `resourceId` para navegar.
