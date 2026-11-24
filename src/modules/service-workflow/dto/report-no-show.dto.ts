import { IsOptional, IsString, MaxLength } from 'class-validator';
import { TrimEmptyAs } from '../../../common/decorators/trim.decorator.js';
import { NO_SHOW_DESCRIPTION_MAX_LENGTH } from '../workflow.rules.js';

/** Reporte "El trabajador no llego" (RF-36). La descripcion es opcional. */
export class ReportNoShowDto {
  @TrimEmptyAs(undefined)
  @IsOptional()
  @IsString()
  @MaxLength(NO_SHOW_DESCRIPTION_MAX_LENGTH)
  description?: string;
}
