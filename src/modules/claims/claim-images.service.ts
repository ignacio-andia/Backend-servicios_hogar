import { Injectable, NotFoundException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FileDeletionService } from '../../storage/file-deletion.service.js';
import { FileStorage } from '../../storage/file-storage.js';
import {
  OrderImageProcessor,
  type UploadedImageFile,
} from '../orders/images/order-image.processor.js';

/** Espacio del almacenamiento privado reservado a la evidencia de reclamos. */
export const CLAIM_IMAGES_NAMESPACE = 'claim-images';
const COMPENSATION = 'compensacion-reclamo';

export interface StoredClaimImage {
  storageKey: string;
  thumbnailKey: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  thumbnailSizeBytes: number;
  sha256: string;
}

export interface ClaimImageDownload {
  stream: Readable;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Fotos de reclamos: evidencia. Se procesan igual que las del pedido (se
 * valida el contenido real, WebP sin metadatos), con claves generadas por el
 * almacenamiento: el cliente nunca elige rutas. NO hay borrado de evidencia:
 * solo se descartan archivos cuyo reclamo no llego a confirmarse
 * (compensacion). El borrado de un pedido cerrado sin acuerdo no alcanza a
 * estas fotos porque un reclamo siempre parte de un pedido con acuerdo.
 */
@Injectable()
export class ClaimImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly fileDeletion: FileDeletionService,
    private readonly processor: OrderImageProcessor,
  ) {}

  async processAndStore(
    files: UploadedImageFile[],
  ): Promise<StoredClaimImage[]> {
    const stored: StoredClaimImage[] = [];
    try {
      for (const file of files) {
        const processed = await this.processor.process(file);
        const storageKey = await this.storage.save(
          CLAIM_IMAGES_NAMESPACE,
          processed.content,
        );
        const thumbnailKey = await this.storage
          .save(CLAIM_IMAGES_NAMESPACE, processed.thumbnail)
          .catch(async (error: unknown) => {
            await this.fileDeletion.deleteOrQueue([storageKey], COMPENSATION);
            throw error;
          });
        const { content: _content, thumbnail: _thumbnail, ...meta } = processed;
        stored.push({ ...meta, storageKey, thumbnailKey });
      }
      return stored;
    } catch (error) {
      await this.discard(stored);
      throw error;
    }
  }

  /** Compensacion: archivos guardados cuyo reclamo no se confirmo. */
  async discard(images: { storageKey: string; thumbnailKey: string }[]) {
    await this.fileDeletion.deleteOrQueue(
      images.flatMap((image) => [image.storageKey, image.thumbnailKey]),
      COMPENSATION,
    );
  }

  /** Abre una foto del reclamo; el llamador ya verifico el permiso. */
  async open(
    claimId: string,
    imageId: string,
    variant: 'full' | 'thumb',
  ): Promise<ClaimImageDownload> {
    const image = await this.prisma.claimImage.findFirst({
      where: { id: imageId, claimId },
      select: {
        storageKey: true,
        thumbnailKey: true,
        mimeType: true,
        sizeBytes: true,
        thumbnailSizeBytes: true,
      },
    });
    if (!image) {
      throw new NotFoundException('La fotografía no existe');
    }
    const thumb = variant === 'thumb';
    return {
      stream: await this.storage.read(
        thumb ? image.thumbnailKey : image.storageKey,
      ),
      mimeType: image.mimeType,
      sizeBytes: thumb ? image.thumbnailSizeBytes : image.sizeBytes,
    };
  }
}
