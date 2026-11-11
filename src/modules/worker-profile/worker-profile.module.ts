import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { StorageModule } from '../../storage/storage.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogsModule } from '../catalogs/catalogs.module.js';
import { UsersModule } from '../users/users.module.js';
import { ApprovedWorkerGuard } from './approved-worker.guard.js';
import { documentMaxBytes } from './document-file.js';
import { DocumentTooLargeFilter } from './document-too-large.filter.js';
import { WorkerDocumentsService } from './worker-documents.service.js';
import { WorkerProfileController } from './worker-profile.controller.js';
import { WorkerProfileService } from './worker-profile.service.js';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    CatalogsModule,
    AuditModule,
    StorageModule,
    // Archivos en memoria y con limite de tamano: multer corta la subida
    // antes de leer de mas. El almacenamiento definitivo es FileStorage.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        limits: {
          fileSize: documentMaxBytes(config),
          files: 1,
          fields: 5,
          parts: 6,
        },
      }),
    }),
  ],
  controllers: [WorkerProfileController],
  providers: [
    WorkerProfileService,
    WorkerDocumentsService,
    DocumentTooLargeFilter,
    ApprovedWorkerGuard,
  ],
  exports: [WorkerProfileService, WorkerDocumentsService, ApprovedWorkerGuard],
})
export class WorkerProfileModule {}
