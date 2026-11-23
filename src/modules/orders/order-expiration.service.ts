import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { scheduledJobsEnabled } from '../../common/config-values.js';
import { OrderStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OrderLifecycleEvent,
  OrderLifecycleRegistry,
} from './order-lifecycle.registry.js';
import { OrdersConfig } from './orders.config.js';
import {
  EXPIRATION_PROCESS,
  ORDER_EXPIRABLE_STATUSES,
} from './orders.rules.js';
import { isAllowedTransition } from './orders.service.js';

const EXPIRATION_INTERVAL_NAME = 'order-expiration';
// Lotes moderados: cada pedido usa su propio SAVEPOINT y varias sentencias.
const EXPIRATION_BATCH_SIZE = 50;
const EXPIRATION_TX_TIMEOUT_MS = 30_000;

/**
 * Marca VENCIDO los pedidos PUBLICADO o EN_NEGOCIACION cuyo plazo de 7 dias
 * paso (T5.1), con el reloj de la BD.
 *
 * No depende de que la tarea corra a tiempo: toda lectura y todo bloqueo del
 * pedido ya lo tratan como VENCIDO en cuanto pasa expires_at (estado
 * efectivo), asi que si la tarea se atrasa o el servidor se reinicia nadie
 * puede editarlo, ofertar ni cambiarle el estado; la tarea solo deja el
 * estado y el historial al dia. Al arrancar corre una primera pasada.
 *
 * Varias instancias pueden correr a la vez: cada lote toma sus filas con
 * FOR UPDATE SKIP LOCKED, asi que ningun pedido se vence dos veces. Cada
 * pedido se vence en su propio SAVEPOINT: un hook que falla no detiene al
 * resto. Un pedido bloqueado por otra operacion se toma en la siguiente
 * pasada. Las fotos de pedidos vencidos se conservan por ahora (su borrado
 * es una tarea aparte).
 */
@Injectable()
export class OrderExpirationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OrderExpirationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OrdersConfig,
    private readonly lifecycle: OrderLifecycleRegistry,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!scheduledJobsEnabled(this.config)) {
      return;
    }
    this.scheduler.addInterval(
      EXPIRATION_INTERVAL_NAME,
      setInterval(
        () => void this.runScheduled(),
        this.settings.expirationIntervalMinutes * 60_000,
      ),
    );
    // Tras un reinicio, los pedidos que vencieron mientras el servidor estaba
    // detenido se marcan enseguida, sin esperar el primer intervalo.
    void this.runScheduled();
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', EXPIRATION_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(EXPIRATION_INTERVAL_NAME);
    }
  }

  /**
   * Vence todos los pedidos atrasados, por lotes. Devuelve cuantos vencio.
   * Un pedido cuyo hook falla se salta en el resto de esta pasada (asi no
   * bloquea a los demas) y se reintenta en la siguiente.
   */
  async expireDue(batchSize = EXPIRATION_BATCH_SIZE): Promise<number> {
    let total = 0;
    const failed: string[] = [];
    for (;;) {
      const batch = await this.expireBatch(batchSize, failed);
      total += batch.expired;
      failed.push(...batch.failed);
      if (batch.claimed < batchSize) {
        return total;
      }
    }
  }

  /**
   * Toma un lote con FOR UPDATE SKIP LOCKED y vence cada pedido en su propio
   * SAVEPOINT (transaccion anidada de Prisma, soportada por @prisma/adapter-pg):
   * si el cambio, el historial o un hook de un pedido fallan, solo se revierte
   * ese pedido; los demas del lote se confirman. Los pedidos fallidos siguen
   * en su estado, se registran en el log y quedan para la siguiente pasada.
   */
  private async expireBatch(
    batchSize: number,
    skipIds: string[],
  ): Promise<{ claimed: number; expired: number; failed: string[] }> {
    const statuses = ORDER_EXPIRABLE_STATUSES.filter((status) =>
      isAllowedTransition(status, OrderStatus.VENCIDO),
    );
    if (statuses.length === 0) {
      return { claimed: 0, expired: 0, failed: [] };
    }
    const result = await this.prisma.$transaction(
      async (tx) => {
        const due = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
          SELECT "id"::text AS "id", "status"
          FROM "orders"
          WHERE "status" = ANY(${statuses}::"OrderStatus"[])
            AND "expires_at" <= now()
            AND NOT ("id" = ANY(${skipIds}::uuid[]))
          ORDER BY "expires_at"
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED`;
        const events: OrderLifecycleEvent[] = [];
        const failed: string[] = [];
        for (const order of due) {
          const event: OrderLifecycleEvent = {
            type: 'VENCIDO',
            orderId: order.id,
            fromStatus: order.status,
          };
          try {
            await tx.$transaction(async (savepoint) => {
              // La fila ya esta bloqueada (FOR UPDATE del lote): su estado y
              // su plazo no cambiaron desde la consulta. La condicion sobre el
              // estado es una defensa adicional: si no coincide, no se vence.
              const updated = await savepoint.$executeRaw`
                UPDATE "orders"
                SET "status" = 'VENCIDO', "updated_at" = now()
                WHERE "id" = ${order.id}::uuid
                  AND "status" = ${order.status}::"OrderStatus"
                  AND "expires_at" <= now()`;
              if (updated !== 1) {
                throw new Error('El pedido cambio antes de vencerlo');
              }
              await savepoint.$executeRaw`
                INSERT INTO "order_status_history"
                  ("id", "order_id", "from_status", "to_status", "actor_type", "system_process", "created_at")
                VALUES (gen_random_uuid(), ${order.id}::uuid, ${order.status}::"OrderStatus",
                        'VENCIDO', 'SISTEMA', ${EXPIRATION_PROCESS}, now())`;
              await this.lifecycle.runInTransaction([event], savepoint);
            });
            events.push(event);
          } catch (error) {
            failed.push(order.id);
            this.logger.error(
              `No se pudo vencer el pedido ${order.id}; se reintentara en la siguiente pasada`,
              error,
            );
          }
        }
        return { claimed: due.length, events, failed };
      },
      { timeout: EXPIRATION_TX_TIMEOUT_MS },
    );
    await this.lifecycle.runAfterCommit(result.events);
    return {
      claimed: result.claimed,
      expired: result.events.length,
      failed: result.failed,
    };
  }

  private async runScheduled(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const expired = await this.expireDue();
      if (expired > 0) {
        this.logger.log(`Pedidos vencidos: ${expired}`);
      }
    } catch (error) {
      this.logger.error('Fallo el vencimiento de pedidos', error);
    } finally {
      this.running = false;
    }
  }
}
