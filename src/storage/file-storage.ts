import type { Readable } from 'node:stream';

/**
 * Almacenamiento privado de archivos. Los modulos solo conocen esta
 * abstraccion; el proveedor (disco local, S3, etc.) se elige en StorageModule.
 * Las claves las genera el almacenamiento y nunca se exponen por HTTP.
 */
export abstract class FileStorage {
  /** Guarda el contenido y devuelve la clave interna generada. */
  abstract save(namespace: string, content: Buffer): Promise<string>;

  /** Abre el archivo para enviarlo en una respuesta autorizada. */
  abstract read(key: string): Promise<Readable>;

  /** Elimina un archivo; se usa para compensar escrituras fallidas. */
  abstract delete(key: string): Promise<void>;
}
