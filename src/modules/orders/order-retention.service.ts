import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FileDeletionService } from '../../storage/file-deletion.service.js';
import { OrderImagesService } from './images/order-images.service.js';
import {
  ORDER_ANONYMIZED_DESCRIPTION,
  ORDER_CLEANUP_STATUSES,
  ORDER_EVER_AGREED_STATUSES,
} from './orders.rules.js';

type Db = Prisma.TransactionClient;

const RECOVERY_BATCH_SIZE = 50;
const RECOVERY_TX_TIMEOUT_MS = 30_000;

// Motivos con que se encolan las fotos de un pedido cerrado.
const CLEANUP_REASON: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.VENCIDO]: 'vencimiento-pedido',
  [OrderStatus.CANCELADO]: 'cancelacion-pedido',
};

export interface RecoveryResult {
  cleaned: number;
  failed: number;
}

/**
 * T5.4: limpieza de los pedidos cerrados sin acuerdo (VENCIDO o CANCELADO por
 * el cliente). Unica rutina, usada al vencer, al cancelar y por la
 * recuperacion de pedidos cerrados antes de T5.4:
 * - borra las fotos (filas y archivos, por la cola compartida de borrado);
 * - borra la direccion exacta;
 * - reemplaza la descripcion por un texto fijo y marca anonymized_at.
 * Conserva categoria, zona, presupuesto, fechas, estado e historial.
 *
 * Nunca toca un pedido que alguna vez llego a un acuerdo (trabajador
 * asignado o ACORDADO o posterior en el historial): sus fotos y datos pueden
 * ser evidencia para ejecucion, reclamos o constancias.
 */
@Injectable()
export class OrderRetentionService {
  private readonly logger = new Logger(OrderRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly images: OrderImagesService,
    private readonly fileDeletion: FileDeletionService,
  ) {}

  /**
   * Si el pedido alguna vez tuvo un acuerdo: no basta con el estado actual ni
   * con assigned_worker_id; tambien se revisa el historial de estados.
   */
  async hasEverHadAgreement(tx: Db, orderId: string): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ agreed: boolean }[]>`
      SELECT (o."assigned_worker_id" IS NOT NULL OR EXISTS (
                SELECT 1 FROM "order_status_history" h
                WHERE h."order_id" = o."id"
                  AND h."to_status" = ANY(${[...ORDER_EVER_AGREED_STATUSES]}::"OrderStatus"[])
              )) AS "agreed"
      FROM "orders" o
      WHERE o."id" = ${orderId}::uuid`;
    // Sin fila no hay nada que limpiar: se trata como protegido.
    return row?.agreed ?? true;
  }

  /**
   * Limpia un pedido cerrado dentro de la transaccion `tx` del llamador, que
   * ya tiene el pedido bloqueado. Idempotente. Devuelve las claves de archivos
   * encoladas: el llamador las borra despues de confirmar (processNow).
   */
  async cleanupClosedOrder(
    tx: Db,
    orderId: string,
    status: OrderStatus,
  ): Promise<string[]> {
    if (!ORDER_CLEANUP_STATUSES.includes(status)) {
      return [];
    }
    if (await this.hasEverHadAgreement(tx, orderId)) {
      return [];
    }
    const keys = await this.images.releaseOrderImages(
      tx,
      orderId,
      CLEANUP_REASON[status] ?? 'cierre-pedido',
    );
    await tx.orderAddress.deleteMany({ where: { orderId } });
    await tx.$executeRaw`
      UPDATE "orders"
      SET "description" = ${ORDER_ANONYMIZED_DESCRIPTION},
          "anonymized_at" = now(),
          "updated_at" = now()
      WHERE "id" = ${orderId}::uuid
        AND "anonymized_at" IS NULL
        AND "status" = ANY(${[...ORDER_CLEANUP_STATUSES]}::"OrderStatus"[])`;
    return keys;
  }

  /**
   * Recuperacion: limpia los pedidos VENCIDO o CANCELADO que todavia tienen
   * fotos o no se anonimizaron (cerrados antes de T5.4, o cuya limpieza se
   * interrumpio). FOR UPDATE SKIP LOCKED: varias instancias no procesan el
   * mismo pedido. Cada pedido en su SAVEPOINT: uno que falla no frena al
   * resto y se reintenta en la siguiente pasada. Los archivos se borran
   * despues de confirmar.
   */
  async recoverClosedOrders(
    batchSize = RECOVERY_BATCH_SIZE,
  ): Promise<RecoveryResult> {
    const total: RecoveryResult = { cleaned: 0, failed: 0 };
    const skip: string[] = [];
    for (;;) {
      const batch = await this.recoverBatch(batchSize, skip);
      total.cleaned += batch.cleaned;
      total.failed += batch.failedIds.length;
      skip.push(...batch.failedIds);
      if (batch.claimed < batchSize) {
        return total;
      }
    }
  }

  private async recoverBatch(
    batchSize: number,
    skipIds: string[],
  ): Promise<{ claimed: number; cleaned: number; failedIds: string[] }> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const due = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
          SELECT o."id"::text AS "id", o."status"
          FROM "orders" o
          WHERE o."status" = ANY(${[...ORDER_CLEANUP_STATUSES]}::"OrderStatus"[])
            AND o."assigned_worker_id" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "order_status_history" h
              WHERE h."order_id" = o."id"
                AND h."to_status" = ANY(${[...ORDER_EVER_AGREED_STATUSES]}::"OrderStatus"[])
            )
            AND (o."anonymized_at" IS NULL
                 OR EXISTS (SELECT 1 FROM "order_images" i WHERE i."order_id" = o."id"))
            AND NOT (o."id" = ANY(${skipIds}::uuid[]))
          ORDER BY o."updated_at"
          LIMIT ${batchSize}
          FOR UPDATE OF o SKIP LOCKED`;
        const keys: string[] = [];
        const failedIds: string[] = [];
        let cleaned = 0;
        for (const order of due) {
          try {
            keys.push(
              ...(await tx.$transaction((savepoint) =>
                this.cleanupClosedOrder(savepoint, order.id, order.status),
              )),
            );
            cleaned += 1;
          } catch (error) {
            failedIds.push(order.id);
            this.logger.error(
              `No se pudo limpiar el pedido cerrado ${order.id}; se reintentara en la siguiente pasada`,
              error,
            );
          }
        }
        return { claimed: due.length, cleaned, failedIds, keys };
      },
      { timeout: RECOVERY_TX_TIMEOUT_MS },
    );
    await this.fileDeletion.processNow(result.keys);
    return result;
  }
}
