import { BadRequestException } from '@nestjs/common';
import { AuditAction, AuditEntityType } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';

const ADMIN_ID = '8f1c2a8e-5a2b-4c3d-9e4f-1a2b3c4d5e6f';

describe('AuditService', () => {
  let prisma: {
    adminAuditLog: Record<
      'create' | 'findMany' | 'count',
      ReturnType<typeof vi.fn>
    >;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: AuditService;

  beforeEach(() => {
    prisma = {
      adminAuditLog: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      $transaction: vi.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
    };
    service = new AuditService(prisma as unknown as PrismaService);
  });

  const whereOf = () => prisma.adminAuditLog.findMany.mock.calls[0][0].where;

  it('record usa el cliente de la transacción recibida', async () => {
    const tx = { adminAuditLog: { create: vi.fn() } };
    const entry = {
      actorId: ADMIN_ID,
      action: AuditAction.CREACION,
      entityType: AuditEntityType.ZONA,
      entityId: ADMIN_ID,
    };

    await service.record(entry, tx as never);

    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({ data: entry });
    expect(prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('combina los filtros y pagina', async () => {
    prisma.adminAuditLog.count.mockResolvedValue(45);

    const result = await service.findAll({
      entityType: AuditEntityType.ZONA,
      action: AuditAction.DESACTIVACION,
      actorId: ADMIN_ID,
      page: 3,
      limit: 20,
    });

    expect(prisma.adminAuditLog.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        entityType: AuditEntityType.ZONA,
        action: AuditAction.DESACTIVACION,
        actorId: ADMIN_ID,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 40,
      take: 20,
    });
    expect(whereOf()).not.toHaveProperty('createdAt');
    expect(result.meta).toEqual({
      page: 3,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });

  it('no selecciona datos sensibles del administrador', async () => {
    await service.findAll({ page: 1, limit: 20 });

    const { select } = prisma.adminAuditLog.findMany.mock.calls[0][0];
    expect(Object.keys(select.actor.select).sort()).toEqual([
      'email',
      'firstName',
      'id',
      'lastName',
    ]);
  });

  it('una fecha final sin hora incluye todo ese día', async () => {
    await service.findAll({
      from: '2026-11-01',
      to: '2026-11-10',
      page: 1,
      limit: 20,
    });

    expect(whereOf().createdAt).toEqual({
      gte: new Date('2026-11-01T00:00:00.000Z'),
      lt: new Date('2026-11-11T00:00:00.000Z'),
    });
  });

  it('una fecha final con hora es inclusiva', async () => {
    await service.findAll({
      to: '2026-11-10T15:30:00Z',
      page: 1,
      limit: 20,
    });

    expect(whereOf().createdAt).toEqual({
      lte: new Date('2026-11-10T15:30:00.000Z'),
    });
  });

  it('rechaza un intervalo invertido sin consultar', async () => {
    await expect(
      service.findAll({
        from: '2026-11-10',
        to: '2026-11-01',
        page: 1,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.adminAuditLog.findMany).not.toHaveBeenCalled();
  });
});
