import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
} from '../timeline-page.js';

export class TimelineQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TIMELINE_MAX_LIMIT)
  limit: number = TIMELINE_DEFAULT_LIMIT;

  /** Cursor opaco devuelto como nextCursor en la pagina anterior. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;
}
