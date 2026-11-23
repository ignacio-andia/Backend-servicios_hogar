import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { StorageModule } from '../../storage/storage.module.js';
import { CatalogsModule } from '../catalogs/catalogs.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { OrderImageProcessor } from './images/order-image.processor.js';
import { OrderImagesService } from './images/order-images.service.js';
import { OrderExpirationService } from './order-expiration.service.js';
import { OrderImageTooLargeFilter } from './order-image-too-large.filter.js';
import { OrderLifecycleRegistry } from './order-lifecycle.registry.js';
import { OrderRetentionService } from './order-retention.service.js';
import { OrdersActiveWorkSource } from './orders-active-work.source.js';
import { OrdersConfig } from './orders.config.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrderVisibilityService } from './order-visibility.service.js';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    CatalogsModule,
    WorkerProfileModule,
    // Fotos en memoria con limite de peso por archivo: multer corta antes de
    // leer de mas. Admite una foto mas que el maximo configurado para que el
    // servicio responda con su mensaje (T5.3); con mas, multer corta (400)
    // sin cargar el resto en memoria.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        limits: {
          fileSize: new OrdersConfig(config).imageMaxBytes,
          files: new OrdersConfig(config).maxImages + 1,
          fields: 20,
        },
      }),
    }),
  ],
  controllers: [OrdersController],
  providers: [
    OrdersConfig,
    OrdersService,
    OrderVisibilityService,
    OrderImagesService,
    OrderImageProcessor,
    OrderImageTooLargeFilter,
    OrderLifecycleRegistry,
    OrderExpirationService,
    OrderRetentionService,
    OrdersActiveWorkSource,
  ],
  exports: [OrdersService, OrderVisibilityService, OrderLifecycleRegistry],
})
export class OrdersModule {}
