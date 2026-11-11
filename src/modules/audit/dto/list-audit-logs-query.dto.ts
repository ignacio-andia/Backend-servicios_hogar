import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  AuditAction,
  AuditEntityType,
} from '../../../generated/prisma/enums.js';

export const DEFAULT_AUDIT_PAGE_SIZE = 20;
export const MAX_AUDIT_PAGE_SIZE = 100;

export class ListAuditLogsQueryDto {
  @IsOptional()
  @IsEnum(AuditEntityType)
  entityType?: AuditEntityType;

  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  /** Administrador que realizó la acción. */
  @IsOptional()
  @IsUUID()
  actorId?: string;

  /** Registro afectado (por ejemplo, el id de una categoría). */
  @IsOptional()
  @IsUUID()
  entityId?: string;

  /** Inicio del intervalo, inclusivo. Fecha (`2026-11-01`, en UTC) o fecha y hora ISO 8601. */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  /** Fin del intervalo, inclusivo. Una fecha sin hora incluye todo ese día (UTC). */
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AUDIT_PAGE_SIZE)
  limit: number = DEFAULT_AUDIT_PAGE_SIZE;
}
