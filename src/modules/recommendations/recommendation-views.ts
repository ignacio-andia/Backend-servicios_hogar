import { Prisma } from '../../generated/prisma/client.js';
import {
  AVAILABILITY_WINDOW_DAYS,
  NEUTRAL_RATING,
  contribution,
} from './recommendation-scoring.js';

/** Version de los criterios, tal como se guardo. */
export interface RecommendationSettingsView {
  id: string;
  version: number;
  reputationWeight: number;
  completedServicesWeight: number;
  availabilityWeight: number;
  reviewsForConfidence: number;
  completedServicesTarget: number;
  availabilityHoursTarget: number;
  /** Constantes del calculo, para mostrar como se obtiene cada puntaje. */
  neutralRating: number;
  availabilityWindowDays: number;
  createdAt: Date;
  /** null en la version inicial (la creo la migracion). */
  createdBy: { id: string; firstName: string; lastName: string } | null;
}

export interface CriterionView {
  /** Puntaje del criterio, de 0 a 100, con 2 decimales. */
  score: string;
  /** Peso del criterio (porcentaje entero). */
  weight: number;
  /** Puntos que aporta al total: puntaje x peso / 100. */
  points: string;
  /** Como se obtuvo el puntaje, en una frase. */
  explanation: string;
}

export interface RecommendedWorkerView {
  rank: number;
  workerId: string;
  firstName: string;
  lastName: string;
  totalScore: string;
  reputation: CriterionView & {
    reviewsCount: number;
    averageRating: string | null;
    adjustedRating: string;
  };
  completedServices: CriterionView & { count: number; target: number };
  availability: CriterionView & {
    weeklyScheduleHours: string;
    bookedHours: string;
    freeHours: string;
    targetHours: number;
  };
  /** Oferta VIGENTE del trabajador en el pedido al generar la recomendacion. */
  openOfferId: string | null;
}

export interface RecommendationView {
  id: string;
  orderId: string;
  createdAt: Date;
  /** Trabajadores que cumplian los filtros; se muestran los mejores. */
  candidatesCount: number;
  criteria: RecommendationSettingsView;
  workers: RecommendedWorkerView[];
  message: string | null;
}

export interface RecommendationSettingsOverview {
  current: RecommendationSettingsView;
  /** Todas las versiones, de la mas reciente a la mas antigua. */
  history: RecommendationSettingsView[];
}

export const NO_CANDIDATES_MESSAGE =
  'Por ahora no hay trabajadores aprobados de esta categoría y zona para recomendar.';

export const SETTINGS_SELECT = {
  id: true,
  version: true,
  reputationWeight: true,
  completedServicesWeight: true,
  availabilityWeight: true,
  reviewsForConfidence: true,
  completedServicesTarget: true,
  availabilityHoursTarget: true,
  createdAt: true,
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.RecommendationSettingsSelect;

export type SettingsRecord = Prisma.RecommendationSettingsGetPayload<{
  select: typeof SETTINGS_SELECT;
}>;

export const RECOMMENDATION_SELECT = {
  id: true,
  orderId: true,
  createdAt: true,
  candidatesCount: true,
  settings: { select: SETTINGS_SELECT },
  items: {
    orderBy: { rank: 'asc' },
    select: {
      rank: true,
      workerId: true,
      totalScore: true,
      reviewsCount: true,
      averageRating: true,
      adjustedRating: true,
      reputationScore: true,
      completedServices: true,
      completedServicesScore: true,
      weeklyScheduleMinutes: true,
      bookedMinutes: true,
      freeMinutes: true,
      availabilityScore: true,
      openOfferId: true,
      worker: { select: { firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.WorkerRecommendationSelect;

type RecommendationRecord = Prisma.WorkerRecommendationGetPayload<{
  select: typeof RECOMMENDATION_SELECT;
}>;
type ItemRecord = RecommendationRecord['items'][number];

export function toSettingsView(
  settings: SettingsRecord,
): RecommendationSettingsView {
  return {
    id: settings.id,
    version: settings.version,
    reputationWeight: settings.reputationWeight,
    completedServicesWeight: settings.completedServicesWeight,
    availabilityWeight: settings.availabilityWeight,
    reviewsForConfidence: settings.reviewsForConfidence,
    completedServicesTarget: settings.completedServicesTarget,
    availabilityHoursTarget: settings.availabilityHoursTarget,
    neutralRating: NEUTRAL_RATING,
    availabilityWindowDays: AVAILABILITY_WINDOW_DAYS,
    createdAt: settings.createdAt,
    createdBy: settings.createdBy,
  };
}

export function toRecommendationView(
  record: RecommendationRecord,
): RecommendationView {
  const criteria = toSettingsView(record.settings);
  return {
    id: record.id,
    orderId: record.orderId,
    createdAt: record.createdAt,
    candidatesCount: record.candidatesCount,
    criteria,
    workers: record.items.map((item) => toWorkerView(item, criteria)),
    message: record.items.length === 0 ? NO_CANDIDATES_MESSAGE : null,
  };
}

function toWorkerView(
  item: ItemRecord,
  criteria: RecommendationSettingsView,
): RecommendedWorkerView {
  const reputationScore = item.reputationScore.toNumber();
  const servicesScore = item.completedServicesScore.toNumber();
  const availabilityScore = item.availabilityScore.toNumber();
  const averageRating = item.averageRating?.toFixed(2) ?? null;
  const adjustedRating = item.adjustedRating.toFixed(2);
  return {
    rank: item.rank,
    workerId: item.workerId,
    firstName: item.worker.firstName,
    lastName: item.worker.lastName,
    totalScore: item.totalScore.toFixed(2),
    reputation: {
      reviewsCount: item.reviewsCount,
      averageRating,
      adjustedRating,
      score: item.reputationScore.toFixed(2),
      weight: criteria.reputationWeight,
      points: contribution(reputationScore, criteria.reputationWeight).toFixed(
        2,
      ),
      explanation:
        averageRating === null
          ? `Sin calificaciones todavía: se usa la calificación neutra de ${NEUTRAL_RATING} estrellas.`
          : `Promedio de ${averageRating} con ${plural(item.reviewsCount, 'calificación', 'calificaciones')}; ajustado a ${adjustedRating} al sumar ${plural(criteria.reviewsForConfidence, 'calificación neutra', 'calificaciones neutras')} de ${NEUTRAL_RATING} estrellas.`,
    },
    completedServices: {
      count: item.completedServices,
      target: criteria.completedServicesTarget,
      score: item.completedServicesScore.toFixed(2),
      weight: criteria.completedServicesWeight,
      points: contribution(
        servicesScore,
        criteria.completedServicesWeight,
      ).toFixed(2),
      explanation: `${plural(item.completedServices, 'servicio completado', 'servicios completados')}; con ${criteria.completedServicesTarget} o más el criterio llega al 100 %.`,
    },
    availability: {
      weeklyScheduleHours: hours(item.weeklyScheduleMinutes),
      bookedHours: hours(item.bookedMinutes),
      freeHours: hours(item.freeMinutes),
      targetHours: criteria.availabilityHoursTarget,
      score: item.availabilityScore.toFixed(2),
      weight: criteria.availabilityWeight,
      points: contribution(
        availabilityScore,
        criteria.availabilityWeight,
      ).toFixed(2),
      explanation:
        item.weeklyScheduleMinutes === 0
          ? 'No registró horario de atención: no tiene horas libres.'
          : `Atiende ${hours(item.weeklyScheduleMinutes)} h por semana y tiene ${hours(item.bookedMinutes)} h de trabajos acordados en los próximos ${AVAILABILITY_WINDOW_DAYS} días: ${hours(item.freeMinutes)} h libres (con ${criteria.availabilityHoursTarget} h llega al 100 %).`,
    },
    openOfferId: item.openOfferId,
  };
}

/** Minutos a horas con hasta 2 decimales: 90 -> "1.5", 120 -> "2". */
export function hours(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
