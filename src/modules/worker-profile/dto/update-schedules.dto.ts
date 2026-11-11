import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, ValidateNested } from 'class-validator';
import { MAX_SCHEDULES } from '../schedules.js';
import { ScheduleItemDto } from './schedule-item.dto.js';

/** Reemplaza el conjunto completo de horarios de atencion. */
export class UpdateSchedulesDto {
  @IsArray()
  @ArrayMaxSize(MAX_SCHEDULES)
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  schedules: ScheduleItemDto[];
}
