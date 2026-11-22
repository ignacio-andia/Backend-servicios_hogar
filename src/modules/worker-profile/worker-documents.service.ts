import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import type { Readable } from 'node:stream';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  WorkerDocumentType,
  WorkerProfileStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FileDeletionService } from '../../storage/file-deletion.service.js';
import { FileStorage } from '../../storage/file-storage.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import {
  documentMaxBytes,
  UploadedDocumentFile,
  validateDocumentFile,
  ValidatedDocumentFile,
} from './document-file.js';
import { EDITABLE_STATUSES } from './worker-profile.rules.js';
import { assertActiveAdmin } from './worker-profile.utils.js';

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

/** Como abre un administrador un documento: queda asi en la bitacora. */
export type AdminDocumentAccess =
  | typeof AuditAction.VISUALIZACION_DOCUMENTO
  | typeof AuditAction.DESCARGA_DOCUMENTO;

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
    private readonly fileDeletion: FileDeletionService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
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

  private async open(documentId: string): Promise<DocumentDownload> {
    const document = await this.prisma.workerDocument.findUnique({
      where: { id: documentId },
      select: {
        storageKey: true,
        mimeType: true,
        originalName: true,
        sizeBytes: true,
      },
    });
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

  // ---------------------------------------------------------------------
  // RF-56: acceso administrativo (con bitacora)
  // ---------------------------------------------------------------------

  /**
   * Lista los documentos (solo metadatos) de un perfil para verificarlo. La
   * lectura y el registro en la bitacora van en la misma transaccion: si no
   * se puede registrar el acceso, no se entregan los datos.
   */
  async listForAdmin(
    adminId: string,
    profileId: string,
  ): Promise<WorkerDocumentView[]> {
    await this.assertAdminCanAccess(adminId, profileId);
    return this.prisma.$transaction(async (tx) => {
      const documents = await tx.workerDocument.findMany({
        where: { profileId },
        select: DOCUMENT_SELECT,
        orderBy: [{ type: 'asc' }, { uploadedAt: 'desc' }],
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: AuditAction.CONSULTA_DOCUMENTOS,
          entityType: AuditEntityType.PERFIL_TRABAJADOR,
          entityId: profileId,
          details: { documentCount: documents.length },
        },
        tx,
      );
      return documents;
    });
  }

  /**
   * Abre un documento del perfil para verlo o descargarlo. El acceso se
   * registra solo cuando ya se comprobo todo (permisos, pertenencia al perfil
   * y que el archivo exista): un intento fallido nunca queda como exitoso.
   * Si no se puede registrar, el archivo no se entrega.
   */
  async openForAdmin(
    adminId: string,
    profileId: string,
    documentId: string,
    access: AdminDocumentAccess,
  ): Promise<DocumentDownload> {
    await this.assertAdminCanAccess(adminId, profileId);
    const document = await this.findOwnDocument(profileId, documentId);
    const download = await this.open(document.id);
    try {
      await this.audit.record({
        actorId: adminId,
        action: access,
        entityType: AuditEntityType.PERFIL_TRABAJADOR,
        entityId: profileId,
        details: { documentId: document.id, documentType: document.type },
      });
    } catch (error) {
      download.stream.destroy();
      throw error;
    }
    return download;
  }

  /**
   * Solo un administrador activo, sobre un perfil existente que no sea el
   * suyo (v1.0 §5). La identidad sale del token.
   */
  private async assertAdminCanAccess(
    adminId: string,
    profileId: string,
  ): Promise<void> {
    await assertActiveAdmin(this.users, adminId);
    const profile = await this.prisma.workerProfile.findUnique({
      where: { id: profileId },
      select: { userId: true },
    });
    if (!profile) {
      throw new NotFoundException('El perfil de trabajador no existe');
    }
    if (profile.userId === adminId) {
      throw new ForbiddenException(
        'No puede consultar los documentos de su propio perfil de trabajador',
      );
    }
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

  /**
   * Guarda el archivo y, si falla el registro en BD, lo elimina. Si el borrado
   * tambien falla, la clave queda en la cola compartida y se reintenta.
   */
  private async storeThen<T>(
    file: ValidatedDocumentFile,
    persist: (storageKey: string) => Promise<T>,
  ): Promise<T> {
    const storageKey = await this.storage.save(STORAGE_NAMESPACE, file.content);
    try {
      return await persist(storageKey);
    } catch (error) {
      await this.fileDeletion.deleteOrQueue(
        [storageKey],
        'compensacion-documento',
      );
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
