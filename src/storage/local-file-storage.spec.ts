import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { LocalFileStorage, resolveBaseDir } from './local-file-storage.js';

describe('LocalFileStorage', () => {
  let dir: string;
  let storage: LocalFileStorage;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'storage-spec-'));
    storage = new LocalFileStorage(
      new ConfigService({ FILE_STORAGE_DIR: dir }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('guarda con una clave aleatoria y lee el contenido', async () => {
    const key = await storage.save('worker-documents', Buffer.from('hola'));

    expect(key).toMatch(/^worker-documents\/[0-9a-f-]{36}$/);
    expect(await text(await storage.read(key))).toBe('hola');
    expect(await readdir(path.join(dir, 'worker-documents'))).toHaveLength(1);
  });

  it('elimina archivos y responde 404 si ya no existen', async () => {
    const key = await storage.save('worker-documents', Buffer.from('x'));
    await storage.delete(key);

    await expect(storage.read(key)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['../../etc/passwd', 'worker-documents/../../x', 'a/b', '/abs/path'])(
    'rechaza claves que podrian salir de la carpeta: %s',
    async (key) => {
      await expect(storage.read(key)).rejects.toThrow(
        /Clave de almacenamiento/,
      );
    },
  );

  it('rechaza espacios con caracteres de ruta', async () => {
    await expect(storage.save('../fuera', Buffer.from('x'))).rejects.toThrow(
      /Espacio de almacenamiento invalido/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'crea los archivos solo legibles por el proceso',
    async () => {
      const key = await storage.save('worker-documents', Buffer.from('x'));
      const { mode } = await stat(path.join(dir, key));
      expect(mode & 0o777).toBe(0o600);
    },
  );

  it.each(['src/uploads', 'public', 'dist/files'])(
    'no permite una carpeta publica o de codigo: %s',
    (folder) => {
      expect(() => resolveBaseDir(folder)).toThrow(/FILE_STORAGE_DIR/);
    },
  );
});
