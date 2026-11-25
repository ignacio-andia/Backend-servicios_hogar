import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AgendaModule } from './modules/agenda/agenda.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogsModule } from './modules/catalogs/catalogs.module.js';
import { ClaimsModule } from './modules/claims/claims.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OffersModule } from './modules/offers/offers.module.js';
import { OrderNotificationsModule } from './modules/order-notifications/order-notifications.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { ServiceWorkflowModule } from './modules/service-workflow/service-workflow.module.js';
import { TimelineModule } from './modules/timeline/timeline.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { WorkerProfileModule } from './modules/worker-profile/worker-profile.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Tareas programadas (vencimiento de pedidos, reintentos de borrado).
    ScheduleModule.forRoot(),
    UsersModule,
    AuthModule,
    AuditModule,
    NotificationsModule,
    CatalogsModule,
    WorkerProfileModule,
    OrdersModule,
    OffersModule,
    // Ciclo de vida del trabajo, reclamos, pagos, calificaciones, seguimiento,
    // avisos y agenda. Se comunican por servicios exportados y registros de
    // hooks; ningun modulo anterior los importa (sin ciclos).
    ServiceWorkflowModule,
    ClaimsModule,
    PaymentsModule,
    ReviewsModule,
    TimelineModule,
    OrderNotificationsModule,
    AgendaModule,
    ReportsModule,
  ],
})
export class AppModule {}
