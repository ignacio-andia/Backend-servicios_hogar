import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { ClaimPriority, ClaimStatus } from '../../../generated/prisma/enums.js';
import { CLAIM_SITUATIONS, type ClaimSituation } from '../claims.rules.js';

export const CLAIM_TEXT_MAX_LENGTH = 2000;

/** Reclamo del cliente (RF-37): la descripcion es obligatoria (CU-37 A2). */
export class CreateClaimDto {
  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'description es obligatoria' })
  @MaxLength(CLAIM_TEXT_MAX_LENGTH)
  description: string;
}

/** Decision del administrador (RF-38): texto y justificacion, sin efectos automaticos. */
export class DecideClaimDto {
  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'decision es obligatoria' })
  @MaxLength(CLAIM_TEXT_MAX_LENGTH)
  decision: string;

  @Trim()
  @IsString()
  @IsNotEmpty({ message: 'justification es obligatoria' })
  @MaxLength(CLAIM_TEXT_MAX_LENGTH)
  justification: string;
}

/** Filtros del listado del administrador (RN-6 y RN-8). */
export class ListClaimsQueryDto {
  @IsOptional()
  @IsEnum(ClaimStatus)
  status?: ClaimStatus;

  @IsOptional()
  @IsEnum(ClaimPriority)
  priority?: ClaimPriority;

  @IsOptional()
  @IsIn(CLAIM_SITUATIONS, {
    message: 'situation debe ser PENDIENTE, VENCIDO o EN_PLAZO',
  })
  situation?: ClaimSituation;

  /** UUID de un administrador, o "none" para los reclamos sin responsable. */
  @IsOptional()
  @ValidateIf((_, value) => value !== 'none')
  @IsUUID('all', { message: 'assigneeId debe ser un UUID o "none"' })
  assigneeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}

/** Prioridad, responsable y plazo de un reclamo (RN-1 a RN-5). */
export class UpdateClaimAssignmentDto {
  @IsEnum(ClaimPriority, { message: 'priority no es valida' })
  priority: ClaimPriority;

  /** null o ausente: el reclamo queda sin responsable. */
  @IsOptional()
  @IsUUID('all', { message: 'assignedToId debe ser un UUID' })
  assignedToId?: string | null;

  /** ISO 8601. Ausente: se calcula con la prioridad (RN-2). */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'dueAt debe ser una fecha ISO 8601' })
  dueAt?: string;
}

export class ClaimImageQueryDto {
  @IsOptional()
  @IsIn(['full', 'thumb'], { message: 'variant debe ser full o thumb' })
  variant: 'full' | 'thumb' = 'full';
}