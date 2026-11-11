import { IsBoolean, IsEnum, IsOptional, Matches } from 'class-validator';
import { WeekDay } from '../../../generated/prisma/enums.js';
import { TIME_PATTERN } from '../schedules.js';

export class ScheduleItemDto {
  @IsEnum(WeekDay)
  dayOfWeek: WeekDay;

  /** Hora de inicio en formato HH:mm (24 horas). */
  @Matches(TIME_PATTERN, { message: 'startTime debe tener el formato HH:mm' })
  startTime: string;

  /** Hora de fin en formato HH:mm (24 horas); admite 24:00. */
  @Matches(TIME_PATTERN, { message: 'endTime debe tener el formato HH:mm' })
  endTime: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
