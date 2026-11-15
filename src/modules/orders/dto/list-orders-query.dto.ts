import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { OrderStatus } from '../../../generated/prisma/enums.js';

export const DEFAULT_ORDERS_PAGE_SIZE = 20;
export const MAX_ORDERS_PAGE_SIZE = 50;

class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ORDERS_PAGE_SIZE)
  limit: number = DEFAULT_ORDERS_PAGE_SIZE;
}

export class ListOwnOrdersQueryDto extends PaginationQueryDto {
  /** Estado efectivo (un PUBLICADO con el plazo cumplido cuenta como VENCIDO). */
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}

export class ListAvailableOrdersQueryDto extends PaginationQueryDto {
  /** Limita a una de las especialidades del trabajador. */
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export const IMAGE_VARIANTS = ['full', 'thumb'] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

export class ImageVariantQueryDto {
  @IsOptional()
  @IsIn(IMAGE_VARIANTS, { message: 'variant debe ser full o thumb' })
  variant: ImageVariant = 'full';
}
