import type { ClaimStatus } from '../../generated/prisma/client.js';

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
}

/** Vista del trabajador del pedido: solo el estado y la decision comunicada. */
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
}

export interface PaginatedClaims {
  data: ClaimSummary[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}
