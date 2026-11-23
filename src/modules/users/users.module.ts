import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AccountStatusRegistry } from './account-status.registry.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [UsersController],
  providers: [UsersService, AccountStatusRegistry],
  // AccountStatusRegistry: otros modulos registran efectos de la suspension.
  exports: [UsersService, AccountStatusRegistry],
})
export class UsersModule {}
