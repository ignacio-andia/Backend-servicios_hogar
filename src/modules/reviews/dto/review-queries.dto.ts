import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_REVIEWS_PAGE_SIZE = 10;
export const MAX_REVIEWS_PAGE_SIZE = 50;

export class ListReviewsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_REVIEWS_PAGE_SIZE)
  limit: number = DEFAULT_REVIEWS_PAGE_SIZE;
}
