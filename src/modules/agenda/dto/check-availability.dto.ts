import { IsInt, IsISO8601, Matches, Max, Min } from 'class-validator';
import {
  OFFER_DATETIME_WITH_ZONE_MESSAGE,
  OFFER_DATETIME_WITH_ZONE_PATTERN,
} from '../../offers/offers.rules.js';

/** Tope de la consulta: un trabajo de hasta 30 dias. */
export const AGENDA_MAX_DURATION_MINUTES = 30 * 24 * 60;

/**
 * Consulta de disponibilidad (RF-30, RF-31): el rango ocupado es
 * [startAt, startAt + durationMinutes). Misma forma de fecha que una oferta:
 * ISO 8601 con zona horaria explicita.
 */
export class CheckAvailabilityDto {
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(OFFER_DATETIME_WITH_ZONE_PATTERN, {
    message: OFFER_DATETIME_WITH_ZONE_MESSAGE,
  })
  startAt: string;

  @IsInt()
  @Min(1)
  @Max(AGENDA_MAX_DURATION_MINUTES)
  durationMinutes: number;
}
