import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { OrdersConfig } from '../orders.config.js';

/** Archivo recibido por multer en memoria (solo los campos que se usan). */
export interface UploadedImageFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ProcessedImage {
  content: Buffer;
  thumbnail: Buffer;
  mimeType: 'image/webp';
  width: number;
  height: number;
  sizeBytes: number;
  thumbnailSizeBytes: number;
  sha256: string;
}

// Formato real detectado por el decodificador (no la extension ni el
// Content-Type del cliente). HEIC: PENDIENTE DE CONFIRMAR CON EL DOCENTE.
const ACCEPTED_FORMATS: Record<string, string> = {
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
};
export const ACCEPTED_IMAGE_FORMATS =
  Object.values(ACCEPTED_FORMATS).join(', ');

/**
 * Procesa cada foto como una app de mensajeria: corrige la orientacion,
 * reduce al tamano maximo, convierte a sRGB y la guarda como WebP sin
 * metadatos (sin EXIF, GPS, XMP, IPTC ni perfil ICC). Volver a codificar
 * tambien descarta contenido oculto. Solo se guarda la version procesada.
 */
@Injectable()
export class OrderImageProcessor {
  constructor(private readonly settings: OrdersConfig) {}

  async process(file: UploadedImageFile | undefined): Promise<ProcessedImage> {
    if (!file?.buffer || file.size === 0) {
      throw new BadRequestException(
        'Cada fotografía debe ser un archivo de imagen no vacío',
      );
    }
    if (file.size > this.settings.imageMaxBytes) {
      throw new PayloadTooLargeException(this.tooLargeMessage());
    }

    let format: string | undefined;
    try {
      ({ format } = await sharp(file.buffer, this.inputOptions()).metadata());
    } catch (error) {
      throw this.invalidImage(error);
    }
    if (!format || !(format in ACCEPTED_FORMATS)) {
      throw new BadRequestException(
        `Formato de imagen no permitido. Formatos aceptados: ${ACCEPTED_IMAGE_FORMATS}`,
      );
    }

    try {
      const full = await this.render(
        file.buffer,
        this.settings.imageMaxDimension,
      );
      const thumbnail = await this.render(
        file.buffer,
        this.settings.thumbnailSize,
      );
      return {
        content: full.data,
        thumbnail: thumbnail.data,
        mimeType: 'image/webp',
        width: full.info.width,
        height: full.info.height,
        sizeBytes: full.data.length,
        thumbnailSizeBytes: thumbnail.data.length,
        sha256: createHash('sha256').update(full.data).digest('hex'),
      };
    } catch (error) {
      throw this.invalidImage(error);
    }
  }

  tooLargeMessage(): string {
    return `Cada fotografía puede pesar como máximo ${Math.round(
      this.settings.imageMaxBytes / (1024 * 1024),
    )} MB`;
  }

  private render(input: Buffer, maxSide: number) {
    return (
      sharp(input, { ...this.inputOptions(), animated: false })
        // Aplica la orientacion EXIF antes de descartar los metadatos.
        .rotate()
        .resize({
          width: maxSide,
          height: maxSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toColourspace('srgb')
        // Sin withMetadata/keepMetadata: no se escribe EXIF, XMP, IPTC ni ICC.
        .webp({ quality: this.settings.imageQuality })
        .toBuffer({ resolveWithObject: true })
    );
  }

  private inputOptions() {
    return {
      limitInputPixels: this.settings.imageMaxPixels,
      failOn: 'error' as const,
    };
  }

  private invalidImage(error: unknown): BadRequestException {
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit/i.test(message)) {
      return new BadRequestException(
        `La imagen supera el máximo de ${Math.round(
          this.settings.imageMaxPixels / 1_000_000,
        )} megapíxeles`,
      );
    }
    return new BadRequestException(
      'El archivo no es una imagen válida o está dañado',
    );
  }
}
