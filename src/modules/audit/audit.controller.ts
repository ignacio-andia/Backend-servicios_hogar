import { Controller, Get, Query } from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import type { PaginatedAuditLogs } from './audit.service.js';
import { AuditService } from './audit.service.js';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto.js';

/** Solo lectura: la bitácora no se edita ni se elimina (RF-53). */
@Controller('audit-logs')
@Auth(RoleName.ADMINISTRADOR)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  findAll(@Query() query: ListAuditLogsQueryDto): Promise<PaginatedAuditLogs> {
    return this.auditService.findAll(query);
  }
}
