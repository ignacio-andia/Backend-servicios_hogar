import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

const parseBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class ListCatalogQueryDto {
  /** Sin valor devuelve registros activos e inactivos. */
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean({ message: 'isActive debe ser true o false' })
  isActive?: boolean;
}
