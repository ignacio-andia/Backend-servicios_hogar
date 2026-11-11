import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import { MAX_SCHEDULES } from '../schedules.js';
import { ScheduleItemDto } from './schedule-item.dto.js';

export const MAX_YEARS_OF_EXPERIENCE = 70;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_SPECIALTIES = 10;

/**
 * Registro inicial del perfil (RF-06). Nombre, correo y telefono no se
 * repiten aqui: pertenecen a la cuenta (UsersModule). El estado no se recibe.
 */
export class CreateWorkerProfileDto {
  @IsInt()
  @Min(0)
  @Max(MAX_YEARS_OF_EXPERIENCE)
  yearsOfExperience: number;

  /** Presentacion profesional o descripcion de la experiencia. */
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_DESCRIPTION_LENGTH)
  description?: string;

  /** Zona de atencion activa (RF-13). */
  @IsUUID()
  zoneId: string;

  /** Categorias activas del catalogo (RF-48). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SPECIALTIES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  categoryIds: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCHEDULES)
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  schedules?: ScheduleItemDto[];
}
