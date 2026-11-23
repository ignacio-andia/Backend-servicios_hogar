import { Injectable, NotFoundException } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { FileDeletionService } from '../../../storage/file-deletion.service.js';
import { FileStorage } from '../../../storage/file-storage.js';
import type { ImageVariant } from '../dto/list-orders-query.dto.js';
import {
  OrderImageProcessor,
  ProcessedImage,
  UploadedImageFile,
} from './order-image.processor.js';

// Espacio del almacenamiento privado reservado a las fotos de pedidos.
export const ORDER_IMAGES_NAMESPACE = 'order-images';

export type StoredImage = Omit<ProcessedImage, 'content' | 'thumbnail'> & {
  storageKey: string;
  thumbnailKey: string;
};

export interface ImageDownload {
  stream: Readable;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Fotografias de pedidos sobre el FileStorage compartido: procesa, guarda y
 * entrega archivos. Las reglas de cuantas fotos y cuando se editan estan en
 * OrdersService; el borrado pasa siempre por FileDeletionService.
 */
@Injectable()
export class OrderImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly fileDeletion: FileDeletionService,
    private readonly processor: OrderImageProcessor,
  ) {}

  /**
   * Procesa y guarda las fotos de a una (acota la memoria). Si algo falla,
   * borra (o encola) lo ya guardado y relanza el error.
   */
  async processAndStore(files: UploadedImageFile[]): Promise<StoredImage[]> {
    const stored: StoredImage[] = [];
    try {
      for (const file of files) {
        const processed = await this.processor.process(file);
        const storageKey = await this.storage.save(
          ORDER_IMAGES_NAMESPACE,
          processed.content,
        );
        const thumbnailKey = await this.storage
          .save(ORDER_IMAGES_NAMESPACE, processed.thumbnail)
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

  /**
   * T5.4: libera todas las fotos de un pedido dentro de la transaccion `tx`
   * del llamador: borra sus filas y encola sus archivos en la misma
   * transaccion (cola compartida). Devuelve las claves para borrarlas despues
   * de confirmar (FileDeletionService.processNow). Sin fotos, no hace nada.
   */
  async releaseOrderImages(
    tx: Prisma.TransactionClient,
    orderId: string,
    reason: string,
  ): Promise<string[]> {
    const images = await tx.orderImage.findMany({
      where: { orderId },
      select: { storageKey: true, thumbnailKey: true },
    });
    if (images.length === 0) {
      return [];
    }
    await tx.orderImage.deleteMany({ where: { orderId } });
    const keys = imageKeys(images);
    await this.fileDeletion.enqueue(keys, reason, tx);
    return keys;
  }

  /** Compensacion: archivos guardados cuyo registro en la BD no se confirmo. */
  async discard(images: { storageKey: string; thumbnailKey: string }[]) {
    await this.fileDeletion.deleteOrQueue(imageKeys(images), COMPENSATION);
  }

  async open(
    orderId: string,
    imageId: string,
    variant: ImageVariant,
  ): Promise<ImageDownload> {
    const image = await this.prisma.orderImage.findFirst({
      where: { id: imageId, orderId },
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

const COMPENSATION = 'compensacion-pedido';

export function imageKeys(
  images: { storageKey: string; thumbnailKey: string }[],
): string[] {
  return images.flatMap((image) => [image.storageKey, image.thumbnailKey]);
}
