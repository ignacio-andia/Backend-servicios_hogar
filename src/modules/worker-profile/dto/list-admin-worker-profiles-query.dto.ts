import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { WorkerProfileStatus } from '../../../generated/prisma/enums.js';

export const DEFAULT_ADMIN_PROFILES_PAGE_SIZE = 20;
export const MAX_ADMIN_PROFILES_PAGE_SIZE = 100;

/** Filtros del listado administrativo de perfiles (RF-10, RF-47). */
export class ListAdminWorkerProfilesQueryDto {
  /** Por ejemplo PENDIENTE para la cola de revision. */
  @IsOptional()
  @IsEnum(WorkerProfileStatus)
  status?: WorkerProfileStatus;

  /** Zona de atencion del perfil. */
  @IsOptional()
  @IsUUID()
  zoneId?: string;

  /** Perfiles que tienen esta especialidad. */
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ADMIN_PROFILES_PAGE_SIZE)
  limit: number = DEFAULT_ADMIN_PROFILES_PAGE_SIZE;
}
