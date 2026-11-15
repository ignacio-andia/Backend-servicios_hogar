import { ConfigService } from '@nestjs/config';
import {
  WorkerDocumentType,
  WorkerProfileStatus,
} from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { FileDeletionService } from '../../storage/file-deletion.service.js';
import type { FileStorage } from '../../storage/file-storage.js';
import { WorkerDocumentsService } from './worker-documents.service.js';

const PDF = Buffer.from('%PDF-1.7\n%prueba\n');

describe('WorkerDocumentsService (compensacion)', () => {
  it('si falla el registro en BD, borra el archivo o lo deja en la cola compartida', async () => {
    const dbError = new Error('fallo de BD');
    const prisma = {
      workerProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'perfil-1',
          status: WorkerProfileStatus.BORRADOR,
        }),
      },
      workerDocument: { create: vi.fn().mockRejectedValue(dbError) },
    };
    const storage = { save: vi.fn().mockResolvedValue('worker-documents/k1') };
    const fileDeletion = {
      deleteOrQueue: vi.fn().mockResolvedValue(undefined),
    };
    const service = new WorkerDocumentsService(
      prisma as unknown as PrismaService,
      storage as unknown as FileStorage,
      fileDeletion as unknown as FileDeletionService,
      new ConfigService({}),
    );

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
