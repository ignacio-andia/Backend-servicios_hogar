import { IsUUID } from 'class-validator';
import { ListReviewsQueryDto } from './review-queries.dto.js';

/** Busqueda de trabajadores (RF-16): el cliente elige categoria y zona. */
export class SearchWorkersQueryDto extends ListReviewsQueryDto {
  @IsUUID()
  categoryId: string;

  @IsUUID()
  zoneId: string;
}
