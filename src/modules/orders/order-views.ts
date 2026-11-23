import { OrderStatus } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CatalogItem } from '../catalogs/catalogs.service.js';
import {
  ORDER_CANCELLABLE_STATUSES,
  ORDER_EDITABLE_STATUSES,
  ORDER_EXPIRABLE_STATUSES,
} from './orders.rules.js';

// Campos comunes del pedido. La direccion exacta y el cliente NO estan aqui:
// solo la vista del dueno agrega la direccion (OWNER_ORDER_SELECT).
export const ORDER_PUBLIC_SELECT = {
  id: true,
  categoryId: true,
  zoneId: true,
  description: true,
  budgetAmount: true,
  status: true,
  revision: true,
  publishedAt: true,
  expiresAt: true,
  lastEditedAt: true,
  images: {
    select: {
      id: true,
      position: true,
      width: true,
      height: true,
      sizeBytes: true,
      thumbnailSizeBytes: true,
    },
    orderBy: { position: 'asc' },
  },
} satisfies Prisma.OrderSelect;

export const OWNER_ORDER_SELECT = {
  ...ORDER_PUBLIC_SELECT,
  clientId: true,
  cancelledAt: true,
  anonymizedAt: true,
  createdAt: true,
  updatedAt: true,
  address: { select: { addressLine: true, reference: true } },
} satisfies Prisma.OrderSelect;

/**
 * Registro minimo para administradores (T5.4): nunca la direccion, las
 * fotos ni la descripcion. El nombre del cliente solo si el pedido no fue
 * anonimizado.
 */
export const ADMIN_ORDER_SELECT = {
  id: true,
  categoryId: true,
  zoneId: true,
  budgetAmount: true,
  status: true,
  revision: true,
  publishedAt: true,
  expiresAt: true,
  lastEditedAt: true,
  cancelledAt: true,
  anonymizedAt: true,
  createdAt: true,
  updatedAt: true,
  clientId: true,
  assignedWorkerId: true,
  client: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { images: true } },
} satisfies Prisma.OrderSelect;

export type AdminOrderRecord = Prisma.OrderGetPayload<{
  select: typeof ADMIN_ORDER_SELECT;
}>;

export type PublicOrderRecord = Prisma.OrderGetPayload<{
  select: typeof ORDER_PUBLIC_SELECT;
}>;
export type OwnerOrderRecord = Prisma.OrderGetPayload<{
  select: typeof OWNER_ORDER_SELECT;
}>;

export interface CatalogRef {
  id: string;
  name: string;
  isActive: boolean;
}

export interface OrderImageView {
  id: string;
  position: number;
  width: number;
  height: number;
  sizeBytes: number;
  thumbnailSizeBytes: number;
}

/** Lo que ve un trabajador habilitado (CU-17): sin direccion ni datos del cliente. */
export interface WorkerOrderView {
  id: string;
  status: OrderStatus;
  category: CatalogRef;
  zone: CatalogRef;
  description: string;
  /** Monto en bolivianos, como texto con 2 decimales (Decimal, sin flotantes). */
  budgetAmount: string;
  images: OrderImageView[];
  revision: number;
  publishedAt: Date;
  expiresAt: Date;
  lastEditedAt: Date | null;
}

/** Lo que ve el cliente dueno del pedido. */
export interface OwnerOrderView extends WorkerOrderView {
  address: { addressLine: string; reference: string | null } | null;
  cancelledAt: Date | null;
  /** T5.4: cuando se anonimizo (sin direccion, fotos ni descripcion). */
  anonymizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  canEdit: boolean;
  canCancel: boolean;
}

/** Registro minimo de un pedido para administradores (T5.4). */
export interface AdminOrderSummary {
  id: string;
  status: OrderStatus;
  category: CatalogRef;
  zone: CatalogRef;
  budgetAmount: string;
  revision: number;
  publishedAt: Date;
  expiresAt: Date;
  lastEditedAt: Date | null;
  cancelledAt: Date | null;
  anonymizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  clientId: string;
  /** Null si el pedido fue anonimizado. */
  client: { id: string; firstName: string; lastName: string } | null;
  assignedWorkerId: string | null;
  imageCount: number;
}

export interface AdminOrderHistoryEntry {
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: 'USUARIO' | 'SISTEMA';
  changedById: string | null;
  actorRole: string | null;
  systemProcess: string | null;
  /** Null si el pedido fue anonimizado (texto libre del usuario). */
  reason: string | null;
  createdAt: Date;
}

export interface AdminOrderView extends AdminOrderSummary {
  history: AdminOrderHistoryEntry[];
}

export type OrderWarningCode = 'POSIBLE_DUPLICADO' | 'POSIBLE_DATO_PERSONAL';

/** Advertencia orientativa: nunca bloquea la operacion. */
export interface OrderWarning {
  code: OrderWarningCode;
  message: string;
  orderIds?: string[];
}

export interface OrderWithWarnings {
  order: OwnerOrderView;
  warnings: OrderWarning[];
}

export interface PaginatedOrders<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Un pedido PUBLICADO cuyo plazo ya paso esta vencido aunque la tarea
 * periodica todavia no lo haya registrado.
 */
export function effectiveStatus(
  order: { status: OrderStatus; expiresAt: Date },
  now: Date,
): OrderStatus {
  return ORDER_EXPIRABLE_STATUSES.includes(order.status) &&
    order.expiresAt.getTime() <= now.getTime()
    ? OrderStatus.VENCIDO
    : order.status;
}

export function toRef({ id, name, isActive }: CatalogItem): CatalogRef {
  return { id, name, isActive };
}

export function toWorkerView(
  order: PublicOrderRecord,
  refs: { categories: Map<string, CatalogRef>; zones: Map<string, CatalogRef> },
  now: Date,
): WorkerOrderView {
  return {
    id: order.id,
    status: effectiveStatus(order, now),
    category: refs.categories.get(order.categoryId)!,
    zone: refs.zones.get(order.zoneId)!,
    description: order.description,
    budgetAmount: order.budgetAmount.toFixed(2),
    images: order.images,
    revision: order.revision,
    publishedAt: order.publishedAt,
    expiresAt: order.expiresAt,
    lastEditedAt: order.lastEditedAt,
  };
}

export function toOwnerView(
  order: OwnerOrderRecord,
  refs: { categories: Map<string, CatalogRef>; zones: Map<string, CatalogRef> },
  now: Date,
): OwnerOrderView {
  const base = toWorkerView(order, refs, now);
  return {
    ...base,
    address: order.address,
    cancelledAt: order.cancelledAt,
    anonymizedAt: order.anonymizedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    canEdit: ORDER_EDITABLE_STATUSES.includes(base.status),
    canCancel: ORDER_CANCELLABLE_STATUSES.includes(base.status),
  };
}

export function toAdminSummary(
  order: AdminOrderRecord,
  refs: { categories: Map<string, CatalogRef>; zones: Map<string, CatalogRef> },
  now: Date,
): AdminOrderSummary {
  return {
    id: order.id,
    status: effectiveStatus(order, now),
    category: refs.categories.get(order.categoryId)!,
    zone: refs.zones.get(order.zoneId)!,
    budgetAmount: order.budgetAmount.toFixed(2),
    revision: order.revision,
    publishedAt: order.publishedAt,
    expiresAt: order.expiresAt,
    lastEditedAt: order.lastEditedAt,
    cancelledAt: order.cancelledAt,
    anonymizedAt: order.anonymizedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    clientId: order.clientId,
    client: order.anonymizedAt ? null : order.client,
    assignedWorkerId: order.assignedWorkerId,
    imageCount: order._count.images,
  };
}
