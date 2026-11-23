import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { OffersController } from './offers.controller.js';
import { OffersService } from './offers.service.js';

/**
 * Ofertas y negociacion (RF-19 a RF-24). T6.2: creacion y consultas.
 * Usa los servicios publicos de OrdersModule (visibilidad y bloqueo del
 * pedido) y WorkerProfileModule (ApprovedWorkerGuard). Ninguno de ellos
 * importa este modulo: no hay ciclos. La fuente OFERTAS de
 * WorkerActiveWorkRegistry no se registra (no debe habilitar cambios de zona).
 */
@Module({
  imports: [PrismaModule, OrdersModule, WorkerProfileModule],
  controllers: [OffersController],
  providers: [OffersService],
  exports: [OffersService],
})
export class OffersModule {}
