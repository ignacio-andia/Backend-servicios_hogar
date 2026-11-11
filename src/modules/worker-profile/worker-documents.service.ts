import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import type { Readable } from 'node:stream';
import {
  Prisma,
  WorkerDocumentType,
  WorkerProfileStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FileStorage } from '../../storage/file-storage.js';
import {
  documentMaxBytes,
  UploadedDocumentFile,
  validateDocumentFile,
  ValidatedDocumentFile,
} from './document-file.js';
import { EDITABLE_STATUSES } from './worker-profile.rules.js';

// Espacio del almacenamiento privado reservado a estos documentos.
const STORAGE_NAMESPACE = 'worker-documents';

// Nunca se devuelve storageKey ni la ruta interna del archivo.
const DOCUMENT_SELECT = {
  id: true,
  type: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedAt: true,
  replacedAt: true,
  replacedById: true,
} satisfies Prisma.WorkerDocumentSelect;

export type WorkerDocumentView = Prisma.WorkerDocumentGetPayload<{
  select: typeof DOCUMENT_SELECT;
}>;

export interface DocumentDownload {
  stream: Readable;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

/**
 * Documentacion de respaldo del trabajador (RF-07). Los archivos se guardan
 * en un almacenamiento privado; reemplazar un documento conserva el anterior.
 */
@Injectable()
export class WorkerDocumentsService {
  readonly maxSizeBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    config: ConfigService,
  ) {
    this.maxSizeBytes = documentMaxBytes(config);
  }

  async upload(
    userId: string,
    type: WorkerDocumentType,
    file: UploadedDocumentFile | undefined,
  ): Promise<WorkerDocumentView> {
    const profile = await this.getEditableProfile(userId);
    const validated = validateDocumentFile(file, this.maxSizeBytes);

    return this.storeThen(validated, (storageKey) =>
      this.prisma.workerDocument.create({
        data: {
          profileId: profile.id,
          type,
          storageKey,
          ...metadata(validated),
        },
        select: DOCUMENT_SELECT,
      }),
    );
  }

  /** Sube una nueva version; la anterior queda en el historial como reemplazada. */
  async replace(
    userId: string,
    documentId: string,
    file: UploadedDocumentFile | undefined,
  ): Promise<WorkerDocumentView> {
    const profile = await this.getEditableProfile(userId);
    const current = await this.findOwnDocument(profile.id, documentId);
    if (current.replacedById) {
      throw new ConflictException(
        'Ese documento ya fue reemplazado; reemplace la versión vigente',
      );
    }
    const validated = validateDocumentFile(file, this.maxSizeBytes);

    return this.storeThen(validated, (storageKey) =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.workerDocument.create({
          data: {
            profileId: profile.id,
            type: current.type,
            storageKey,
            ...metadata(validated),
          },
          select: DOCUMENT_SELECT,
        });
        const { count } = await tx.workerDocument.updateMany({
          where: { id: current.id, replacedById: null },
          data: { replacedAt: new Date(), replacedById: created.id },
        });
        if (count === 0) {
          throw new ConflictException('Ese documento ya fue reemplazado');
        }
        return created;
      }),
    );
  }

  /** Documentos propios, vigentes y reemplazados (historial). */
  async listOwn(userId: string): Promise<WorkerDocumentView[]> {
    const profile = await this.getOwnProfile(userId);
    return this.prisma.workerDocument.findMany({
      where: { profileId: profile.id },
      select: DOCUMENT_SELECT,
      orderBy: [{ type: 'asc' }, { uploadedAt: 'desc' }],
    });
  }

  async openOwn(userId: string, documentId: string): Promise<DocumentDownload> {
    const profile = await this.getOwnProfile(userId);
    await this.findOwnDocument(profile.id, documentId);
    return this.open(documentId);
  }

  /**
   * Abre cualquier documento. Sin endpoint propio: lo usara el modulo de
   * verificacion, con su propio control de acceso de administrador.
   */
  async open(documentId: string): Promise<DocumentDownload> {
    const document = isUUID(documentId)
      ? await this.prisma.workerDocument.findUnique({
          where: { id: documentId },
          select: {
            storageKey: true,
            mimeType: true,
            originalName: true,
            sizeBytes: true,
          },
        })
      : null;
    if (!document) {
      throw documentNotFound();
    }
    return {
      stream: await this.storage.read(document.storageKey),
      mimeType: document.mimeType,
      fileName: document.originalName,
      sizeBytes: document.sizeBytes,
    };
  }

  private async getOwnProfile(
    userId: string,
  ): Promise<{ id: string; status: WorkerProfileStatus }> {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId },
      select: { id: true, status: true },
    });
    if (!profile) {
      throw new NotFoundException('Aún no tiene un perfil de trabajador');
    }
    return profile;
  }

  private async getEditableProfile(userId: string) {
    const profile = await this.getOwnProfile(userId);
    if (!EDITABLE_STATUSES.includes(profile.status)) {
      throw new ConflictException(
        `No se pueden adjuntar documentos con el perfil en estado ${profile.status}`,
      );
    }
    return profile;
  }

  /** Un documento ajeno responde igual que uno inexistente (404). */
  private async findOwnDocument(profileId: string, documentId: string) {
    const document = isUUID(documentId)
      ? await this.prisma.workerDocument.findFirst({
          where: { id: documentId, profileId },
          select: { id: true, type: true, replacedById: true },
        })
      : null;
    if (!document) {
      throw documentNotFound();
    }
    return document;
  }

  /** Guarda el archivo y, si falla el registro en BD, lo elimina. */
  private async storeThen<T>(
    file: ValidatedDocumentFile,
    persist: (storageKey: string) => Promise<T>,
  ): Promise<T> {
    const storageKey = await this.storage.save(STORAGE_NAMESPACE, file.content);
    try {
      return await persist(storageKey);
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }
}

function metadata(file: ValidatedDocumentFile) {
  return {
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  };
}

function documentNotFound(): NotFoundException {
  return new NotFoundException('El documento no existe');
}
