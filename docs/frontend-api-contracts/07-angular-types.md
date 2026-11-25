# 07. Tipos TypeScript propuestos para Angular

> **Propuesta.** Estos tipos reproducen **exactamente** los contratos documentados en 02 y 03: mismos nombres de campo, mismos tipos y misma nulabilidad. No agregan propiedades. Los nombres de las interfaces son sugerencias; los de los **campos** no se pueden cambiar.

## Convenciones

- **Fechas:** `string` (ISO 8601 UTC). Convierta a `Date` en la capa de presentación, no en el modelo.
- **Montos:** `string` (`"150.50"`). No los convierta a `number` para operar: use una librería decimal si hace falta calcular.
- **Entrada y salida:** tipos **separados**. `XxxRequest` es lo que se envía; `Xxx` o `XxxResponse` es lo que se recibe.
- **`?` y `null` en la entrada:**
  - `prop?: T`: se puede omitir, pero no enviar `null`.
  - `prop?: T | null`: se puede omitir o enviar `null`.
- **`null` en la respuesta:** `prop: T | null`. Las propiedades de respuesta **siempre** están presentes; ninguna es opcional, salvo `OrderWarning.orderIds`.
- Las interfaces de este archivo cubren los endpoints **#1–#81**. Para **#82–#115** (flujo del trabajo, reclamos, pagos, calificaciones, agenda y seguimiento) la fuente contractual es [10](10-sprint1-endpoints.md): sus entradas, modelos y valores no se repiten aquí, para no mantener dos definiciones. Si algo difiere, manda 10.
- Al escribir esos tipos, reutilice los de aquí: `CatalogRef` es el mismo; `ScheduleView` de 10 es `Schedule`; `OwnerOrderView` es `OwnerOrder`; `Paginated<T>` es `PaginatedResponse<T>`.
- `NotificationType` y `NotificationResourceType` son compartidos por todos los endpoints y se listan completos (significado en [04](04-enums-and-states.md)).

```ts
// =====================================================================
// Enumeraciones (valores exactos del backend)
// =====================================================================
export const ROLE_NAMES = ['CLIENTE', 'TRABAJADOR', 'ADMINISTRADOR'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const USER_STATUSES = ['ACTIVO', 'INACTIVO', 'SUSPENDIDO'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const WORKER_PROFILE_STATUSES = [
  'BORRADOR',
  'PENDIENTE',
  'OBSERVADO',
  'APROBADO',
  'RECHAZADO',
  'SUSPENDIDO',
] as const;
export type WorkerProfileStatus = (typeof WORKER_PROFILE_STATUSES)[number];

export const WEEK_DAYS = [
  'LUNES',
  'MARTES',
  'MIERCOLES',
  'JUEVES',
  'VIERNES',
  'SABADO',
  'DOMINGO',
] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export const WORKER_DOCUMENT_TYPES = [
  'IDENTIDAD',
  'ANTECEDENTES',
  'CERTIFICADO',
  'REFERENCIA',
] as const;
export type WorkerDocumentType = (typeof WORKER_DOCUMENT_TYPES)[number];

export const ZONE_CHANGE_REQUEST_STATUSES = [
  'PENDIENTE',
  'APROBADA',
  'RECHAZADA',
  'CANCELADA',
] as const;
export type ZoneChangeCancellationCause =
  'SUSPENSION_PERFIL' | 'SUSPENSION_CUENTA' | 'RETIRO_TRABAJADOR';
export type ZoneChangeRequestStatus =
  (typeof ZONE_CHANGE_REQUEST_STATUSES)[number];

export const ORDER_STATUSES = [
  'PUBLICADO',
  'EN_NEGOCIACION',
  'ACORDADO',
  'ANTICIPO_REGISTRADO',
  'VISITA_REALIZADA',
  'PRESUPUESTO_ADICIONAL_PENDIENTE',
  'EN_EJECUCION',
  'TERMINADO',
  'EN_RECLAMO',
  'CERRADO',
  'SIN_ACUERDO',
  'VENCIDO',
  'CANCELADO',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type AuditAction =
  | 'CREACION'
  | 'EDICION'
  | 'DESACTIVACION'
  | 'CAMBIO_ESTADO'
  | 'APROBACION'
  | 'RECHAZO'
  | 'CONSULTA_DOCUMENTOS'
  | 'VISUALIZACION_DOCUMENTO'
  | 'DESCARGA_DOCUMENTO';
export type AuditEntityType =
  | 'CATEGORIA_SERVICIO'
  | 'ZONA'
  | 'PERFIL_TRABAJADOR'
  | 'SOLICITUD_CAMBIO_ZONA'
  | 'RECLAMO'
  | 'USUARIO';

export type ImageVariant = 'full' | 'thumb';

// =====================================================================
// Comunes
// =====================================================================
export interface ApiError {
  statusCode: number;
  message: string | string[];
  error?: string; // ausente en 500
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}
export interface PageQuery {
  page?: number;
  limit?: number; // usuarios, bitacora y solicitudes: <= 100; pedidos y ofertas: <= 50
}

// =====================================================================
// Cuentas (AuthModule, UsersModule)
// =====================================================================
export interface RegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string | null; // '' o solo espacios = sin telefono (se guarda null)
}
// El formulario puede tener confirmPassword, pero NO se envia: el backend
// responde 400 a cualquier propiedad no declarada. Ejemplo:
//   const { confirmPassword, ...body } = form.getRawValue();
//   this.http.post<AuthResponse>('/api/auth/register', body);
export interface LoginRequest {
  email: string;
  password: string;
}
export interface User {
  // PublicUser
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  roles: RoleName[];
  createdAt: string;
  updatedAt: string;
}
export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  user: User;
}
export interface UpdateUserRequest {
  firstName?: string;
  lastName?: string;
  phone?: string | null; // null, '' o solo espacios borran el telefono; omitirlo no lo cambia
}
export interface UpdateUserStatusRequest {
  status: UserStatus;
}

// =====================================================================
// Catalogos y bitacora
// =====================================================================
export interface CatalogOption {
  // publico
  id: string;
  name: string;
  description: string | null;
}
export interface CatalogItem {
  // administracion
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface CatalogRef {
  // embebido
  id: string;
  name: string;
  isActive: boolean;
}
export interface CreateCatalogItemRequest {
  name: string;
  description?: string | null;
}
export interface UpdateCatalogItemRequest {
  name?: string;
  description?: string | null;
}
export interface CatalogAdminQuery {
  isActive?: boolean; // se envia como 'true' | 'false'
}

export interface AuditLog {
  id: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  details: Record<string, unknown> | null; // forma segun la accion (ver 03)
  createdAt: string;
  actor: { id: string; firstName: string; lastName: string; email: string };
}
export interface AuditLogQuery extends PageQuery {
  entityType?: AuditEntityType;
  action?: AuditAction;
  actorId?: string;
  entityId?: string;
  from?: string; // ISO 8601 o YYYY-MM-DD (UTC)
  to?: string;
}

// =====================================================================
// Perfil del trabajador
// =====================================================================
export interface ScheduleItemRequest {
  dayOfWeek: WeekDay;
  startTime: string; // 'HH:mm'
  endTime: string; // 'HH:mm' o '24:00'
  isActive?: boolean | null;
}
export interface CreateWorkerProfileRequest {
  yearsOfExperience: number;
  description?: string | null;
  zoneId: string;
  categoryIds: string[];
  schedules?: ScheduleItemRequest[] | null;
}
export interface UpdateWorkerProfileRequest {
  yearsOfExperience?: number;
  description?: string | null;
  zoneId?: string; // solo en BORRADOR
}
export interface UpdateSpecialtiesRequest {
  categoryIds: string[];
}
export interface UpdateSchedulesRequest {
  schedules: ScheduleItemRequest[];
}
// Solo administradores: GET /worker-profile/admin/profiles y /:profileId
export interface AdminWorkerProfilesQuery extends PageQuery {
  status?: WorkerProfileStatus;
  zoneId?: string;
  categoryId?: string;
}
export interface AdminAccountSummary {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: UserStatus;
}
export interface AdminWorkerProfileSummary {
  id: string;
  userId: string;
  status: WorkerProfileStatus;
  account: AdminAccountSummary;
  zone: CatalogRef;
  specialties: CatalogRef[];
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AdminStatusHistoryEntry extends WorkerStatusHistoryEntry {
  changedByUser: { id: string; firstName: string; lastName: string };
}
export interface AdminWorkerProfileView {
  profile: WorkerProfile;
  account: AdminAccountSummary & { roles: RoleName[] };
  statusReason: string | null;
  history: AdminStatusHistoryEntry[];
  allowedDecisions: WorkerProfileStatus[];
}
// Solo administradores: PATCH /worker-profile/admin/profiles/:profileId/status
export type AdminProfileDecision =
  'APROBADO' | 'OBSERVADO' | 'RECHAZADO' | 'SUSPENDIDO';
export interface ChangeWorkerProfileStatusRequest {
  status: AdminProfileDecision;
  reason?: string; // obligatorio y no vacio salvo APROBADO; no admite null
}
// Solo administradores: PATCH /worker-profile/admin/profiles/:profileId/zone (T4.4).
// Perfil RECHAZADO, OBSERVADO, PENDIENTE o SUSPENDIDO con la zona actual inactiva; conserva
// su estado. Responde AdminWorkerProfileView.
export interface ReassignRejectedProfileZoneRequest {
  zoneId: string;
  justification: string; // obligatoria y no vacia
}

// Notificaciones internas (#61-#64). Se llama AppNotification para no chocar
// con el tipo global Notification del navegador.
export type NotificationType =
  | 'PERFIL_APROBADO'
  | 'PERFIL_OBSERVADO'
  | 'PERFIL_RECHAZADO'
  | 'PERFIL_SUSPENDIDO'
  | 'PERFIL_REACTIVADO'
  | 'VERIFICACION_SOLICITADA'
  | 'VERIFICACION_REENVIADA_OBSERVACION'
  | 'VERIFICACION_REENVIADA_RECHAZO'
  | 'SOLICITUD_ZONA_APROBADA'
  | 'SOLICITUD_ZONA_RECHAZADA'
  | 'SOLICITUD_ZONA_CANCELADA'
  | 'SOLICITUD_ZONA_RETIRADA'
  | 'ZONA_REASIGNADA'
  | 'BORRADO_ARCHIVO_ESCALADO'
  | 'OFERTA_RECIBIDA'
  | 'CONTRAOFERTA_RECIBIDA'
  | 'OFERTA_ACEPTADA'
  | 'OFERTA_RECHAZADA'
  | 'OFERTA_RETIRADA'
  | 'OFERTA_VENCIDA'
  | 'PEDIDO_CANCELADO'
  | 'PEDIDO_VENCIDO'
  | 'VISITA_REGISTRADA'
  | 'TRABAJO_INICIADO'
  | 'PRESUPUESTO_ADICIONAL_PROPUESTO'
  | 'PRESUPUESTO_ADICIONAL_ACEPTADO'
  | 'PRESUPUESTO_ADICIONAL_RECHAZADO'
  | 'TRABAJO_TERMINADO'
  | 'CONFORMIDAD_CONFIRMADA'
  | 'PEDIDO_CERRADO_POR_PLAZO'
  | 'INASISTENCIA_REPORTADA'
  | 'RECLAMO_PRESENTADO'
  | 'RECLAMO_EN_REVISION'
  | 'RECLAMO_RESUELTO'
  | 'PAGO_DECLARADO'
  | 'PAGO_CON_DIFERENCIA'
  | 'CALIFICACION_RECIBIDA';
export type NotificationResourceType =
  | 'PERFIL_TRABAJADOR'
  | 'SOLICITUD_CAMBIO_ZONA'
  | 'PEDIDO'
  | 'OFERTA'
  | 'RECLAMO'
  | 'PAGO';
export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  resourceType: NotificationResourceType | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}
export interface ListNotificationsQuery {
  unread?: boolean;
  page?: number;
  limit?: number; // 1 a 100, por defecto 20
}
export interface UnreadNotificationsCount {
  unread: number;
}
export interface MarkAllNotificationsReadResponse {
  updated: number;
}

export interface Schedule {
  id: string;
  dayOfWeek: WeekDay;
  startTime: string;
  endTime: string;
  isActive: boolean;
}
export interface PendingRequirement {
  field: 'phone' | 'specialties' | 'zone' | 'schedules';
  message: string;
}
export interface WorkerProfile {
  // WorkerProfileView
  id: string;
  userId: string;
  status: WorkerProfileStatus;
  yearsOfExperience: number;
  description: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  zone: CatalogRef;
  zoneRequiresChange: boolean;
  specialties: CatalogRef[];
  schedules: Schedule[];
  pendingRequirements: PendingRequirement[];
  canEdit: boolean;
  canSubmit: boolean;
}
export interface WorkerStatusHistoryEntry {
  id: string;
  fromStatus: WorkerProfileStatus | null;
  toStatus: WorkerProfileStatus;
  reason: string | null;
  createdAt: string;
  changedBy: 'TRABAJADOR' | 'ADMINISTRADOR';
}
export interface WorkerStatus {
  status: WorkerProfileStatus;
  statusReason: string | null;
  history: WorkerStatusHistoryEntry[];
}
export interface WorkerEligibility {
  eligible: boolean;
  status: WorkerProfileStatus | null;
  message: string;
  reason: string | null;
  // T4-F4: solicitud de cambio de zona pendiente y si puede asumir trabajos nuevos.
  pendingZoneChangeRequest: {
    id: string;
    toZone: CatalogRef;
    createdAt: string;
  } | null;
  canTakeNewWork: boolean; // eligible y sin solicitud pendiente (solo trabajo nuevo)
}
export interface WorkerDocument {
  id: string;
  type: WorkerDocumentType;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  replacedAt: string | null;
  replacedById: string | null; // null = vigente
}
// La subida es multipart: campos 'type' y 'file' (ver 06)

// =====================================================================
// Zona y solicitudes de cambio
// =====================================================================
export type ZoneChangeBlockerCode =
  | 'PERFIL_EN_BORRADOR'
  | 'ESTADO_NO_PERMITIDO'
  | 'SOLICITUD_PENDIENTE'
  | 'TRABAJO_ACTIVO'
  | 'VERIFICACION_NO_DISPONIBLE';
export interface ZoneChangeBlocker {
  code: ZoneChangeBlockerCode;
  message: string;
}
export interface ZoneChangeRequest {
  id: string;
  status: ZoneChangeRequestStatus;
  reason: string;
  fromZone: CatalogRef;
  toZone: CatalogRef;
  createdAt: string;
  decidedAt: string | null;
  decisionComment: string | null; // siempre presente en RECHAZADA
  cancellationCause: ZoneChangeCancellationCause | null; // solo en CANCELADA
}
export interface ZoneStatus {
  currentZone: CatalogRef;
  zoneRequiresChange: boolean;
  pendingRequest: ZoneChangeRequest | null;
  canRequestChange: boolean;
  blockers: ZoneChangeBlocker[];
}
export interface CreateZoneChangeRequestRequest {
  toZoneId: string;
  reason: string;
}
export interface AdminZoneChangeRequest extends ZoneChangeRequest {
  worker: {
    userId: string;
    profileId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    accountStatus: UserStatus;
    profileStatus: WorkerProfileStatus;
    currentZone: CatalogRef;
  };
  decidedBy: { id: string; firstName: string; lastName: string } | null;
}
export interface DecideZoneChangeRequestRequest {
  decision: 'APROBADA' | 'RECHAZADA';
  comment?: string | null; // obligatorio y no vacio al rechazar
}
export interface AdminZoneChangeRequestQuery extends PageQuery {
  status?: ZoneChangeRequestStatus;
  resolved?: boolean;
  workerUserId?: string;
}
export interface AffectedProfile {
  profileId: string;
  userId: string;
  status: WorkerProfileStatus;
  zone: { id: string; name: string };
  hasPendingZoneChangeRequest: boolean;
}

// =====================================================================
// Pedidos
// =====================================================================
// POST /orders es multipart: estos son los campos de texto (todos string) mas 'images'
export interface CreateOrderFields {
  categoryId: string;
  zoneId: string;
  description: string;
  budgetAmount: string;
  addressLine: string;
  addressReference?: string;
}
export interface UpdateOrderRequest {
  categoryId?: string; // T5.2: la zona no se edita
  description?: string;
  budgetAmount?: string;
  addressLine?: string;
  addressReference?: string | null;
}
export interface CancelOrderRequest {
  reason?: string | null;
}
export interface DuplicateCheckRequest {
  categoryId: string;
  zoneId: string;
  description: string;
}
export interface OwnOrdersQuery extends PageQuery {
  status?: OrderStatus;
}
export interface AvailableOrdersQuery extends PageQuery {
  categoryId?: string;
}

export interface OrderImage {
  id: string;
  position: number;
  width: number;
  height: number;
  sizeBytes: number;
  thumbnailSizeBytes: number;
}
export interface WorkerOrder {
  // WorkerOrderView (trabajador aprobado)
  id: string;
  status: OrderStatus; // estado efectivo
  category: CatalogRef;
  zone: CatalogRef;
  description: string;
  budgetAmount: string;
  images: OrderImage[];
  revision: number;
  publishedAt: string;
  expiresAt: string;
  lastEditedAt: string | null;
}
export interface OwnerOrder extends WorkerOrder {
  // OwnerOrderView (cliente duenio)
  address: { addressLine: string; reference: string | null } | null;
  cancelledAt: string | null;
  anonymizedAt: string | null; // T5.4: sin direccion ni fotos; descripcion fija
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canCancel: boolean;
}
// Solo administradores (T5.4): registro minimo, sin direccion, fotos ni descripcion.
export interface AdminOrderSummary {
  id: string;
  status: OrderStatus;
  category: CatalogRef;
  zone: CatalogRef;
  budgetAmount: string;
  revision: number;
  publishedAt: string;
  expiresAt: string;
  lastEditedAt: string | null;
  cancelledAt: string | null;
  anonymizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  clientId: string;
  client: { id: string; firstName: string; lastName: string } | null; // null si anonimizado
  assignedWorkerId: string | null;
  imageCount: number;
}
export interface AdminOrderView extends AdminOrderSummary {
  history: {
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    actorType: 'USUARIO' | 'SISTEMA';
    changedById: string | null;
    actorRole: RoleName | null;
    systemProcess: string | null;
    reason: string | null; // null si anonimizado
    createdAt: string;
  }[];
}
export type OrderWarning =
  | { code: 'POSIBLE_DUPLICADO'; message: string; orderIds: string[] }
  | { code: 'POSIBLE_DATO_PERSONAL'; message: string };
export interface OrderWithWarnings {
  order: OwnerOrder;
  warnings: OrderWarning[];
}
export interface DuplicateCheckResponse {
  warnings: OrderWarning[];
}

// Pedido acordado para el trabajador asignado (#80, G2).
export interface AssignedOrder extends WorkerOrder {
  address: { addressLine: string; reference: string | null } | null;
  client: { firstName: string; lastName: string };
}

// ---------------------------------------------------------------- Ofertas
export const OFFER_STATUSES = [
  'VIGENTE',
  'ACEPTADA',
  'RECHAZADA',
  'RETIRADA',
  'VENCIDA',
  'SIN_EFECTO',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export type OfferParty = 'CLIENTE' | 'TRABAJADOR';
export type OfferEventType =
  | 'PROPUESTA'
  | 'CONTRAOFERTA'
  | 'ACEPTADA'
  | 'RECHAZADA'
  | 'RETIRADA'
  | 'VENCIDA'
  | 'SIN_EFECTO';

export interface CreateOfferRequest {
  amount: string;
  requiresVisit: boolean;
  visitCost?: string; // obligatorio si requiresVisit; prohibido si no
  materialsIncluded: boolean;
  proposedStartAt: string; // ISO 8601 con zona horaria (ej. '2026-11-30T10:00:00-04:00')
  estimatedDurationMinutes: number;
}
export interface CounterOfferRequest {
  amount: string;
}
export interface ListOffersQuery {
  status?: OfferStatus;
  page?: number;
  limit?: number;
}
export interface ListReceivedOffersQuery extends ListOffersQuery {
  orderId?: string;
}

export interface Offer {
  id: string;
  orderId: string;
  status: OfferStatus; // estado efectivo
  round: number;
  amount: string;
  turn: OfferParty;
  requiresVisit: boolean;
  visitCost: string | null;
  materialsIncluded: boolean;
  proposedStartAt: string;
  estimatedDurationMinutes: number;
  expiresAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ReceivedOffer extends Offer {
  worker: { id: string; firstName: string; lastName: string };
}
export interface OfferEvent {
  type: OfferEventType;
  round: number;
  amount: string | null;
  actorType: 'USUARIO' | 'SISTEMA';
  actorRole: RoleName | null; // sin id de usuario (G4)
  systemProcess: string | null;
  reason: string | null;
  createdAt: string;
}
export type OfferDetail<T extends Offer = Offer> = T & {
  history: OfferEvent[];
};

export type WhatsAppContact =
  | {
      available: true;
      channel: 'WHATSAPP';
      contactRole: OfferParty;
      url: string;
    }
  | {
      available: false;
      channel: 'WHATSAPP';
      contactRole: OfferParty;
      url: null;
      reason: 'TELEFONO_NO_REGISTRADO' | 'TELEFONO_INVALIDO';
    };
```

## Tabla de correspondencia (backend → Angular)

| Backend                                                                                                                                     | Tipo propuesto                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `PublicUser`                                                                                                                                | `User`                                                           |
| `RegisterDto`, `LoginDto`                                                                                                                   | `RegisterRequest`, `LoginRequest`                                |
| `UpdateUserDto`, `UpdateUserStatusDto`                                                                                                      | `UpdateUserRequest`, `UpdateUserStatusRequest`                   |
| `CatalogOption`, `CatalogItem`, `CatalogRef`                                                                                                | Mismos nombres                                                   |
| `CreateCatalogItemDto`, `UpdateCatalogItemDto`                                                                                              | `CreateCatalogItemRequest`, `UpdateCatalogItemRequest`           |
| `AuditLogView`                                                                                                                              | `AuditLog`                                                       |
| `WorkerProfileView`, `ScheduleView`                                                                                                         | `WorkerProfile`, `Schedule`                                      |
| `WorkerStatusView`, `StatusHistoryEntry`                                                                                                    | `WorkerStatus`, `WorkerStatusHistoryEntry`                       |
| `WorkerDocumentView`                                                                                                                        | `WorkerDocument`                                                 |
| `ZoneStatusView`, `ZoneChangeRequestView`, `AdminZoneChangeRequestView`                                                                     | `ZoneStatus`, `ZoneChangeRequest`, `AdminZoneChangeRequest`      |
| `WorkerOrderView`, `OwnerOrderView`, `OrderImageView`                                                                                       | `WorkerOrder`, `OwnerOrder`, `OrderImage`                        |
| `AssignedOrderView`                                                                                                                         | `AssignedOrder`                                                  |
| `NotificationView`                                                                                                                          | `AppNotification` (evita el `Notification` global del navegador) |
| `CreateOfferDto`, `CounterOfferDto`                                                                                                         | `CreateOfferRequest`, `CounterOfferRequest`                      |
| `ListOffersQueryDto`, `ListReceivedOffersQueryDto`                                                                                          | `ListOffersQuery`, `ListReceivedOffersQuery`                     |
| `OfferView`, `ReceivedOfferView`, `OfferEventView`, `OfferDetail<T>`                                                                        | `Offer`, `ReceivedOffer`, `OfferEvent`, `OfferDetail<T>`         |
| `WhatsAppContact`                                                                                                                           | Mismo nombre                                                     |
| `PaginatedOrders<T>`, `PaginatedOffers<T>`, `PaginatedUsers`, `PaginatedAuditLogs`, `PaginatedZoneChangeRequests`, `PaginatedNotifications` | `PaginatedResponse<T>` (misma forma)                             |

## Tipos que no deben crearse todavía

`Negotiation` (la negociación vive en `Offer` y su `history`) y `Schedule` de agenda como reserva (la agenda se arma con `AgendaView`, ver 10). Los modelos de #82–#112 sí tienen contrato: tómelos de [10](10-sprint1-endpoints.md).
