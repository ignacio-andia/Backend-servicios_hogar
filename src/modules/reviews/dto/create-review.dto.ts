import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TrimEmptyAs } from '../../../common/decorators/trim.decorator.js';
import {
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_MAX_RATING,
  REVIEW_MIN_RATING,
} from '../review-rules.js';

/**
 * Calificacion de un pedido (RF-44). El autor sale del token y el calificado
 * se deduce del pedido: el cuerpo no puede elegirlos.
 */
export class CreateReviewDto {
  @IsInt()
  @Min(REVIEW_MIN_RATING)
  @Max(REVIEW_MAX_RATING)
  rating: number;

  /** Opcional; una cadena vacia equivale a no enviarlo. */
  @IsOptional()
  @TrimEmptyAs(undefined)
  @IsString()
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  comment?: string;
}
