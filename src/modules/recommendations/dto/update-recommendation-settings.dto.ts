import { IsInt, Max, Min } from 'class-validator';

const INTEGER = { message: '$property debe ser un número entero' };
const range = (min: number, max: number) => ({
  message: `$property debe estar entre ${min} y ${max}`,
});

/**
 * Nueva version de los criterios de recomendacion. Que los tres pesos sumen
 * exactamente 100 lo valida RecommendationsService (400) y lo respalda el
 * CHECK recommendation_settings_weights_check de la BD.
 */
export class UpdateRecommendationSettingsDto {
  @IsInt(INTEGER)
  @Min(0, range(0, 100))
  @Max(100, range(0, 100))
  reputationWeight: number;

  @IsInt(INTEGER)
  @Min(0, range(0, 100))
  @Max(100, range(0, 100))
  completedServicesWeight: number;

  @IsInt(INTEGER)
  @Min(0, range(0, 100))
  @Max(100, range(0, 100))
  availabilityWeight: number;

  /** Calificaciones neutras (3 estrellas) que se suman al promedio. */
  @IsInt(INTEGER)
  @Min(0, range(0, 50))
  @Max(50, range(0, 50))
  reviewsForConfidence: number;

  /** Servicios completados con los que el criterio llega al 100 %. */
  @IsInt(INTEGER)
  @Min(1, range(1, 1000))
  @Max(1000, range(1, 1000))
  completedServicesTarget: number;

  /** Horas libres en 7 dias con las que el criterio llega al 100 % (una semana tiene 168). */
  @IsInt(INTEGER)
  @Min(1, range(1, 168))
  @Max(168, range(1, 168))
  availabilityHoursTarget: number;
}
