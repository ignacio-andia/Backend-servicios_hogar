import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Prisma } from '../generated/prisma/client.js';
import {
  readPositiveInt,
  scheduledJobsEnabled,
} from '../common/config-values.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FileStorage } from './file-storage.js';

const RETRY_INTERVAL_NAME = 'file-deletion-retry';
const DEFAULT_RETRY_INTERVAL_MINUTES = 5;
const RETRY_BATCH_SIZE = 50;
// Mientras una instancia procesa una clave, las demas no la toman.
const LEASE_MINUTES = 10;
const BASE_BACKOFF_MINUTES = 5;
const MAX_BACKOFF_MINUTES = 360;
const MAX_ERROR_LENGTH = 500;

interface ClaimedDeletion {
  id: string;
  storageKey: string;
  attempts: number;
}

export interface RetryResult {
  deleted: number;
  failed: number;
}

/**
 * Cola compartida de borrado de archivos privados (pedidos, documentos).
 * Regla: primero la BD deja de apuntar al archivo y encola su clave en la
 * misma transaccion; despues de confirmar se borra el archivo. Si el
 * almacenamiento falla, la clave queda en la cola y se reintenta. Borrar es
 * idempotente, asi que un reintento repetido no causa problemas.
 */
@Injectable()
export class FileDeletionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(FileDeletionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!scheduledJobsEnabled(this.config)) {
      return;
    }
    const minutes = readPositiveInt(
      this.config,
      'FILE_DELETION_RETRY_INTERVAL_MINUTES',
      DEFAULT_RETRY_INTERVAL_MINUTES,
      { max: 1440 },
    );
    this.scheduler.addInterval(
      RETRY_INTERVAL_NAME,
      setInterval(() => void this.runScheduledRetry(), minutes * 60_000),
    );
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', RETRY_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(RETRY_INTERVAL_NAME);
    }
  }

  /** Encola claves dentro de la transaccion que deja de apuntar a ellas. */
  async enqueue(
    storageKeys: string[],
    reason: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (storageKeys.length === 0) {
      return;
    }
    await tx.pendingFileDeletion.createMany({
      data: storageKeys.map((storageKey) => ({ storageKey, reason })),
      skipDuplicates: true,
    });
  }

  /**
   * Despues de confirmar: intenta borrar ya. Nunca lanza; lo que falle queda
   * en la cola para el reintento programado.
   */
  async processNow(storageKeys: string[]): Promise<void> {
    for (const storageKey of storageKeys) {
      try {
        await this.storage.delete(storageKey);
        await this.prisma.pendingFileDeletion.deleteMany({
          where: { storageKey },
        });
      } catch (error) {
        await this.recordFailure({ storageKey }, error);
      }
    }
  }

  /**
   * Para compensar fuera de una transaccion (por ejemplo, un archivo guardado
   * cuyo registro en BD fallo): intenta borrar y, si no puede, lo encola.
   */
  async deleteOrQueue(storageKeys: string[], reason: string): Promise<void> {
    for (const storageKey of storageKeys) {
      try {
        await this.storage.delete(storageKey);
      } catch (error) {
        await this.prisma.pendingFileDeletion.createMany({
          data: [{ storageKey, reason }],
          skipDuplicates: true,
        });
        await this.recordFailure({ storageKey }, error);
      }
    }
  }

  /**
   * Toma un lote de claves vencidas con FOR UPDATE SKIP LOCKED y les da una
   * reserva: si hay varias instancias, cada clave la procesa una sola.
   */
  async retryPending(batchSize = RETRY_BATCH_SIZE): Promise<RetryResult> {
    const claimed = await this.prisma.$queryRaw<ClaimedDeletion[]>`
      UPDATE "pending_file_deletions"
      SET "attempts" = "attempts" + 1,
          "next_attempt_at" = now() + make_interval(mins => ${LEASE_MINUTES}::int)
      WHERE "id" IN (
        SELECT "id" FROM "pending_file_deletions"
        WHERE "next_attempt_at" <= now()
        ORDER BY "next_attempt_at"
        LIMIT ${batchSize}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "storage_key" AS "storageKey", "attempts"`;

    const result: RetryResult = { deleted: 0, failed: 0 };
    for (const item of claimed) {
      try {
        await this.storage.delete(item.storageKey);
        await this.prisma.pendingFileDeletion.deleteMany({
          where: { id: item.id },
        });
        result.deleted += 1;
      } catch (error) {
        await this.recordFailure({ id: item.id }, error, item.attempts);
        result.failed += 1;
      }
    }
    return result;
  }

  private async runScheduledRetry(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const { deleted, failed } = await this.retryPending();
      if (failed > 0) {
        this.logger.warn(
          `Borrado de archivos: ${deleted} eliminados, ${failed} siguen pendientes`,
        );
      }
    } catch (error) {
      this.logger.error('Fallo el reintento de borrado de archivos', error);
    } finally {
      this.running = false;
    }
  }

  /** Guarda el error y programa el proximo intento con espera creciente. */
  private async recordFailure(
    target: { id: string } | { storageKey: string },
    error: unknown,
    attempts?: number,
  ): Promise<void> {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, MAX_ERROR_LENGTH);
    const minutes = Math.min(
      BASE_BACKOFF_MINUTES * 2 ** Math.max((attempts ?? 1) - 1, 0),
      MAX_BACKOFF_MINUTES,
    );
    try {
      if ('id' in target) {
        // El reintento programado ya sumo el intento al reservar la clave.
        await this.prisma.$executeRaw`
          UPDATE "pending_file_deletions"
          SET "last_error" = ${message},
              "next_attempt_at" = now() + make_interval(mins => ${minutes}::int)
          WHERE "id" = ${target.id}::uuid`;
      } else {
        await this.prisma.$executeRaw`
          UPDATE "pending_file_deletions"
          SET "last_error" = ${message},
              "attempts" = "attempts" + 1,
              "next_attempt_at" = now() + make_interval(mins => ${minutes}::int)
          WHERE "storage_key" = ${target.storageKey}`;
      }
    } catch (updateError) {
      this.logger.error(
        'No se pudo registrar el fallo de borrado',
        updateError,
      );
    }
  }
}
