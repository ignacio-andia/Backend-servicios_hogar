import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readPositiveInt } from '../../common/config-values.js';

/**
 * Tope tecnico absoluto de fotos por reclamo (limite de multer y proteccion
 * de memoria/almacenamiento). NO es una regla de negocio.
 */
export const CLAIM_IMAGES_TECHNICAL_CEILING = 20;

/**
 * Fotos del reclamo (RF-37). El requerimiento dice "con descripcion y fotos"
 * pero CU-37 A2 solo exige la descripcion, y no define minimo ni maximo.
 * PENDIENTE DE CONFIRMAR CON EL DOCENTE: por eso no hay regla fija: el
 * minimo (por defecto 0: fotos opcionales) y el maximo (por defecto el tope
 * tecnico) son configurables. Un valor invalido detiene el arranque.
 */
@Injectable()
export class ClaimsConfig {
  readonly minImages: number;
  readonly maxImages: number;

  constructor(config: ConfigService) {
    this.minImages = readPositiveInt(config, 'CLAIM_MIN_IMAGES', 0, {
      min: 0,
      max: CLAIM_IMAGES_TECHNICAL_CEILING,
    });
    this.maxImages = readPositiveInt(
      config,
      'CLAIM_MAX_IMAGES',
      CLAIM_IMAGES_TECHNICAL_CEILING,
      { max: CLAIM_IMAGES_TECHNICAL_CEILING },
    );
    if (this.minImages > this.maxImages) {
      throw new Error('CLAIM_MIN_IMAGES no puede superar CLAIM_MAX_IMAGES');
    }
  }
}
