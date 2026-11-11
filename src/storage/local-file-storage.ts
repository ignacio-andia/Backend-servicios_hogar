import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { FileStorage } from './file-storage.js';

export const DEFAULT_FILE_STORAGE_DIR = 'storage/private';

const NAMESPACE_PATTERN = /^[a-z0-9-]+$/;
const KEY_PATTERN =
  /^[a-z0-9-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORBIDDEN_ROOTS = ['src', 'public', 'dist'];

/**
 * Almacenamiento en disco para desarrollo. La carpeta se configura con
 * FILE_STORAGE_DIR (por defecto storage/private) y no puede estar dentro de
 * src, public ni dist, para que nunca se sirva como archivo estatico.
 */
@Injectable()
export class LocalFileStorage extends FileStorage {
  private readonly baseDir: string;

  constructor(config: ConfigService) {
    super();
    this.baseDir = resolveBaseDir(
      config.get<string>('FILE_STORAGE_DIR', DEFAULT_FILE_STORAGE_DIR),
    );
  }

  async save(namespace: string, content: Buffer): Promise<string> {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new Error(`Espacio de almacenamiento invalido: ${namespace}`);
    }
    const key = `${namespace}/${randomUUID()}`;
    const filePath = this.pathFor(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    // 'wx' evita sobrescribir; 0o600 deja el archivo solo para el proceso.
    await writeFile(filePath, content, { flag: 'wx', mode: 0o600 });
    return key;
  }

  async read(key: string): Promise<Readable> {
    const filePath = this.pathFor(key);
    try {
      await access(filePath);
    } catch {
      throw new NotFoundException('El archivo no esta disponible');
    }
    return createReadStream(filePath);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new Error('Clave de almacenamiento invalida');
    }
    const filePath = path.resolve(this.baseDir, key);
    if (!filePath.startsWith(this.baseDir + path.sep)) {
      throw new Error('Clave de almacenamiento fuera de la carpeta permitida');
    }
    return filePath;
  }
}

export function resolveBaseDir(dir: string): string {
  const projectRoot = process.cwd();
  const baseDir = path.resolve(projectRoot, dir);
  for (const root of FORBIDDEN_ROOTS) {
    const forbidden = path.resolve(projectRoot, root);
    if (baseDir === forbidden || baseDir.startsWith(forbidden + path.sep)) {
      throw new Error(
        `FILE_STORAGE_DIR no puede estar dentro de ${root}/: los archivos deben ser privados`,
      );
    }
  }
  return baseDir;
}
