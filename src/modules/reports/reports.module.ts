import { Module } from '@nestjs/common';
import { CatalogsModule } from '../catalogs/catalogs.module.js';
import { ClaimsModule } from '../claims/claims.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { WorkerProfileModule } from '../worker-profile/worker-profile.module.js';
import { FinancialReportConfig } from './financial-report.config.js';
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
    PaymentsModule,
    ReviewsModule,
    WorkerProfileModule,
  ],
  controllers: [ReportsController],
  providers: [FinancialReportConfig, ReportsService],
})
export class ReportsModule {}
