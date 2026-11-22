import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';

// Mismo limite que los demas motivos cortos de cambio de zona.
export const ZONE_REASSIGNMENT_JUSTIFICATION_MAX_LENGTH = 500;

/**
 * Reasignacion administrativa de zona de un perfil RECHAZADO cuya zona fue
 * desactivada (T4.4). La justificacion es obligatoria y no puede quedar vacia
 * despues de recortar los espacios: queda en la bitacora.
 */
export class ReassignRejectedProfileZoneDto {
  /** Zona nueva: debe existir, estar activa y ser distinta de la actual. */
  @IsUUID()
  zoneId: string;

  @Trim()
  @IsString({ message: 'justification debe ser un texto' })
  @IsNotEmpty({
    message: 'justification es obligatoria y no puede estar vacía',
  })
  @MaxLength(ZONE_REASSIGNMENT_JUSTIFICATION_MAX_LENGTH)
  justification: string;
}
