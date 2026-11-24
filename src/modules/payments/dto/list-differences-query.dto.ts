import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_DIFFERENCES_PAGE_SIZE = 20;
export const MAX_DIFFERENCES_PAGE_SIZE = 100;

export class ListPaymentDifferencesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DIFFERENCES_PAGE_SIZE)
  limit: number = DEFAULT_DIFFERENCES_PAGE_SIZE;
}
