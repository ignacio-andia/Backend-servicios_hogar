import { Module } from '@nestjs/common';
import { NotificationsModule } from '../modules/notifications/notifications.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FileDeletionService } from './file-deletion.service.js';
import { FileStorage } from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';

// Para cambiar de proveedor (por ejemplo S3) basta con otra clase que
// extienda FileStorage y registrarla aqui con useClass. FileDeletionService
// es la unica cola de borrado del proyecto (pedidos y documentos).
// NotificationsModule: aviso a los administradores de borrados que siguen
// fallando (T5.4). Solo depende de Prisma: no crea ciclos.
@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [
    { provide: FileStorage, useClass: LocalFileStorage },
    FileDeletionService,
  ],
  exports: [FileStorage, FileDeletionService],
})
export class StorageModule {}
