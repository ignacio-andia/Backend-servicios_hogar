import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { StorageModule } from '../../storage/storage.module.js';
import { OrdersConfig } from '../orders/orders.config.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ServiceWorkflowModule } from '../service-workflow/service-workflow.module.js';
import { ClaimsInvariantHooks } from './claims-invariants.hooks.js';
import { ClaimImagesService } from './claim-images.service.js';
import {
  CLAIM_IMAGES_TECHNICAL_CEILING,
  ClaimsConfig,
} from './claims.config.js';
import { ClaimsController } from './claims.controller.js';
import { ClaimsService } from './claims.service.js';

/**
 * Reclamos del cliente y decision del administrador (RF-37, RF-38). Usa
 * servicios publicos de OrdersModule (transition, procesamiento de fotos) y de
 * ServiceWorkflowModule (plazo de conformidad, hooks). Ninguno lo importa: no
 * hay ciclos.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    OrdersModule,
    ServiceWorkflowModule,
    // Fotos en memoria con el peso maximo por archivo de los pedidos
    // (ORDER_IMAGE_MAX_MB); la cantidad la valida ClaimsService (configurable).
    MulterModule.registerAsync({
      imports: [OrdersModule],
      inject: [OrdersConfig, ConfigService],
      useFactory: (orders: OrdersConfig) => ({
        limits: {
          fileSize: orders.imageMaxBytes,
          files: CLAIM_IMAGES_TECHNICAL_CEILING + 1,
          fields: 20,
        },
      }),
    }),
  ],
  controllers: [ClaimsController],
  providers: [
    ClaimsConfig,
    ClaimsService,
    ClaimImagesService,
    ClaimsInvariantHooks,
  ],
})
export class ClaimsModule {}
