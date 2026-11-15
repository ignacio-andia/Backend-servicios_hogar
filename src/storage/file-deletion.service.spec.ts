import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { FileDeletionService } from './file-deletion.service.js';
import { FileStorage } from './file-storage.js';

describe('FileDeletionService', () => {
  let prisma: {
    pendingFileDeletion: Record<
      'createMany' | 'deleteMany',
      ReturnType<typeof vi.fn>
    >;
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };
  let storage: { delete: ReturnType<typeof vi.fn> };
  let scheduler: SchedulerRegistry;
  let service: FileDeletionService;

  const create = (env: Record<string, string> = {}) =>
    new FileDeletionService(
      prisma as unknown as PrismaService,
      storage as unknown as FileStorage,
      new ConfigService(env),
      scheduler,
    );

  beforeEach(() => {
    prisma = {
      pendingFileDeletion: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    storage = { delete: vi.fn().mockResolvedValue(undefined) };
    scheduler = new SchedulerRegistry();
    service = create();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('enqueue usa la transaccion recibida y no duplica claves', async () => {
    const tx = { pendingFileDeletion: { createMany: vi.fn() } };

    await service.enqueue(['a/1', 'a/2'], 'cancelacion', tx as never);

    expect(tx.pendingFileDeletion.createMany).toHaveBeenCalledWith({
      data: [
        { storageKey: 'a/1', reason: 'cancelacion' },
        { storageKey: 'a/2', reason: 'cancelacion' },
      ],
      skipDuplicates: true,
    });
    expect(prisma.pendingFileDeletion.createMany).not.toHaveBeenCalled();
  });

  it('processNow borra y saca de la cola; si falla, registra el error sin lanzar', async () => {
    storage.delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('disco no disponible'));

    await expect(service.processNow(['a/1', 'a/2'])).resolves.toBeUndefined();

    expect(prisma.pendingFileDeletion.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.pendingFileDeletion.deleteMany).toHaveBeenCalledWith({
      where: { storageKey: 'a/1' },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0]).toContain('disco no disponible');
  });

  it('deleteOrQueue solo encola lo que no pudo borrar', async () => {
    storage.delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('falla'));

    await service.deleteOrQueue(['a/1', 'a/2'], 'compensacion');

    expect(prisma.pendingFileDeletion.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.pendingFileDeletion.createMany).toHaveBeenCalledWith({
      data: [{ storageKey: 'a/2', reason: 'compensacion' }],
      skipDuplicates: true,
    });
  });

  it('retryPending reserva con SKIP LOCKED, borra lo posible y reprograma lo demas', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'id-1', storageKey: 'a/1', attempts: 1 },
      { id: 'id-2', storageKey: 'a/2', attempts: 3 },
    ]);
    storage.delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('falla'));

    await expect(service.retryPending()).resolves.toEqual({
      deleted: 1,
      failed: 1,
    });

    const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(prisma.pendingFileDeletion.deleteMany).toHaveBeenCalledWith({
      where: { id: 'id-1' },
    });
    // Tercer intento: espera 5 * 2^2 = 20 minutos.
    expect(prisma.$executeRaw.mock.calls[0]).toContain(20);
  });

  it('programa el reintento cada 5 minutos solo si las tareas estan activas', () => {
    vi.useFakeTimers();
    try {
      create({ SCHEDULED_JOBS_ENABLED: 'false' }).onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual([]);

      service.onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual(['file-deletion-retry']);

      vi.advanceTimersByTime(5 * 60_000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
