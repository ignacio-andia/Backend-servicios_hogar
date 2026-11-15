import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FileDeletionService } from '../src/storage/file-deletion.service.js';
import { FileStorage } from '../src/storage/file-storage.js';

const NAMESPACE = 'e2e-file-deletion';

describe('FileDeletionService (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: FileStorage;
  let deletions: FileDeletionService;
  let storageDir: string;
  const keys: string[] = [];

  const saveFiles = async (count: number) => {
    const saved: string[] = [];
    for (let i = 0; i < count; i++) {
      saved.push(await storage.save(NAMESPACE, Buffer.from(`archivo ${i}`)));
    }
    keys.push(...saved);
    return saved;
  };
  const filesOnDisk = async () =>
    readdir(path.join(storageDir, NAMESPACE)).catch(() => [] as string[]);

  beforeAll(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'file-deletion-e2e-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(FileStorage);
    deletions = app.get(FileDeletionService);
  });

  afterAll(async () => {
    await prisma.pendingFileDeletion.deleteMany({
      where: { storageKey: { in: keys } },
    });
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.FILE_STORAGE_DIR;
  });

  it('encolar en una transaccion revertida no deja nada en la cola', async () => {
    const [key] = await saveFiles(1);

    await expect(
      prisma.$transaction(async (tx) => {
        await deletions.enqueue([key], 'prueba', tx);
        throw new Error('revertir');
      }),
    ).rejects.toThrow('revertir');

    expect(
      await prisma.pendingFileDeletion.count({ where: { storageKey: key } }),
    ).toBe(0);
    await deletions.deleteOrQueue([key], 'prueba');
  });

  it('con dos reintentos simultaneos, cada archivo se borra una sola vez', async () => {
    const saved = await saveFiles(6);
    await prisma.$transaction((tx) => deletions.enqueue(saved, 'prueba', tx));
    const deleteSpy = vi.spyOn(storage, 'delete');

    const [first, second] = await Promise.all([
      deletions.retryPending(),
      deletions.retryPending(),
    ]);

    const deletedKeys = deleteSpy.mock.calls
      .map(([key]) => key)
      .filter((key) => saved.includes(key));
    expect(deletedKeys.sort()).toEqual([...saved].sort());
    expect(first.deleted + second.deleted).toBeGreaterThanOrEqual(6);
    expect(
      await prisma.pendingFileDeletion.count({
        where: { storageKey: { in: saved } },
      }),
    ).toBe(0);
    expect(await filesOnDisk()).toEqual([]);
    deleteSpy.mockRestore();
  });

  it('si el almacenamiento falla, la clave queda en la cola con su error y se reprograma', async () => {
    const [key] = await saveFiles(1);
    await prisma.$transaction((tx) => deletions.enqueue([key], 'prueba', tx));
    const deleteSpy = vi
      .spyOn(storage, 'delete')
      .mockRejectedValueOnce(new Error('disco no disponible'));

    const result = await deletions.retryPending();
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const row = await prisma.pendingFileDeletion.findUniqueOrThrow({
      where: { storageKey: key },
    });
    expect(row).toMatchObject({
      attempts: 1,
      lastError: 'disco no disponible',
    });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Todavia no toca reintentar: no se vuelve a tomar.
    deleteSpy.mockClear();
    await deletions.retryPending();
    expect(deleteSpy).not.toHaveBeenCalledWith(key);

    // Cuando vence la espera, se borra.
    await prisma.pendingFileDeletion.update({
      where: { storageKey: key },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    deleteSpy.mockRestore();
    await deletions.retryPending();
    expect(
      await prisma.pendingFileDeletion.count({ where: { storageKey: key } }),
    ).toBe(0);
    expect(await filesOnDisk()).toEqual([]);
  });
});
