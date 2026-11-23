import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogsModule } from './modules/catalogs/catalogs.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OffersModule } from './modules/offers/offers.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
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
  ],
})
export class AppModule {}
