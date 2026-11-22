import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import {
  AuditAction,
  AuditEntityType,
  RoleName,
  UserStatus,
  WorkerDocumentType,
  WorkerProfileStatus,
} from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { FileDeletionService } from '../../storage/file-deletion.service.js';
import type { FileStorage } from '../../storage/file-storage.js';
import type { AuditService } from '../audit/audit.service.js';
import type { UsersService } from '../users/users.service.js';
import { WorkerDocumentsService } from './worker-documents.service.js';

const PDF = Buffer.from('%PDF-1.7\n%prueba\n');
const ADMIN_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';
const WORKER_ID = '2b7e9d1c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const PROFILE_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const DOC_ID = '6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b';

type Fn = ReturnType<typeof vi.fn>;

const build = () => {
  const prisma = {
    workerProfile: { findUnique: vi.fn() },
    workerDocument: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    (work: (tx: typeof prisma) => unknown) => work(prisma),
  );
  const storage = { save: vi.fn(), read: vi.fn() };
  const fileDeletion = { deleteOrQueue: vi.fn().mockResolvedValue(undefined) };
  const users = {
    findById: vi.fn().mockResolvedValue({
      id: ADMIN_ID,
      status: UserStatus.ACTIVO,
      roles: [RoleName.ADMINISTRADOR],
    }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new WorkerDocumentsService(
    prisma as unknown as PrismaService,
    storage as unknown as FileStorage,
    fileDeletion as unknown as FileDeletionService,
    users as unknown as UsersService,
    audit as unknown as AuditService,
    new ConfigService({}),
  );
  return { prisma, storage, fileDeletion, users, audit, service };
};

describe('WorkerDocumentsService (compensacion)', () => {
  it('si falla el registro en BD, borra el archivo o lo deja en la cola compartida', async () => {
    const { prisma, storage, fileDeletion, service } = build();
    const dbError = new Error('fallo de BD');
    prisma.workerProfile.findUnique.mockResolvedValue({
      id: 'perfil-1',
      status: WorkerProfileStatus.BORRADOR,
    });
    prisma.workerDocument.create.mockRejectedValue(dbError);
    storage.save.mockResolvedValue('worker-documents/k1');

    await expect(
      service.upload('usuario-1', WorkerDocumentType.IDENTIDAD, {
        buffer: PDF,
        size: PDF.length,
        originalname: 'cedula.pdf',
        mimetype: 'application/pdf',
      }),
    ).rejects.toBe(dbError);
    expect(fileDeletion.deleteOrQueue).toHaveBeenCalledWith(
      ['worker-documents/k1'],
      'compensacion-documento',
    );
  });
});

describe('WorkerDocumentsService (acceso administrativo, RF-56)', () => {
  let ctx: ReturnType<typeof build>;
  const document = {
    id: DOC_ID,
    type: WorkerDocumentType.IDENTIDAD,
    replacedById: null,
  };

  beforeEach(() => {
    ctx = build();
    ctx.prisma.workerProfile.findUnique.mockResolvedValue({
      userId: WORKER_ID,
    });
    ctx.prisma.workerDocument.findFirst.mockResolvedValue(document);
    ctx.prisma.workerDocument.findUnique.mockResolvedValue({
      storageKey: 'worker-documents/k1',
      mimeType: 'application/pdf',
      originalName: 'cedula.pdf',
      sizeBytes: PDF.length,
    });
    ctx.storage.read.mockResolvedValue(Readable.from([PDF]));
  });

  it('lista los metadatos y registra la consulta en la misma transaccion', async () => {
    const docs = [{ id: DOC_ID, type: WorkerDocumentType.IDENTIDAD }];
    ctx.prisma.workerDocument.findMany.mockResolvedValue(docs);

    await expect(ctx.service.listForAdmin(ADMIN_ID, PROFILE_ID)).resolves.toBe(
      docs,
    );

    expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ctx.audit.record).toHaveBeenCalledWith(
      {
        actorId: ADMIN_ID,
        action: AuditAction.CONSULTA_DOCUMENTOS,
        entityType: AuditEntityType.PERFIL_TRABAJADOR,
        entityId: PROFILE_ID,
        details: { documentCount: 1 },
      },
      ctx.prisma,
    );
  });

  it.each([
    AuditAction.VISUALIZACION_DOCUMENTO,
    AuditAction.DESCARGA_DOCUMENTO,
  ])(
    'abre el documento y registra %s con perfil y documento',
    async (access) => {
      const file = await ctx.service.openForAdmin(
        ADMIN_ID,
        PROFILE_ID,
        DOC_ID,
        access,
      );

      expect(file).toMatchObject({
        mimeType: 'application/pdf',
        fileName: 'cedula.pdf',
        sizeBytes: PDF.length,
      });
      expect(ctx.prisma.workerDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: DOC_ID, profileId: PROFILE_ID },
        }),
      );
      expect(ctx.audit.record).toHaveBeenCalledWith({
        actorId: ADMIN_ID,
        action: access,
        entityType: AuditEntityType.PERFIL_TRABAJADOR,
        entityId: PROFILE_ID,
        details: {
          documentId: DOC_ID,
          documentType: WorkerDocumentType.IDENTIDAD,
        },
      });
    },
  );

  const expectNoAccess = (ctxToCheck: ReturnType<typeof build>) => {
    expect(ctxToCheck.audit.record).not.toHaveBeenCalled();
    expect(ctxToCheck.storage.read).not.toHaveBeenCalled();
  };

  it('un usuario que no es administrador activo recibe 403 sin registro', async () => {
    ctx.users.findById.mockResolvedValue({
      id: WORKER_ID,
      status: UserStatus.ACTIVO,
      roles: [RoleName.CLIENTE],
    });

    await expect(
      ctx.service.listForAdmin(WORKER_ID, PROFILE_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expectNoAccess(ctx);
  });

  it('el administrador no accede a los documentos de su propio perfil', async () => {
    ctx.prisma.workerProfile.findUnique.mockResolvedValue({ userId: ADMIN_ID });

    await expect(
      ctx.service.openForAdmin(
        ADMIN_ID,
        PROFILE_ID,
        DOC_ID,
        AuditAction.DESCARGA_DOCUMENTO,
      ),
    ).rejects.toThrow(
      'No puede consultar los documentos de su propio perfil de trabajador',
    );
    await expect(
      ctx.service.listForAdmin(ADMIN_ID, PROFILE_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.prisma.workerDocument.findMany).not.toHaveBeenCalled();
    expectNoAccess(ctx);
  });

  it('perfil inexistente o documento de otro perfil: 404 sin registro', async () => {
    ctx.prisma.workerDocument.findFirst.mockResolvedValue(null);
    await expect(
      ctx.service.openForAdmin(
        ADMIN_ID,
        PROFILE_ID,
        DOC_ID,
        AuditAction.VISUALIZACION_DOCUMENTO,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    ctx.prisma.workerProfile.findUnique.mockResolvedValue(null);
    await expect(
      ctx.service.listForAdmin(ADMIN_ID, PROFILE_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expectNoAccess(ctx);
  });

  it('si el archivo no existe en el almacenamiento, no registra el acceso', async () => {
    ctx.storage.read.mockRejectedValue(new NotFoundException('sin archivo'));

    await expect(
      ctx.service.openForAdmin(
        ADMIN_ID,
        PROFILE_ID,
        DOC_ID,
        AuditAction.DESCARGA_DOCUMENTO,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.audit.record).not.toHaveBeenCalled();
  });

  it('si no se puede registrar el acceso, cierra el archivo y no lo entrega', async () => {
    const stream = Readable.from([PDF]);
    ctx.storage.read.mockResolvedValue(stream);
    (ctx.audit.record as Fn).mockRejectedValue(new Error('bitacora caida'));

    await expect(
      ctx.service.openForAdmin(
        ADMIN_ID,
        PROFILE_ID,
        DOC_ID,
        AuditAction.VISUALIZACION_DOCUMENTO,
      ),
    ).rejects.toThrow('bitacora caida');
    expect(stream.destroyed).toBe(true);
  });
});
