import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';
import { MAX_SPECIALTIES } from './create-worker-profile.dto.js';

/** Reemplaza el conjunto completo de especialidades. */
export class UpdateSpecialtiesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SPECIALTIES)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  categoryIds: string[];
}
