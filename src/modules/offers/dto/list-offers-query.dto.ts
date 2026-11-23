import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { OfferStatus } from '../../../generated/prisma/enums.js';

// Mismos valores que los listados de pedidos.
export const DEFAULT_OFFERS_PAGE_SIZE = 20;
export const MAX_OFFERS_PAGE_SIZE = 50;

export class ListOffersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_OFFERS_PAGE_SIZE)
  limit: number = DEFAULT_OFFERS_PAGE_SIZE;

  /** Estado efectivo: una VIGENTE con la vigencia cumplida cuenta como VENCIDA. */
  @IsOptional()
  @IsEnum(OfferStatus)
  status?: OfferStatus;
}

export class ListReceivedOffersQueryDto extends ListOffersQueryDto {
  /** Limita a uno de los pedidos del cliente. */
  @IsOptional()
  @IsUUID()
  orderId?: string;
}
