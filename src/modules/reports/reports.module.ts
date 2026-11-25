import { Module } from '@nestjs/common';
import { CatalogsModule } from '../catalogs/catalogs.module.js';
import { ClaimsModule } from '../claims/claims.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * Reportes administrativos (RF-52). Solo usa consultas de lectura publicas de
 * los modulos duenos de cada dato; ninguno lo importa: no hay ciclos.
 */
@Module({
  imports: [
    CatalogsModule,
    ClaimsModule,
    OrdersModule,
    ReviewsModule,
    WorkerProfileModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
