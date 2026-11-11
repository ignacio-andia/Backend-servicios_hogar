import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CatalogsController } from './catalogs.controller.js';
import { CatalogsService } from './catalogs.service.js';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [CatalogsController],
  providers: [CatalogsService],
  exports: [CatalogsService],
})
export class CatalogsModule {}
