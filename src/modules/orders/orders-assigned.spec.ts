import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CatalogsService } from '../catalogs/catalogs.service.js';
import type { OrderImagesService } from './images/order-images.service.js';
import { OrdersService } from './orders.service.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');

describe('OrdersService: pedido del trabajador asignado (G2)', () => {
  let prisma: {
    order: { findFirst: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };
  let images: { open: ReturnType<typeof vi.fn> };
  let service: OrdersService;
  let workerProfiles: { assertWorkerApproved: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    workerProfiles = { assertWorkerApproved: vi.fn() };
    prisma = {
      order: { findFirst: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ now: NOW }]),
    };
    images = { open: vi.fn().mockResolvedValue({ stream: 'x' }) };
    const catalogs = {
      findByIds: vi.fn((_kind: string, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ id, name: id, isActive: true }))),
      ),
    };
    service = new OrdersService(
      prisma as unknown as PrismaService,
      catalogs as unknown as CatalogsService,
      images as unknown as OrderImagesService,
      {} as never,
      {} as never,
      {} as never,
      workerProfiles as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  const expectedWhere = {
    id: 'pedido-1',
    assignedWorkerId: 'trabajador-1',
    status: {
      in: [
        'ACORDADO',
        'ANTICIPO_REGISTRADO',
        'VISITA_REALIZADA',
        'PRESUPUESTO_ADICIONAL_PENDIENTE',
        'EN_EJECUCION',
        'TERMINADO',
        'EN_RECLAMO',
      ],
    },
  };

  it('solo encuentra el pedido asignado a ese trabajador con un acuerdo vigente', async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: 'pedido-1',
      categoryId: 'cat-1',
      zoneId: 'zona-1',
      description: 'Fuga de agua',
      budgetAmount: new Prisma.Decimal('150'),
      status: 'ACORDADO',
      revision: 1,
      publishedAt: NOW,
      expiresAt: NOW,
      lastEditedAt: null,
      images: [],
      address: { addressLine: 'Calle 1', reference: null },
      client: { firstName: 'Luis', lastName: 'Paz' },
    });

    const view = await service.getAssigned('trabajador-1', 'pedido-1');

    const query = prisma.order.findFirst.mock.calls[0][0];
    expect(query.where).toEqual(expectedWhere);
    // Nunca pide el correo ni el telefono del cliente.
    expect(query.select.client).toEqual({
      select: { firstName: true, lastName: true },
    });
    expect(view).toMatchObject({
      status: 'ACORDADO',
      address: { addressLine: 'Calle 1', reference: null },
      client: { firstName: 'Luis', lastName: 'Paz' },
      budgetAmount: '150.00',
    });
  });

  it('otro trabajador, sin acuerdo o cerrado: 404, y las fotos tampoco se abren', async () => {
    prisma.order.findFirst.mockResolvedValue(null);

    await expect(
      service.getAssigned('otro', 'pedido-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.openAssignedImage('otro', 'pedido-1', 'foto-1', 'full'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(images.open).not.toHaveBeenCalled();
  });

  it('un asignado sin el perfil aprobado recibe 403 y no se abre la foto', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'pedido-1' });
    workerProfiles.assertWorkerApproved.mockRejectedValue(
      new ForbiddenException('suspendido'),
    );

    await expect(
      service.getAssigned('trabajador-1', 'pedido-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.openAssignedImage('trabajador-1', 'pedido-1', 'foto-1', 'full'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(workerProfiles.assertWorkerApproved).toHaveBeenCalledWith(
      'trabajador-1',
    );
    expect(images.open).not.toHaveBeenCalled();
  });

  it('el asignado abre las fotos con las mismas reglas', async () => {
    prisma.order.findFirst.mockResolvedValue({ id: 'pedido-1' });

    await service.openAssignedImage(
      'trabajador-1',
      'pedido-1',
      'foto-1',
      'thumb',
    );

    expect(prisma.order.findFirst.mock.calls[0][0].where).toEqual(
      expectedWhere,
    );
    expect(images.open).toHaveBeenCalledWith('pedido-1', 'foto-1', 'thumb');
  });
});
