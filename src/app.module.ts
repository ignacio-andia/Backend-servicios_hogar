import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogsModule } from './modules/catalogs/catalogs.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { WorkerProfileModule } from './modules/worker-profile/worker-profile.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    UsersModule,
    AuthModule,
    AuditModule,
    CatalogsModule,
    WorkerProfileModule,
  ],
})
export class AppModule {}
