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
import { PrismaService } from '../../prisma/prisma.service.js';
import { OffersService } from './offers.service.js';

const EXPIRATION_INTERVAL_NAME = 'offer-expiration';
// Lotes pequenos: cada pedido se procesa en su propia transaccion corta.
const EXPIRATION_BATCH_SIZE = 25;

/**
 * T6.5.1: vence las ofertas VIGENTE cuya vigencia de 24 horas termino
 * (expires_at <= now() de la BD) y devuelve a PUBLICADO los pedidos que se
 * quedan sin ofertas vigentes (OffersService.expireOffersOfOrder).
 *
 * No depende de temporizadores en memoria: el estado vive en la BD. Toda
 * operacion ya trata como vencida una oferta con la vigencia cumplida
 * (estado efectivo), asi que la tarea solo deja estado, historial y pedido al
 * dia. Corre al arrancar (recupera lo que vencio con el servidor apagado) y
 * despues cada OFFER_EXPIRATION_INTERVAL_MINUTES minutos.
 *
 * Concurrencia: los pedidos candidatos se leen sin bloqueo y cada uno se
 * procesa en su propia transaccion, que bloquea el pedido y despues sus
 * ofertas (orden del proyecto). Equivale a FOR UPDATE SKIP LOCKED sin romper
 * ese orden: dos instancias, o la tarea y una operacion de usuario, se
 * ejecutan de a una por pedido, y la segunda ya no encuentra ofertas por
 * vencer. Un pedido que falla no frena al resto y se reintenta en la
 * siguiente pasada.
 */
@Injectable()
export class OfferExpirationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OfferExpirationService.name);
  private readonly intervalMinutes: number;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: OffersService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.intervalMinutes = readPositiveInt(
      config,
      'OFFER_EXPIRATION_INTERVAL_MINUTES',
      5,
      { max: 1440 },
    );
  }

  onApplicationBootstrap(): void {
    if (!scheduledJobsEnabled(this.config)) {
      return;
    }
    this.scheduler.addInterval(
      EXPIRATION_INTERVAL_NAME,
      setInterval(
        () => void this.runScheduled(),
        this.intervalMinutes * 60_000,
      ),
    );
    // Recuperacion tras un reinicio: primera pasada inmediata.
    void this.runScheduled();
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', EXPIRATION_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(EXPIRATION_INTERVAL_NAME);
    }
  }

  /** Vence todas las ofertas atrasadas, por lotes. Devuelve cuantas vencio. */
  async expireDue(batchSize = EXPIRATION_BATCH_SIZE): Promise<number> {
    let total = 0;
    // Pedidos ya procesados en esta pasada (con exito o con error): no se
    // vuelven a tomar, asi la pasada siempre termina.
    const seen: string[] = [];
    for (;;) {
      const orderIds = await this.dueOrderIds(batchSize, [...seen]);
      for (const orderId of orderIds) {
        seen.push(orderId);
        try {
          total += await this.offers.expireOffersOfOrder(orderId);
        } catch (error) {
          this.logger.error(
            `No se pudieron vencer las ofertas del pedido ${orderId}; se reintentara en la siguiente pasada`,
            error,
          );
        }
      }
      if (orderIds.length < batchSize) {
        return total;
      }
    }
  }

  /** Pedidos con alguna oferta VIGENTE vencida (lectura sin bloqueo). */
  private async dueOrderIds(limit: number, skip: string[]): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ orderId: string }[]>`
      SELECT "order_id"::text AS "orderId"
      FROM "offers"
      WHERE "status" = 'VIGENTE'
        AND "expires_at" <= now()
        AND NOT ("order_id" = ANY(${skip}::uuid[]))
      GROUP BY "order_id"
      ORDER BY min("expires_at")
      LIMIT ${limit}`;
    return rows.map((row) => row.orderId);
  }

  private async runScheduled(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const expired = await this.expireDue();
      if (expired > 0) {
        this.logger.log(`Ofertas vencidas: ${expired}`);
      }
    } catch (error) {
      this.logger.error('Fallo el vencimiento de ofertas', error);
    } finally {
      this.running = false;
    }
  }
}
