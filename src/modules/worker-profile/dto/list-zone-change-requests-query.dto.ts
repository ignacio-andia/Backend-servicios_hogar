import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ZoneChangeRequestStatus } from '../../../generated/prisma/enums.js';

export const DEFAULT_ZONE_REQUESTS_PAGE_SIZE = 20;
export const MAX_ZONE_REQUESTS_PAGE_SIZE = 100;

const parseBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class ListZoneChangeRequestsQueryDto {
  @IsOptional()
  @IsEnum(ZoneChangeRequestStatus)
  status?: ZoneChangeRequestStatus;

  /** true: solo resueltas (historial de resoluciones); false: solo pendientes. */
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean({ message: 'resolved debe ser true o false' })
  resolved?: boolean;

  /** Solicitudes de un trabajador concreto (id de la cuenta). */
  @IsOptional()
  @IsUUID()
  workerUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ZONE_REQUESTS_PAGE_SIZE)
  limit: number = DEFAULT_ZONE_REQUESTS_PAGE_SIZE;
}
