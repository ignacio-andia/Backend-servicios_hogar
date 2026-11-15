import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FileDeletionService } from './file-deletion.service.js';
import { FileStorage } from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';

// Para cambiar de proveedor (por ejemplo S3) basta con otra clase que
// extienda FileStorage y registrarla aqui con useClass. FileDeletionService
// es la unica cola de borrado del proyecto (pedidos y documentos).
@Module({
  imports: [PrismaModule],
  providers: [
    { provide: FileStorage, useClass: LocalFileStorage },
    FileDeletionService,
  ],
  exports: [FileStorage, FileDeletionService],
})
export class StorageModule {}
