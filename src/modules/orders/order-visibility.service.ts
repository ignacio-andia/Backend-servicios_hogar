import { Injectable } from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogKind, CatalogsService } from '../catalogs/catalogs.service.js';
import {
  ApprovedWorker,
  WorkerProfileService,
} from '../worker-profile/worker-profile.service.js';
import type {
  ImageVariant,
  ListAvailableOrdersQueryDto,
} from './dto/list-orders-query.dto.js';
import {
  ImageDownload,
  OrderImagesService,
} from './images/order-images.service.js';
import { OpenNegotiationRegistry } from './open-negotiation.registry.js';
import { catalogRefs, dbNow } from './order-support.js';
import {
  ORDER_PUBLIC_SELECT,
  PaginatedOrders,
  toWorkerView,
  WorkerOrderView,
} from './order-views.js';
import {
  ORDER_EXPIRABLE_STATUSES,
  ORDER_OPEN_FOR_OFFERS_STATUSES,
  ORDER_WORKER_VISIBLE_STATUSES,
} from './orders.rules.js';
import { lockOrder, orderNotFound } from './orders.service.js';

// Filtro que no coincide con ningun pedido.
const NO_ORDERS: Prisma.OrderWhereInput = { id: { in: [] } };

/**
 * Unica regla de quien ve un pedido (RF-17): trabajador APROBADO (lo
 * garantiza ApprovedWorkerGuard), de la misma zona, con la categoria entre
 * sus especialidades, pedido visible y sin vencer, y que no sea propio
 * (RN-14). Ademas, la zona y la categoria deben estar activas y la cuenta
 * del cliente debe estar ACTIVA (decision del equipo, M-8): si no, el pedido
 * se oculta y no admite ofertas, aunque su dueno lo siga viendo.
 * Se aplica igual al listado, al detalle, a las fotos y a las ofertas.
 *
 * RF-13: con una solicitud de cambio de zona PENDIENTE no se le muestran
 * oportunidades nuevas: el listado, el detalle y las fotos quedan limitados a
 * los pedidos en los que ya tiene una negociacion abierta.
 */
@Injectable()
export class OrderVisibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogs: CatalogsService,
    private readonly images: OrderImagesService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly openNegotiations: OpenNegotiationRegistry,
  ) {}

  /** Lo que se le muestra al trabajador: lo visible que ademas se le ofrece. */
  private async discoverableWhere(
    worker: ApprovedWorker,
    now: Date,
  ): Promise<Prisma.OrderWhereInput> {
    const visible = await this.visibleWhere(worker, now);
    if (!(await this.workerProfiles.hasPendingZoneChange(worker.profileId))) {
      return visible;
    }
    const negotiating = await this.openNegotiations.openOrderIds(
      this.prisma,
      worker.userId,
    );
    return { AND: [visible, { id: { in: negotiating } }] };
  }

  /**
   * Con `tx` (operaciones que escriben, como ofertar) la zona y las
   * categorias se leen con un bloqueo compartido (FOR SHARE) dentro de esa
   * transaccion: no pueden desactivarse hasta que termine. Sin `tx`
   * (consultas) se leen sin bloqueo.
   */
  async visibleWhere(
    worker: ApprovedWorker,
    now: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.OrderWhereInput> {
    // Los catalogos se consultan por CatalogsService (su modulo dueno), en
    // orden fijo: zona y despues categorias.
    const lookup = (kind: CatalogKind, ids: string[]) =>
      tx
        ? this.catalogs.findByIdsForShare(tx, kind, ids)
        : this.catalogs.findByIds(kind, ids);
    const zones = await lookup(CatalogKind.ZONE, [worker.zoneId]);
    const categories = await lookup(CatalogKind.CATEGORY, worker.categoryIds);
    const zoneActive = zones.some((zone) => zone.isActive);
    const activeCategoryIds = categories
      .filter((category) => category.isActive)
      .map((category) => category.id);
    if (!zoneActive || activeCategoryIds.length === 0) {
      return NO_ORDERS;
    }
    const neverExpire = ORDER_WORKER_VISIBLE_STATUSES.filter(
      (status) => !ORDER_EXPIRABLE_STATUSES.includes(status),
    );
    const expirable = ORDER_WORKER_VISIBLE_STATUSES.filter((status) =>
      ORDER_EXPIRABLE_STATUSES.includes(status),
    );
    return {
      zoneId: worker.zoneId,
      categoryId: { in: activeCategoryIds },
      clientId: { not: worker.userId },
      // Filtro de solo lectura sobre la relacion del pedido, igual que
      // WorkerProfileService.findApprovedWorkers: UsersService no expone una
      // consulta por estado y este filtro debe resolverse en la misma consulta.
      client: { status: UserStatus.ACTIVO },
      OR: [
        { status: { in: neverExpire } },
        { status: { in: expirable }, expiresAt: { gt: now } },
      ],
    };
  }

  async listAvailable(
    worker: ApprovedWorker,
    { categoryId, page, limit }: ListAvailableOrdersQueryDto,
  ): Promise<PaginatedOrders<WorkerOrderView>> {
    const now = await dbNow(this.prisma);
    const where: Prisma.OrderWhereInput = {
      AND: [
        await this.discoverableWhere(worker, now),
        ...(categoryId ? [{ categoryId }] : []),
      ],
    };
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ORDER_PUBLIC_SELECT,
        orderBy: { publishedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    const refs = await catalogRefs(this.catalogs, orders);
    return {
      data: orders.map((order) => toWorkerView(order, refs, now)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Un pedido que no le corresponde responde igual que uno inexistente (404). */
  async getAvailable(
    worker: ApprovedWorker,
    orderId: string,
  ): Promise<WorkerOrderView> {
    const now = await dbNow(this.prisma);
    const order = await this.prisma.order.findFirst({
      where: {
        AND: [{ id: orderId }, await this.discoverableWhere(worker, now)],
      },
      select: ORDER_PUBLIC_SELECT,
    });
    if (!order) {
      throw orderNotFound();
    }
    return toWorkerView(order, await catalogRefs(this.catalogs, [order]), now);
  }

  async openAvailableImage(
    worker: ApprovedWorker,
    orderId: string,
    imageId: string,
    variant: ImageVariant,
  ): Promise<ImageDownload> {
    await this.getAvailable(worker, orderId);
    return this.images.open(orderId, imageId, variant);
  }

  /**
   * Para el modulo de ofertas: dentro de SU transaccion, respetando el orden
   * de bloqueos del proyecto (primero el trabajador, despues el pedido):
   * 1. bloquea y relee el perfil aprobado (WorkerProfileService), sin
   *    confiar en los datos que leyo el guard antes de la transaccion;
   * 2. bloquea el pedido y comprueba que ese trabajador lo ve y que admite
   *    ofertas. Un pedido que no le corresponde responde 404;
   * 3. lee la zona y las categorias con FOR SHARE (CatalogsService): no
   *    pueden desactivarse mientras la transaccion siga abierta.
   * Devuelve el trabajador releido para que el llamador use esos datos.
   */
  async assertOpenForOffers(
    tx: Prisma.TransactionClient,
    workerUserId: string,
    orderId: string,
  ): Promise<{
    worker: ApprovedWorker;
    order: { status: OrderStatus; revision: number };
  }> {
    const worker = await this.workerProfiles.lockApprovedWorker(
      tx,
      workerUserId,
    );
    const locked = await lockOrder(tx, orderId);
    if (!locked) {
      throw orderNotFound();
    }
    const now = await dbNow(tx);
    const order = await tx.order.findFirst({
      where: {
        AND: [
          { id: orderId },
          // Ultimo eslabon del orden de bloqueos: catalogos (FOR SHARE).
          await this.visibleWhere(worker, now, tx),
          { status: { in: [...ORDER_OPEN_FOR_OFFERS_STATUSES] } },
        ],
      },
      select: { status: true, revision: true },
    });
    if (!order) {
      throw orderNotFound();
    }
    return { worker, order };
  }
}
