import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OffersModule } from '../offers/offers.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { AgendaController } from './agenda.controller.js';
import { AgendaService } from './agenda.service.js';

/**
 * Agenda del trabajador (RF-29 a RF-31): consulta del horario semanal y de los
 * trabajos acordados, y comprobacion de un horario. Solo lectura: reutiliza
 * WorkerProfileModule, OffersModule y OrdersModule y no cambia las reglas de
 * aceptacion de ofertas ni de cruces. Ninguno lo importa: no hay ciclos.
 */
@Module({
  imports: [PrismaModule, OrdersModule, OffersModule, WorkerProfileModule],
  controllers: [AgendaController],
  providers: [AgendaService],
})
export class AgendaModule {}
