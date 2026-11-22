import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_NOTIFICATIONS_PAGE_SIZE = 20;
export const MAX_NOTIFICATIONS_PAGE_SIZE = 100;

const parseBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class ListNotificationsQueryDto {
  /** true: solo no leidas; false: solo leidas; omitido: todas. */
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean({ message: 'unread debe ser true o false' })
  unread?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_NOTIFICATIONS_PAGE_SIZE)
  limit: number = DEFAULT_NOTIFICATIONS_PAGE_SIZE;
}
