import type { RoleName } from '../../generated/prisma/enums.js';
import type { PublicWorkerProfile } from '../worker-profile/worker-profile.service.js';
import type { RatingSummary } from './review-rules.js';

// Vistas HTTP de calificaciones. Las publicas nunca incluyen ids de usuario o
// de pedido, correo ni telefono: solo el nombre y la inicial del apellido.

export interface ReviewView {
  id: string;
  orderId: string;
  authorRole: RoleName;
  rating: number;
  comment: string | null;
  createdAt: Date;
  /** Oculta por un administrador (RF-46 A1); no cuenta en el promedio. */
  hidden: boolean;
}

/** Opinion visible en el perfil del trabajador. */
export interface PublicOpinionView {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  /** Por ejemplo "María P.". */
  author: string;
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface PublicWorkerProfileView {
  profile: PublicWorkerProfile;
  rating: RatingSummary & {
    /** Mensaje cuando aun no hay calificaciones (RF-46 criterio 2). */
    message: string | null;
  };
  /** Las opiniones mas recientes; el resto se pide paginado. */
  recentOpinions: PublicOpinionView[];
}

export interface MyReviewStatus {
  orderId: string;
  /** El usuario puede calificar este pedido ahora. */
  canReview: boolean;
  /** Motivo cuando no puede; null si puede o ya califico. */
  reason: string | null;
  alreadyReviewed: boolean;
  review: ReviewView | null;
}

export interface AdminReviewView extends ReviewView {
  authorId: string;
  targetId: string;
  hiddenAt: Date | null;
  hiddenById: string | null;
}

export function authorLabel(firstName: string, lastName: string): string {
  const initial = lastName.trim().charAt(0).toUpperCase();
  return initial ? `${firstName.trim()} ${initial}.` : firstName.trim();
}
