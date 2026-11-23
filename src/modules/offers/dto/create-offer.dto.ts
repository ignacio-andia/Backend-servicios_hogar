import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  OFFER_AMOUNT_MESSAGE,
  OFFER_AMOUNT_PATTERN,
  OFFER_DATETIME_WITH_ZONE_MESSAGE,
  OFFER_DATETIME_WITH_ZONE_PATTERN,
  OFFER_MAX_DURATION_MINUTES,
  OFFER_VISIT_COST_MESSAGE,
  OFFER_VISIT_COST_PATTERN,
} from '../offers.rules.js';

// Los montos se reciben como texto (Decimal sin flotantes); un numero JSON
// tambien se acepta y se convierte.
const toAmountString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' ? String(value) : value;

/**
 * Oferta de un trabajador (RF-19, RF-22, RF-24, RF-31). La coherencia entre
 * requiresVisit y visitCost se valida en OffersService (400) y la refuerza el
 * CHECK offers_visit_cost_check de la BD.
 */
export class CreateOfferDto {
  @Transform(toAmountString)
  @IsString()
  @Matches(OFFER_AMOUNT_PATTERN, { message: OFFER_AMOUNT_MESSAGE })
  amount: string;

  /** RF-24: true = "Requiere visita"; false = "Cotizacion por fotos". */
  @IsBoolean()
  requiresVisit: boolean;

  /** Solo si requiresVisit; "0" es una visita gratis. */
  @IsOptional()
  @Transform(toAmountString)
  @IsString()
  @Matches(OFFER_VISIT_COST_PATTERN, { message: OFFER_VISIT_COST_MESSAGE })
  visitCost?: string;

  @IsBoolean()
  materialsIncluded: boolean;

  /**
   * RF-31: fecha y hora de inicio propuestas, ISO 8601 con zona horaria
   * explicita (G1): "2026-11-30T10:00:00-04:00" o "2026-11-30T14:00:00Z".
   */
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(OFFER_DATETIME_WITH_ZONE_PATTERN, {
    message: OFFER_DATETIME_WITH_ZONE_MESSAGE,
  })
  proposedStartAt: string;

  @IsInt()
  @Min(1)
  @Max(OFFER_MAX_DURATION_MINUTES)
  estimatedDurationMinutes: number;
}
