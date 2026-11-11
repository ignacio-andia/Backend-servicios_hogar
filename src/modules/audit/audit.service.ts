import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AuditAction,
  AuditEntityType,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto.js';

export interface AuditEntry {
  actorId: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  details?: Prisma.InputJsonValue;
}

const AUDIT_LOG_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  details: true,
  createdAt: true,
  actor: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.AdminAuditLogSelect;

export type AuditLogView = Prisma.AdminAuditLogGetPayload<{
  select: typeof AUDIT_LOG_SELECT;
}>;

export interface PaginatedAuditLogs {
  data: AuditLogView[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bitácora de acciones administrativas (RF-53). Solo se inserta y se
 * consulta: la base de datos rechaza UPDATE, DELETE y TRUNCATE sobre la tabla.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Para que una acción no quede sin registro, pásale el cliente de la
   * transacción de esa acción: si el registro falla, la acción se revierte.
   */
  async record(
    entry: AuditEntry,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.adminAuditLog.create({ data: entry });
  }

  async findAll(query: ListAuditLogsQueryDto): Promise<PaginatedAuditLogs> {
    const { page, limit } = query;
    const where = buildWhere(query);

    const [data, total] = await this.prisma.$transaction([
      this.prisma.adminAuditLog.findMany({
        where,
        select: AUDIT_LOG_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}

function buildWhere({
  entityType,
  action,
  actorId,
  entityId,
  from,
  to,
}: ListAuditLogsQueryDto): Prisma.AdminAuditLogWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (from) {
    createdAt.gte = new Date(from);
  }
  if (to) {
    if (DATE_ONLY.test(to)) {
      createdAt.lt = new Date(new Date(to).getTime() + ONE_DAY_MS);
    } else {
      createdAt.lte = new Date(to);
    }
  }
  const end = createdAt.lt ?? createdAt.lte;
  if (createdAt.gte && end && createdAt.gte > end) {
    throw new BadRequestException(
      'La fecha inicial no puede ser posterior a la final',
    );
  }

  return {
    entityType,
    action,
    actorId,
    entityId,
    ...(from || to ? { createdAt } : {}),
  };
}
