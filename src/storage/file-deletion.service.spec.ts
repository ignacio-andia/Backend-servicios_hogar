import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
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
    $transaction: ReturnType<typeof vi.fn>;
  };
  let notifications: { createForRole: ReturnType<typeof vi.fn> };
  let storage: { delete: ReturnType<typeof vi.fn> };
  let scheduler: SchedulerRegistry;
  let service: FileDeletionService;

  const create = (env: Record<string, string> = {}) =>
    new FileDeletionService(
      prisma as unknown as PrismaService,
      storage as unknown as FileStorage,
      new ConfigService(env),
      scheduler,
      notifications as unknown as NotificationsService,
    );

  beforeEach(() => {
    prisma = {
      pendingFileDeletion: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      // Escalamiento: transaccion interactiva con el mismo cliente.
      $transaction: vi.fn((work: (tx: unknown) => unknown) => work(prisma)),
    };
    notifications = { createForRole: vi.fn().mockResolvedValue(1) };
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
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0]).toContain('disco no disponible');
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
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { id: 'id-1', storageKey: 'a/1', attempts: 1 },
        { id: 'id-2', storageKey: 'a/2', attempts: 3 },
      ])
      .mockResolvedValueOnce([{ id: 'id-2', attempts: 3, escalated: false }]);
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
    expect(prisma.$queryRaw.mock.calls[1]).toContain(20);
    // Por debajo del umbral no se escala.
    expect(notifications.createForRole).not.toHaveBeenCalled();
  });

  it('al arrancar reintenta enseguida y luego cada 5 minutos, solo si las tareas estan activas (T5.4)', async () => {
    vi.useFakeTimers();
    try {
      create({ SCHEDULED_JOBS_ENABLED: 'false' }).onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();

      service.onApplicationBootstrap();
      expect(scheduler.getIntervals()).toEqual(['file-deletion-retry']);
      // Recuperacion tras un reinicio: pasada inmediata.
      await vi.advanceTimersByTimeAsync(0);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('escalamiento de fallos persistentes (T5.4)', () => {
    const failAt = (attempts: number, escalated = false) => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'id-9', storageKey: 'a/9', attempts }])
        .mockResolvedValueOnce([{ id: 'id-9', attempts, escalated }]);
      storage.delete.mockRejectedValueOnce(new Error('permiso denegado'));
    };

    it('al llegar a 10 intentos marca escalated_at y avisa a los administradores, una vez', async () => {
      failAt(10);
      prisma.$queryRaw.mockResolvedValueOnce([
        { storageKey: 'a/9', reason: 'vencimiento-pedido', attempts: 10 },
      ]);

      await service.retryPending();

      const escalation = (prisma.$queryRaw.mock.calls[2][0] as string[]).join(
        '?',
      );
      expect(escalation).toContain('"escalated_at" = now()');
      expect(escalation).toContain('"escalated_at" IS NULL');
      expect(notifications.createForRole).toHaveBeenCalledWith(
        'ADMINISTRADOR',
        {
          type: 'BORRADO_ARCHIVO_ESCALADO',
          title: 'Archivo pendiente de borrado',
          message:
            'Un archivo privado no se pudo borrar después de 10 intentos (motivo: vencimiento-pedido). Se seguirá reintentando cada 6 horas. Clave: a/9.',
        },
        {},
        prisma,
      );
      // La fila no se borra: se sigue reintentando (espera maxima de 6 horas).
      expect(prisma.pendingFileDeletion.deleteMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw.mock.calls[1]).toContain(360);
    });

    it('si otra instancia ya escalo, no repite el aviso', async () => {
      failAt(10);
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await service.retryPending();

      expect(notifications.createForRole).not.toHaveBeenCalled();
    });

    it('una clave ya escalada sigue reintentandose sin nuevos avisos', async () => {
      failAt(14, true);

      await service.retryPending();

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(notifications.createForRole).not.toHaveBeenCalled();
    });

    it('con 9 intentos todavia no escala', async () => {
      failAt(9);

      await service.retryPending();

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
