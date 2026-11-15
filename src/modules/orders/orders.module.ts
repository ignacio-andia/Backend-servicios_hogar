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
import { OrdersActiveWorkSource } from './orders-active-work.source.js';
import { OrdersConfig } from './orders.config.js';
import { OrdersController } from './orders.controller.js';
import { ABSOLUTE_MAX_IMAGES } from './orders.rules.js';
import { OrdersService } from './orders.service.js';
import { OrderVisibilityService } from './order-visibility.service.js';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    CatalogsModule,
    WorkerProfileModule,
    // Fotos en memoria con limite de peso por archivo: multer corta antes de
    // leer de mas. La cantidad real se valida en el servicio.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        limits: {
          fileSize: new OrdersConfig(config).imageMaxBytes,
          files: ABSOLUTE_MAX_IMAGES,
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
    OrdersActiveWorkSource,
  ],
  exports: [OrdersService, OrderVisibilityService, OrderLifecycleRegistry],
})
export class OrdersModule {}
