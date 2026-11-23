import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readPositiveInt } from '../../common/config-values.js';
import { ABSOLUTE_IMAGE_MAX_MB, ORDER_MAX_IMAGES } from './orders.rules.js';

/**
 * Parametros configurables de pedidos (§5.5: no deben quedar escritos en el
 * codigo). Se leen una vez al arrancar; un valor invalido detiene el arranque.
 */
@Injectable()
export class OrdersConfig {
  // El plazo de vencimiento (7 dias) es una regla de negocio confirmada, no
  // un parametro: ver ORDER_EXPIRATION_DAYS (T5.1). Aqui solo se configura cada
  // cuanto corre la tarea que marca los vencidos.
  readonly expirationIntervalMinutes: number;
  /** Fotos por pedido: de 1 a 4 (especificacion v1.0 §3, T5.3). */
  readonly minImages: number;
  readonly maxImages: number;
  readonly imageMaxBytes: number;
  readonly imageMaxPixels: number;
  readonly imageMaxDimension: number;
  readonly imageQuality: number;
  readonly thumbnailSize: number;
  readonly duplicateWindowDays: number;

  constructor(config: ConfigService) {
    this.expirationIntervalMinutes = readPositiveInt(
      config,
      'ORDER_EXPIRATION_INTERVAL_MINUTES',
      15,
      { max: 1440 },
    );
    // El maximo es fijo (4, T5.3). Una configuracion distinta detiene el
    // arranque en lugar de ignorarse en silencio.
    const configuredMax = config.get<string>('ORDER_MAX_IMAGES');
    if (
      configuredMax !== undefined &&
      configuredMax.trim() !== String(ORDER_MAX_IMAGES)
    ) {
      throw new Error(
        `ORDER_MAX_IMAGES ya no es configurable: el maximo de fotografias por pedido es ${ORDER_MAX_IMAGES}. Quite la variable del entorno.`,
      );
    }
    this.maxImages = ORDER_MAX_IMAGES;
    this.minImages = readPositiveInt(config, 'ORDER_MIN_IMAGES', 1, {
      max: ORDER_MAX_IMAGES,
    });
    this.imageMaxBytes =
      readPositiveInt(config, 'ORDER_IMAGE_MAX_MB', 10, {
        max: ABSOLUTE_IMAGE_MAX_MB,
      }) *
      1024 *
      1024;
    this.imageMaxPixels = readPositiveInt(
      config,
      'ORDER_IMAGE_MAX_PIXELS',
      50_000_000,
      { min: 1_000, max: 268_402_689 },
    );
    this.imageMaxDimension = readPositiveInt(
      config,
      'ORDER_IMAGE_MAX_DIMENSION',
      1600,
      { min: 200, max: 8000 },
    );
    this.imageQuality = readPositiveInt(config, 'ORDER_IMAGE_QUALITY', 80, {
      max: 100,
    });
    this.thumbnailSize = readPositiveInt(config, 'ORDER_THUMBNAIL_SIZE', 400, {
      min: 50,
      max: 2000,
    });
    this.duplicateWindowDays = readPositiveInt(
      config,
      'ORDER_DUPLICATE_WINDOW_DAYS',
      7,
      { max: 365 },
    );
  }
}
