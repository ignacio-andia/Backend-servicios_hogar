import { Module } from '@nestjs/common';
import { FileStorage } from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';

// Para cambiar de proveedor (por ejemplo S3) basta con otra clase que
// extienda FileStorage y registrarla aqui con useClass.
@Module({
  providers: [{ provide: FileStorage, useClass: LocalFileStorage }],
  exports: [FileStorage],
})
export class StorageModule {}
