import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  readPositiveInt,
  scheduledJobsEnabled,
} from '../../common/config-values.js';
import { OrderStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { dbNow } from '../orders/order-support.js';
import { lockOrder, OrdersService } from '../orders/orders.service.js';
import {
  WorkflowEvent,
  WorkflowEventRegistry,
} from './workflow-events.registry.js';
import { CONFORMITY_CLOSURE_PROCESS, dbClock } from './workflow-support.js';
import { isConformityWindowOver } from './workflow.rules.js';

const CLOSURE_INTERVAL_NAME = 'conformity-closure';
const CLOSURE_BATCH_SIZE = 50;

/**
 * RF-28 (criterio 2 y CU-28 paso 5): "dado el plazo vencido sin reclamo,
 * entonces el pedido pasa a Cerrado". Cierra los pedidos TERMINADO cuyo plazo
 * de 7 dias (conformityDeadline) ya paso.
 *
 * Limites y concurrencia (RN-10): un reclamo es valido si ahora < limite; el
 * cierre ocurre solo si ahora >= limite. Ambos deciden DENTRO del bloqueo del
 * pedido (FOR UPDATE) y con el reloj de la BD, asi que no hay ventana en la
 * que ambos ganen ni en la que ninguno pueda: el segundo en llegar ve otro
 * estado y no hace nada. Un pedido ya reclamado (EN_RECLAMO), confirmado o
 * cancelado no se toca. Cada pedido se cierra en su propia transaccion; un
 * fallo no detiene a los demas y se reintenta en la siguiente pasada. Es
 * idempotente y puede correr en varias instancias.
 */
@Injectable()
export class ConformityClosureService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ConformityClosureService.name);
  private readonly intervalMinutes: number;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly events: WorkflowEventRegistry,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.intervalMinutes = readPositiveInt(
      config,
      'WORKFLOW_CLOSURE_INTERVAL_MINUTES',
      15,
      { max: 1440 },
    );
  }

  onApplicationBootstrap(): void {
    if (!scheduledJobsEnabled(this.config)) {
      return;
    }
    this.scheduler.addInterval(
      CLOSURE_INTERVAL_NAME,
      setInterval(
        () => void this.runScheduled(),
        this.intervalMinutes * 60_000,
      ),
    );
    void this.runScheduled();
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', CLOSURE_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(CLOSURE_INTERVAL_NAME);
    }
  }

  /** Cierra todos los pedidos con el plazo cumplido. Devuelve cuantos cerro. */
  async closeDue(batchSize = CLOSURE_BATCH_SIZE): Promise<number> {
    let closed = 0;
    const failed = new Set<string>();
    for (;;) {
      const now = await dbNow(this.prisma);
      const due = await this.prisma.orderExecution.findMany({
        where: {
          conformityDeadline: { lte: now },
          conformedAt: null,
          order: { status: OrderStatus.TERMINADO },
          orderId: { notIn: [...failed] },
        },
        select: { orderId: true },
        orderBy: { conformityDeadline: 'asc' },
        take: batchSize,
      });
      if (due.length === 0) {
        return closed;
      }
      for (const { orderId } of due) {
        try {
          if (await this.closeOne(orderId)) {
            closed += 1;
          } else {
            // Ya no estaba TERMINADO o aun estaba en plazo: no insistir.
            failed.add(orderId);
          }
        } catch (error) {
          failed.add(orderId);
          this.logger.error(`No se pudo cerrar el pedido ${orderId}`, error);
        }
      }
      if (due.length < batchSize) {
        return closed;
      }
    }
  }

  /**
   * Cierra un pedido si SIGUE TERMINADO y su plazo vencio (verificado con el
   * pedido bloqueado). Devuelve false si no hubo nada que hacer.
   */
  async closeOne(orderId: string): Promise<boolean> {
    const events: WorkflowEvent[] = [];
    const closed = await this.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (!order || order.status !== OrderStatus.TERMINADO) {
        return false;
      }
      const execution = await tx.orderExecution.findUnique({
        where: { orderId },
        select: { conformityDeadline: true, conformedAt: true },
      });
      if (
        !execution?.conformityDeadline ||
        execution.conformedAt ||
        !isConformityWindowOver(await dbClock(tx), execution.conformityDeadline)
      ) {
        return false;
      }
      await this.orders.transition(tx, {
        orderId,
        from: OrderStatus.TERMINADO,
        to: OrderStatus.CERRADO,
        actor: { type: 'SISTEMA', process: CONFORMITY_CLOSURE_PROCESS },
        reason: 'Plazo de conformidad vencido sin reclamo',
      });
      events.push({ type: 'CIERRE_POR_PLAZO', orderId });
      await this.events.runInTransaction(events, tx);
      return true;
    });
    if (closed) {
      await this.events.runAfterCommit(events);
    }
    return closed;
  }

  private async runScheduled(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.closeDue();
    } catch (error) {
      this.logger.error('Fallo el cierre de pedidos por plazo vencido', error);
    } finally {
      this.running = false;
    }
  }
}
