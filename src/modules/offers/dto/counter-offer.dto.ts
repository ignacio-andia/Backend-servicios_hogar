import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { OFFER_AMOUNT_MESSAGE, OFFER_AMOUNT_PATTERN } from '../offers.rules.js';

/**
 * Contraoferta (RF-20): solo el nuevo monto. Visita, materiales, horario y
 * duracion son los de la oferta original y no cambian (trigger offers_guard).
 */
export class CounterOfferDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' ? String(value) : value,
  )
  @IsString()
  @Matches(OFFER_AMOUNT_PATTERN, { message: OFFER_AMOUNT_MESSAGE })
  amount: string;
}
