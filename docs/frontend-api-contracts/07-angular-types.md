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
- Los tipos que **no existen** en el backend (ofertas, pagos, agenda, reclamos, calificaciones) **no** se incluyen.

```ts
// =====================================================================
// Enumeraciones (valores exactos del backend)
// =====================================================================
export const ROLE_NAMES = ['CLIENTE', 'TRABAJADOR', 'ADMINISTRADOR'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const USER_STATUSES = ['ACTIVO', 'INACTIVO', 'SUSPENDIDO'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const WORKER_PROFILE_STATUSES = [
  'BORRADOR', 'PENDIENTE', 'OBSERVADO', 'APROBADO', 'RECHAZADO', 'SUSPENDIDO',
] as const;
export type WorkerProfileStatus = (typeof WORKER_PROFILE_STATUSES)[number];

export const WEEK_DAYS = [
  'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO',
] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export const WORKER_DOCUMENT_TYPES = ['IDENTIDAD', 'ANTECEDENTES', 'CERTIFICADO', 'REFERENCIA'] as const;
export type WorkerDocumentType = (typeof WORKER_DOCUMENT_TYPES)[number];

export const ZONE_CHANGE_REQUEST_STATUSES = ['PENDIENTE', 'APROBADA', 'RECHAZADA'] as const;
export type ZoneChangeRequestStatus = (typeof ZONE_CHANGE_REQUEST_STATUSES)[number];

export const ORDER_STATUSES = [
  'PUBLICADO', 'EN_NEGOCIACION', 'ACORDADO', 'ANTICIPO_REGISTRADO', 'VISITA_REALIZADA',
  'PRESUPUESTO_ADICIONAL_PENDIENTE', 'EN_EJECUCION', 'TERMINADO', 'EN_RECLAMO', 'CERRADO',
  'SIN_ACUERDO', 'VENCIDO', 'CANCELADO',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type AuditAction =
  | 'CREACION' | 'EDICION' | 'DESACTIVACION' | 'CAMBIO_ESTADO' | 'APROBACION' | 'RECHAZO';
export type AuditEntityType =
  | 'CATEGORIA_SERVICIO' | 'ZONA' | 'PERFIL_TRABAJADOR' | 'SOLICITUD_CAMBIO_ZONA';

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
  limit?: number; // usuarios, bitacora y solicitudes: <= 100; pedidos: <= 50
}

// =====================================================================
// Cuentas (AuthModule, UsersModule)
// =====================================================================
export interface RegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string | null;
}
export interface LoginRequest {
  email: string;
  password: string;
}
export interface User {           // PublicUser
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
  phone?: string | null; // null borra el telefono
}
export interface UpdateUserStatusRequest {
  status: UserStatus;
}

// =====================================================================
// Catalogos y bitacora
// =====================================================================
export interface CatalogOption {   // publico
  id: string;
  name: string;
  description: string | null;
}
export interface CatalogItem {     // administracion
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface CatalogRef {      // embebido
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
  endTime: string;   // 'HH:mm' o '24:00'
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
export interface WorkerProfile {    // WorkerProfileView
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
  | 'PERFIL_EN_BORRADOR' | 'ESTADO_NO_PERMITIDO' | 'SOLICITUD_PENDIENTE'
  | 'TRABAJO_ACTIVO' | 'VERIFICACION_NO_DISPONIBLE';
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
  decisionComment: string | null;
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
  comment?: string | null;
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
export interface WorkerOrder {     // WorkerOrderView (trabajador aprobado)
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
export interface OwnerOrder extends WorkerOrder { // OwnerOrderView (cliente duenio)
  address: { addressLine: string; reference: string | null } | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canCancel: boolean;
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
```

## Tabla de correspondencia (backend → Angular)

| Backend | Tipo propuesto |
|---|---|
| `PublicUser` | `User` |
| `RegisterDto`, `LoginDto` | `RegisterRequest`, `LoginRequest` |
| `UpdateUserDto`, `UpdateUserStatusDto` | `UpdateUserRequest`, `UpdateUserStatusRequest` |
| `CatalogOption`, `CatalogItem`, `CatalogRef` | Mismos nombres |
| `CreateCatalogItemDto`, `UpdateCatalogItemDto` | `CreateCatalogItemRequest`, `UpdateCatalogItemRequest` |
| `AuditLogView` | `AuditLog` |
| `WorkerProfileView`, `ScheduleView` | `WorkerProfile`, `Schedule` |
| `WorkerStatusView`, `StatusHistoryEntry` | `WorkerStatus`, `WorkerStatusHistoryEntry` |
| `WorkerDocumentView` | `WorkerDocument` |
| `ZoneStatusView`, `ZoneChangeRequestView`, `AdminZoneChangeRequestView` | `ZoneStatus`, `ZoneChangeRequest`, `AdminZoneChangeRequest` |
| `WorkerOrderView`, `OwnerOrderView`, `OrderImageView` | `WorkerOrder`, `OwnerOrder`, `OrderImage` |
| `PaginatedOrders<T>`, `PaginatedUsers`, `PaginatedAuditLogs`, `PaginatedZoneChangeRequests` | `PaginatedResponse<T>` (misma forma) |

## Tipos que no deben crearse todavía

`Offer`, `Negotiation`, `Visit`, `AdditionalBudget`, `Schedule` de agenda (no confundir con el horario de atención), `Claim`, `Payment`, `Receipt`, `Rating`, `Notification`, `PublicWorkerProfile`, `OrderTimeline`/historial de pedido, `AdminOrder`. **No tienen contrato** (ver 09).
