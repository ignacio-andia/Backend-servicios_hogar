import { NotFoundException } from '@nestjs/common';
import { OpenNegotiationRegistry } from './open-negotiation.registry.js';
import { OrderVisibilityService } from './order-visibility.service.js';

// RF-13: con un cambio de zona pendiente solo se muestran los pedidos que el
// trabajador ya esta negociando.

const NOW = new Date('2026-11-25T12:00:00.000Z');
const worker = {
  profileId: 'perfil',
  userId: 'trabajador',
  zoneId: 'zona',
  categoryIds: ['categoria'],
};

function setup({ pending }: { pending: boolean }) {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ now: NOW }]),
    $transaction: vi.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
    order: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
  const catalogs = {
    findByIds: vi.fn((_kind: unknown, ids: string[]) =>
      Promise.resolve(ids.map((id) => ({ id, name: id, isActive: true }))),
    ),
  };
  const workerProfiles = {
    hasPendingZoneChange: vi.fn().mockResolvedValue(pending),
  };
  const negotiations = new OpenNegotiationRegistry();
  const findOpenOrderIds = vi.fn().mockResolvedValue(['en-negociacion']);
  negotiations.register({
    hasOpenNegotiation: () => Promise.resolve(false),
    findOpenOrderIds,
  });
  const images = { open: vi.fn() };
  const service = new OrderVisibilityService(
    prisma as never,
    catalogs as never,
    images as never,
    workerProfiles as never,
    negotiations,
  );
  const list = () => service.listAvailable(worker, { page: 1, limit: 20 });
  return { service, prisma, workerProfiles, findOpenOrderIds, images, list };
}

const limited = JSON.stringify({ id: { in: ['en-negociacion'] } });

describe('OrderVisibilityService con un cambio de zona (RF-13)', () => {
  it('sin solicitud pendiente muestra lo visible, sin consultar negociaciones', async () => {
    const { list, prisma, workerProfiles, findOpenOrderIds } = setup({
      pending: false,
    });

    await list();

    expect(workerProfiles.hasPendingZoneChange).toHaveBeenCalledWith('perfil');
    expect(findOpenOrderIds).not.toHaveBeenCalled();
    expect(JSON.stringify(prisma.order.findMany.mock.calls[0])).not.toContain(
      limited,
    );
  });

  it('con una pendiente limita listado y total a las negociaciones abiertas', async () => {
    const { list, prisma, findOpenOrderIds } = setup({ pending: true });

    await list();

    expect(findOpenOrderIds).toHaveBeenCalledWith(prisma, 'trabajador');
    for (const query of [prisma.order.findMany, prisma.order.count]) {
      expect(JSON.stringify(query.mock.calls[0])).toContain(limited);
    }
  });

  it('aplica el mismo limite al detalle y a las fotos (404, sin abrir la foto)', async () => {
    const { service, prisma, images } = setup({ pending: true });

    await expect(
      service.openAvailableImage(worker, 'otro', 'foto', 'full'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(JSON.stringify(prisma.order.findFirst.mock.calls[0])).toContain(
      limited,
    );
    expect(images.open).not.toHaveBeenCalled();
  });
});
