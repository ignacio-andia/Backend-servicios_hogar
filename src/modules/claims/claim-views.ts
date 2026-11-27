import type {
  ClaimPriority,
  ClaimStatus,
} from '../../generated/prisma/client.js';

// Vistas HTTP de reclamos. Las fotos se identifican por id: nunca se exponen
// claves de almacenamiento ni rutas.

export interface ClaimImageView {
  id: string;
  position: number;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/** Administrador que puede ser responsable de un reclamo (RN-3). */
export interface ClaimAssigneeView {
  id: string;
  firstName: string;
  lastName: string;
}

/** Vista del cliente que presento el reclamo y del administrador. */
export interface ClaimView {
  id: string;
  orderId: string;
  status: ClaimStatus;
  description: string;
  images: ClaimImageView[];
  decision: string | null;
  justification: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  // Priorizacion (RN-1 a RN-6)
  priority: ClaimPriority;
  dueAt: Date;
  assignedAt: Date | null;
  assignee: ClaimAssigneeView | null;
  /** Calculado con el reloj de la BD: pendiente y con la fecha limite pasada. */
  overdue: boolean;
}

/**
 * Vista del trabajador del pedido: solo el estado y la decision comunicada.
 * No incluye la priorizacion: es gestion interna del administrador.
 */
export interface ClaimPartyView {
  id: string;
  orderId: string;
  status: ClaimStatus;
  decision: string | null;
  justification: string | null;
  decidedAt: Date | null;
}

export interface ClaimSummary {
  id: string;
  orderId: string;
  status: ClaimStatus;
  imageCount: number;
  createdAt: Date;
  // Priorizacion (RN-1 a RN-6)
  priority: ClaimPriority;
  dueAt: Date;
  assignedAt: Date | null;
  assignee: ClaimAssigneeView | null;
  overdue: boolean;
}

export interface PaginatedClaims {
  data: ClaimSummary[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}