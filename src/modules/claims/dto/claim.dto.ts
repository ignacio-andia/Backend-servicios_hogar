import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { ClaimStatus } from '../../../generated/prisma/enums.js';

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

export class ListClaimsQueryDto {
  @IsOptional()
  @IsEnum(ClaimStatus)
  status?: ClaimStatus;

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

export class ClaimImageQueryDto {
  @IsOptional()
  @IsIn(['full', 'thumb'], { message: 'variant debe ser full o thumb' })
  variant: 'full' | 'thumb' = 'full';
}
