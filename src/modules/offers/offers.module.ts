import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';

/**
 * Ofertas y negociacion (RF-19 a RF-24). T6.1: solo el modelo de datos y la
 * estructura. Las etapas siguientes agregan el servicio, el controlador, los
 * hooks de OrderLifecycleRegistry y la fuente OFERTAS, importando
 * OrdersModule, WorkerProfileModule, CatalogsModule y NotificationsModule.
 * Ninguno de ellos importa este modulo: no hay ciclos.
 */
@Module({
  imports: [PrismaModule],
})
export class OffersModule {}
