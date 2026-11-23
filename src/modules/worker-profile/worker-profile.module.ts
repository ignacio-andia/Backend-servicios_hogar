import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { StorageModule } from '../../storage/storage.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogsModule } from '../catalogs/catalogs.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';
import { ZoneRequestsAccountSuspensionHook } from './account-suspension.hook.js';
import { WorkerActiveWorkRegistry } from './active-work.registry.js';
import { ApprovedWorkerGuard } from './approved-worker.guard.js';
import { documentMaxBytes } from './document-file.js';
import { DocumentTooLargeFilter } from './document-too-large.filter.js';
import { WorkerDocumentsService } from './worker-documents.service.js';
import { WorkerProfileController } from './worker-profile.controller.js';
import { WorkerProfileService } from './worker-profile.service.js';
import { ZoneChangeRequestsService } from './zone-change-requests.service.js';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    CatalogsModule,
    AuditModule,
    NotificationsModule,
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
    ZoneChangeRequestsService,
    // T4-F3: cancela la solicitud de zona pendiente al suspender la cuenta.
    ZoneRequestsAccountSuspensionHook,
    WorkerActiveWorkRegistry,
    DocumentTooLargeFilter,
    ApprovedWorkerGuard,
  ],
  // WorkerActiveWorkRegistry se exporta para que los modulos de pedidos y
  // ofertas registren su consulta de trabajo activo (RF-13).
  exports: [
    WorkerProfileService,
    WorkerDocumentsService,
    ZoneChangeRequestsService,
    WorkerActiveWorkRegistry,
    ApprovedWorkerGuard,
  ],
})
export class WorkerProfileModule {}
