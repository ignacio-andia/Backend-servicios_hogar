import { IsOptional, IsUUID } from 'class-validator';

export class ListInactiveZoneProfilesQueryDto {
  /** Limita el resultado a una zona inactiva concreta. */
  @IsOptional()
  @IsUUID()
  zoneId?: string;
}
