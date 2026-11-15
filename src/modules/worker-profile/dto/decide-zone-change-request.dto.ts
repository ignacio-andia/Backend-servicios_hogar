import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { ZoneChangeRequestStatus } from '../../../generated/prisma/enums.js';

export const ZONE_CHANGE_DECISIONS = [
  ZoneChangeRequestStatus.APROBADA,
  ZoneChangeRequestStatus.RECHAZADA,
] as const;
export type ZoneChangeDecisionValue = (typeof ZONE_CHANGE_DECISIONS)[number];

export class DecideZoneChangeRequestDto {
  @IsIn(ZONE_CHANGE_DECISIONS, {
    message: 'decision debe ser APROBADA o RECHAZADA',
  })
  decision: ZoneChangeDecisionValue;

  /**
   * Comentario de la decision. Si el rechazo exige motivo esta pendiente de
   * confirmar con el docente: ver ZONE_CHANGE_POLICY.
   */
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
