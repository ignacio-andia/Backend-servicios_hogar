import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FileDeletionService } from '../../storage/file-deletion.service.js';
import { CatalogKind, CatalogsService } from '../catalogs/catalogs.service.js';
import { WorkerActiveWorkRegistry } from '../worker-profile/active-work.registry.js';
import { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { DuplicateCheckDto } from './dto/duplicate-check.dto.js';
import { ListOwnOrdersQueryDto } from './dto/list-orders-query.dto.js';
import { UpdateOrderDto } from './dto/update-order.dto.js';
import { CancelOrderDto } from './dto/cancel-order.dto.js';
import type { UploadedImageFile } from './images/order-image.processor.js';
import {
  imageKeys,
  OrderImagesService,
} from './images/order-images.service.js';
import {
  clientActor,
  OrderActor,
  recordStatusChange,
} from './order-history.js';
import {
  OrderLifecycleEvent,
  OrderLifecycleRegistry,
} from './order-lifecycle.registry.js';
import { catalogRefs, dbNow } from './order-support.js';
import {
  ADMIN_ORDER_SELECT,
  AdminOrderSummary,
  AdminOrderView,
  effectiveStatus,
  OrderWarning,
  OrderWithWarnings,
  OWNER_ORDER_SELECT,
  OwnerOrderView,
  PaginatedOrders,
  toAdminSummary,
  toOwnerView,
} from './order-views.js';
import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  duplicateWarning,
  personalDataWarning,
  textSimilarity,
} from './order-warnings.js';
import {
  OrderTransitionRequest,
  OrderTransitionResult,
  OrderTransitionUsageError,
} from './order-transition.js';
import { OrderRetentionService } from './order-retention.service.js';
import { OrdersConfig } from './orders.config.js';
import {
  ACTIVE_ORDER_STATUSES,
  ORDER_AGREED_STATUSES,
  ORDER_ASSIGNMENT_TARGET,
  ORDER_CANCELLABLE_STATUSES,
  ORDER_EDITABLE_STATUSES,
  ORDER_EXPIRABLE_STATUSES,
  ORDER_EXPIRATION_DAYS,
  ORDER_INTERNAL_TARGETS,
  ORDER_TRANSITIONS,
  ORDER_WORKER_REQUIRED_STATUSES,
} from './orders.rules.js';

type Db = Prisma.TransactionClient;

/**
 * Pedidos del cliente (RF-14, RF-15, RF-18) y API publica para otros modulos.
 * La direccion exacta solo aparece en las vistas del dueno.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogs: CatalogsService,
    private readonly images: OrderImagesService,
    private readonly settings: OrdersConfig,
    private readonly fileDeletion: FileDeletionService,
    private readonly lifecycle: OrderLifecycleRegistry,
    private readonly workerProfiles: WorkerProfileService,
    private readonly activeWork: WorkerActiveWorkRegistry,
    private readonly retention: OrderRetentionService,
  ) {}

  // ---------------------------------------------------------------------
  // RF-14 y RF-15: crear y consultar los pedidos propios
  // ---------------------------------------------------------------------

  async create(
    clientId: string,
    dto: CreateOrderDto,
    files: UploadedImageFile[],
  ): Promise<OrderWithWarnings> {
    this.assertImageCount(files.length);
    // Comprobacion previa, para no procesar fotos en vano. La que decide se
    // repite dentro de la transaccion, con la zona y la categoria bloqueadas.
    await this.catalogs.assertActive(CatalogKind.CATEGORY, dto.categoryId);
    await this.catalogs.assertActive(CatalogKind.ZONE, dto.zoneId);

    const stored = await this.images.processAndStore(files);
    let orderId: string;
    try {
      orderId = await this.prisma.$transaction(async (tx) => {
        // FOR SHARE: no pueden desactivarse hasta que el pedido se confirme.
        await this.catalogs.assertActiveForShare(
          tx,
          CatalogKind.CATEGORY,
          dto.categoryId,
        );
        await this.catalogs.assertActiveForShare(
          tx,
          CatalogKind.ZONE,
          dto.zoneId,
        );
        const { id } = await tx.order.create({
          data: {
            clientId,
            categoryId: dto.categoryId,
            zoneId: dto.zoneId,
            description: dto.description,
            budgetAmount: dto.budgetAmount,
            // Provisorio: se fija con el reloj de la BD justo abajo.
            expiresAt: new Date(),
            address: {
              create: {
                addressLine: dto.addressLine,
                reference: dto.addressReference ?? null,
              },
            },
            images: {
              createMany: {
                data: stored.map((image, index) => ({
                  position: index + 1,
                  ...image,
                })),
              },
            },
          },
          select: { id: true },
        });
        // Unico lugar donde se fija el vencimiento (T5.1): 7 dias calendario
        // desde la publicacion, con el reloj de la BD. Nada lo reinicia despues.
        await tx.$executeRaw`
          UPDATE "orders"
          SET "published_at" = now(),
              "expires_at" = now() + make_interval(days => ${ORDER_EXPIRATION_DAYS}::int)
          WHERE "id" = ${id}::uuid`;
        await recordStatusChange(tx, {
          orderId: id,
          fromStatus: null,
          toStatus: OrderStatus.PUBLICADO,
          actor: clientActor(clientId),
        });
        return id;
      });
    } catch (error) {
      await this.images.discard(stored);
      throw error;
    }

    const order = await this.getOwn(clientId, orderId);
    return {
      order,
      warnings: await this.warningsFor(clientId, dto, orderId),
    };
  }

  async listOwn(
    clientId: string,
    { status, page, limit }: ListOwnOrdersQueryDto,
  ): Promise<PaginatedOrders<OwnerOrderView>> {
    const now = await dbNow(this.prisma);
    const where: Prisma.OrderWhereInput = {
      clientId,
      ...ownStatusFilter(status, now),
    };
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: OWNER_ORDER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    const refs = await catalogRefs(this.catalogs, orders);
    return {
      data: orders.map((order) => toOwnerView(order, refs, now)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Un pedido ajeno o inexistente responde igual (404). */
  async getOwn(clientId: string, orderId: string): Promise<OwnerOrderView> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, clientId },
      select: OWNER_ORDER_SELECT,
    });
    if (!order) {
      throw orderNotFound();
    }
    const [refs, now] = await Promise.all([
      catalogRefs(this.catalogs, [order]),
      dbNow(this.prisma),
    ]);
    return toOwnerView(order, refs, now);
  }

  // ---------------------------------------------------------------------
  // T5.4: consulta administrativa del registro minimo (solo lectura). La
  // autorizacion (rol ADMINISTRADOR y cuenta activa) la hace el controller.
  // ---------------------------------------------------------------------

  async listForAdmin({
    status,
    page,
    limit,
  }: ListOwnOrdersQueryDto): Promise<PaginatedOrders<AdminOrderSummary>> {
    const now = await dbNow(this.prisma);
    const where = ownStatusFilter(status, now);
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ADMIN_ORDER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    const refs = await catalogRefs(this.catalogs, orders);
    return {
      data: orders.map((order) => toAdminSummary(order, refs, now)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getForAdmin(orderId: string): Promise<AdminOrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        ...ADMIN_ORDER_SELECT,
        statusHistory: {
          orderBy: { createdAt: 'asc' },
          select: {
            fromStatus: true,
            toStatus: true,
            actorType: true,
            changedById: true,
            actorRole: true,
            systemProcess: true,
            reason: true,
            createdAt: true,
          },
        },
      },
    });
    if (!order) {
      throw orderNotFound();
    }
    const [refs, now] = await Promise.all([
      catalogRefs(this.catalogs, [order]),
      dbNow(this.prisma),
    ]);
    const anonymized = order.anonymizedAt !== null;
    return {
      ...toAdminSummary(order, refs, now),
      history: order.statusHistory.map((entry) => ({
        ...entry,
        // El motivo es texto libre del usuario: no se muestra si se anonimizo.
        reason: anonymized ? null : entry.reason,
      })),
    };
  }

  /** Consulta previa orientativa de posibles duplicados (nunca bloquea). */
  async checkDuplicates(
    clientId: string,
    dto: DuplicateCheckDto,
  ): Promise<{ warnings: OrderWarning[] }> {
    return { warnings: await this.warningsFor(clientId, dto) };
  }

  /** Abre una foto de un pedido propio. */
  async openOwnImage(
    clientId: string,
    orderId: string,
    imageId: string,
    variant: 'full' | 'thumb',
  ) {
    await this.assertOwnOrderExists(clientId, orderId);
    return this.images.open(orderId, imageId, variant);
  }

  // ---------------------------------------------------------------------
  // RF-18: edicion (datos y fotos). Toda edicion efectiva sube la revision y
  // avisa a los modulos registrados (EDITADO). No cambia el vencimiento (T5.1)
  // ni toca ofertas, estado, asignacion, dueno ni zona (T5.2).
  // ---------------------------------------------------------------------

  async update(
    clientId: string,
    orderId: string,
    dto: UpdateOrderDto,
  ): Promise<OrderWithWarnings> {
    if (
      dto.categoryId === undefined &&
      dto.description === undefined &&
      dto.budgetAmount === undefined &&
      dto.addressLine === undefined &&
      dto.addressReference === undefined
    ) {
      throw new BadRequestException('Debe enviar al menos un dato a modificar');
    }

    // Los cambios se calculan DENTRO del bloqueo del pedido (runEdit), contra
    // el estado ya confirmado por cualquier edicion simultanea: dos ediciones
    // se aplican de a una y ninguna compara contra datos viejos (M-5).
    let warningInput: {
      categoryId: string;
      zoneId: string;
      description: string;
    } | null = null;
    await this.runEdit(clientId, orderId, async (tx) => {
      const current = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          description: true,
          budgetAmount: true,
          categoryId: true,
          zoneId: true,
          address: { select: { addressLine: true, reference: true } },
        },
      });
      const orderData: Prisma.OrderUncheckedUpdateInput = {};
      // T5.2: la categoria se edita; la zona no. La nueva se valida con un
      // bloqueo compartido (orden del proyecto: pedido y luego catalogos): no
      // puede desactivarse hasta que la edicion se confirme. La visibilidad
      // para trabajadores sigue al categoryId guardado (OrderVisibilityService).
      if (
        dto.categoryId !== undefined &&
        dto.categoryId !== current.categoryId
      ) {
        await this.catalogs.assertActiveForShare(
          tx,
          CatalogKind.CATEGORY,
          dto.categoryId,
        );
        orderData.categoryId = dto.categoryId;
      }
      if (
        dto.description !== undefined &&
        dto.description !== current.description
      ) {
        orderData.description = dto.description;
      }
      if (
        dto.budgetAmount !== undefined &&
        !new Prisma.Decimal(dto.budgetAmount).equals(current.budgetAmount)
      ) {
        orderData.budgetAmount = dto.budgetAmount;
      }
      const addressData: { addressLine?: string; reference?: string | null } =
        {};
      if (
        dto.addressLine !== undefined &&
        dto.addressLine !== current.address?.addressLine
      ) {
        addressData.addressLine = dto.addressLine;
      }
      if (dto.addressReference !== undefined) {
        const reference = dto.addressReference ? dto.addressReference : null;
        if (reference !== (current.address?.reference ?? null)) {
          addressData.reference = reference;
        }
      }

      // Una edicion sin cambios reales no sube la revision ni avisa (equipo).
      if (
        Object.keys(orderData).length === 0 &&
        Object.keys(addressData).length === 0
      ) {
        return null;
      }
      if (Object.keys(orderData).length > 0) {
        await tx.order.update({ where: { id: orderId }, data: orderData });
      }
      if (Object.keys(addressData).length > 0) {
        await tx.orderAddress.update({ where: { orderId }, data: addressData });
      }
      // Los avisos se recalculan con los datos ya guardados si cambio la
      // descripcion o la categoria (los duplicados dependen de ambas).
      if (
        orderData.description !== undefined ||
        orderData.categoryId !== undefined
      ) {
        warningInput = {
          categoryId: dto.categoryId ?? current.categoryId,
          zoneId: current.zoneId,
          description: dto.description ?? current.description,
        };
      }
      return [];
    });

    return {
      order: await this.getOwn(clientId, orderId),
      warnings: warningInput
        ? await this.warningsFor(clientId, warningInput, orderId)
        : [],
    };
  }

  /** Agrega una foto si no se supera el maximo configurado. */
  async addImage(
    clientId: string,
    orderId: string,
    file: UploadedImageFile | undefined,
  ): Promise<OwnerOrderView> {
    await this.assertModifiable(clientId, orderId);
    const [stored] = await this.images.processAndStore(file ? [file] : []);
    if (!stored) {
      throw new BadRequestException(
        'Debe adjuntar una fotografía en el campo "image"',
      );
    }
    try {
      await this.runEdit(clientId, orderId, async (tx) => {
        const positions = await this.imagePositions(tx, orderId);
        if (positions.length >= this.settings.maxImages) {
          throw new ConflictException(
            `El pedido ya tiene el máximo de ${this.settings.maxImages} fotografías. Elimine o reemplace una.`,
          );
        }
        await tx.orderImage.create({
          data: { orderId, position: firstFreePosition(positions), ...stored },
        });
        return [];
      });
    } catch (error) {
      await this.images.discard([stored]);
      throw error;
    }
    return this.getOwn(clientId, orderId);
  }

  /** Reemplaza una foto: la nueva ocupa su lugar y la anterior se borra. */
  async replaceImage(
    clientId: string,
    orderId: string,
    imageId: string,
    file: UploadedImageFile | undefined,
  ): Promise<OwnerOrderView> {
    await this.assertModifiable(clientId, orderId);
    await this.findOwnImage(this.prisma, orderId, imageId);
    const [stored] = await this.images.processAndStore(file ? [file] : []);
    if (!stored) {
      throw new BadRequestException(
        'Debe adjuntar una fotografía en el campo "image"',
      );
    }
    try {
      await this.runEdit(clientId, orderId, async (tx) => {
        const previous = await this.findOwnImage(tx, orderId, imageId);
        await tx.orderImage.delete({ where: { id: previous.id } });
        await tx.orderImage.create({
          data: { orderId, position: previous.position, ...stored },
        });
        return imageKeys([previous]);
      });
    } catch (error) {
      await this.images.discard([stored]);
      throw error;
    }
    return this.getOwn(clientId, orderId);
  }

  /** Borra fisicamente una foto si no se baja del minimo configurado. */
  async deleteImage(
    clientId: string,
    orderId: string,
    imageId: string,
  ): Promise<OwnerOrderView> {
    await this.runEdit(clientId, orderId, async (tx) => {
      const image = await this.findOwnImage(tx, orderId, imageId);
      const positions = await this.imagePositions(tx, orderId);
      if (positions.length <= this.settings.minImages) {
        throw new ConflictException(
          `El pedido debe conservar al menos ${this.settings.minImages} fotografía(s). Use reemplazar.`,
        );
      }
      await tx.orderImage.delete({ where: { id: image.id } });
      return imageKeys([image]);
    });
    return this.getOwn(clientId, orderId);
  }

  /**
   * Edicion atomica: bloquea el pedido, valida que se pueda modificar (con
   * el reloj de la BD: un pedido ya vencido no se edita), aplica el cambio,
   * sube la revision, encola los archivos que dejan de usarse y ejecuta los
   * hooks; despues de confirmar, borra esos archivos y corre los efectos
   * posteriores. El vencimiento no se toca (T5.1).
   */
  private async runEdit(
    clientId: string,
    orderId: string,
    // Devuelve las claves de archivos que dejan de usarse, o null si no hubo
    // cambios reales (entonces no sube la revision).
    change: (tx: Db) => Promise<string[] | null>,
  ): Promise<boolean> {
    const actor = clientActor(clientId);
    const { obsoleteKeys, events } = await this.prisma.$transaction(
      async (tx) => {
        await this.lockModifiable(tx, clientId, orderId);
        const keys = await change(tx);
        if (keys === null) {
          return { obsoleteKeys: null, events: [] };
        }
        const [{ revision }] = await tx.$queryRaw<{ revision: number }[]>`
          UPDATE "orders"
          SET "revision" = "revision" + 1,
              "last_edited_at" = now(),
              "updated_at" = now()
          WHERE "id" = ${orderId}::uuid
          RETURNING "revision"`;
        await this.fileDeletion.enqueue(keys, 'edicion-pedido', tx);
        const eventList: OrderLifecycleEvent[] = [
          { type: 'EDITADO', orderId, revision, actor },
        ];
        await this.lifecycle.runInTransaction(eventList, tx);
        return { obsoleteKeys: keys, events: eventList };
      },
    );
    if (obsoleteKeys === null) {
      return false;
    }
    await this.fileDeletion.processNow(obsoleteKeys);
    await this.lifecycle.runAfterCommit(events);
    return true;
  }

  /**
   * Bloquea el pedido (SELECT ... FOR UPDATE) y comprueba, con el reloj de
   * la BD, que siga siendo del cliente y editable.
   */
  private async lockModifiable(
    tx: Db,
    clientId: string,
    orderId: string,
  ): Promise<OrderStatus> {
    const locked = await lockOrder(tx, orderId, clientId);
    if (!locked) {
      throw orderNotFound();
    }
    if (!ORDER_EDITABLE_STATUSES.includes(locked.effectiveStatus)) {
      throw notModifiable(locked.effectiveStatus, 'modificar');
    }
    return locked.effectiveStatus;
  }

  /** Comprobacion previa (bloqueo breve), para no procesar fotos en vano. */
  private async assertModifiable(
    clientId: string,
    orderId: string,
  ): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.lockModifiable(tx, clientId, orderId),
    );
  }

  private async findOwnImage(db: Db, orderId: string, imageId: string) {
    const image = await db.orderImage.findFirst({
      where: { id: imageId, orderId },
      select: {
        id: true,
        position: true,
        storageKey: true,
        thumbnailKey: true,
      },
    });
    if (!image) {
      throw new NotFoundException('La fotografía no existe');
    }
    return image;
  }

  private async imagePositions(db: Db, orderId: string): Promise<number[]> {
    const images = await db.orderImage.findMany({
      where: { orderId },
      select: { position: true },
    });
    return images.map((image) => image.position);
  }

  // ---------------------------------------------------------------------
  // RF-18: cancelacion por el cliente y transiciones de estado
  // ---------------------------------------------------------------------

  /**
   * Cancela un pedido PUBLICADO o EN_NEGOCIACION y avisa a los modulos
   * registrados (CANCELADO). En la misma transaccion lo limpia (T5.4): borra
   * sus fotos (por la cola compartida), su direccion y anonimiza la
   * descripcion; conserva el registro minimo y el historial. Un pedido que
   * alguna vez tuvo un acuerdo no se limpia. Con acuerdo se usa "Cancelar
   * trabajo" (RF-34).
   */
  async cancel(
    clientId: string,
    orderId: string,
    dto: CancelOrderDto,
  ): Promise<OwnerOrderView> {
    const actor = clientActor(clientId);
    const reason = dto.reason ? dto.reason : null;
    const { obsoleteKeys, events } = await this.prisma.$transaction(
      async (tx) => {
        const locked = await lockOrder(tx, orderId, clientId);
        if (!locked) {
          throw orderNotFound();
        }
        if (!ORDER_CANCELLABLE_STATUSES.includes(locked.effectiveStatus)) {
          throw notModifiable(locked.effectiveStatus, 'cancelar');
        }
        await this.applyTransition(tx, {
          orderId,
          from: locked.status,
          to: OrderStatus.CANCELADO,
          actor,
          reason,
        });
        const eventList: OrderLifecycleEvent[] = [
          {
            type: 'CANCELADO',
            orderId,
            fromStatus: locked.status,
            actor,
            reason,
          },
        ];
        await this.lifecycle.runInTransaction(eventList, tx);
        // Despues de los hooks (que aun ven los datos originales).
        const keys = await this.retention.cleanupClosedOrder(
          tx,
          orderId,
          OrderStatus.CANCELADO,
        );
        return { obsoleteKeys: keys, events: eventList };
      },
    );
    await this.fileDeletion.processNow(obsoleteKeys);
    await this.lifecycle.runAfterCommit(events);
    return this.getOwn(clientId, orderId);
  }

  /**
   * Punto de integracion para los modulos de flujo (ofertas, pagos, visitas,
   * agenda, reclamos): cambia el estado dentro de SU transaccion `tx`, valida
   * la transicion contra ORDER_TRANSITIONS y deja el historial. Si se indica
   * `from`, exige que el estado actual coincida.
   *
   * Asignacion del trabajador (decision del equipo): `assignWorkerId` asigna
   * al entrar a un estado que lo exige (ACORDADO); `releaseWorker` lo libera
   * hacia un estado que no lo exige. Estado, asignacion e historial se
   * escriben en la misma transaccion: o se confirma todo o nada.
   *
   * Orden de bloqueos del proyecto: primero el trabajador, despues el pedido.
   * Este metodo lo respeta: bloquea al trabajador (y relee su perfil
   * aprobado) antes de bloquear el pedido.
   *
   * CANCELADO y VENCIDO no se alcanzan por aqui (tienen efectos propios).
   */
  async transition(
    tx: Db,
    change: OrderTransitionRequest,
  ): Promise<OrderTransitionResult> {
    // Vista sin estrechar el tipo: valida tambien llamadas hechas con
    // conversiones de tipo, que el compilador ya no puede revisar.
    const request: {
      orderId: string;
      from?: OrderStatus;
      to: OrderStatus;
      actor: OrderActor;
      reason?: string | null;
      assignWorkerId?: string;
      releaseWorker?: boolean;
    } = change;
    const requiresWorker = ORDER_WORKER_REQUIRED_STATUSES.includes(request.to);
    const assigns = request.to === ORDER_ASSIGNMENT_TARGET;
    // Usos invalidos del API (error de programacion del modulo llamador).
    // El tipo OrderTransitionRequest ya los rechaza en compilacion; esto
    // cubre conversiones de tipo. No son errores HTTP de negocio.
    if (ORDER_INTERNAL_TARGETS.includes(request.to)) {
      throw new OrderTransitionUsageError(
        `La transicion a ${request.to} solo la realiza OrdersModule`,
      );
    }
    if (request.assignWorkerId !== undefined && request.releaseWorker) {
      throw new OrderTransitionUsageError(
        'No se puede asignar y liberar el trabajador a la vez',
      );
    }
    if (assigns && request.assignWorkerId === undefined) {
      throw new OrderTransitionUsageError(
        `La transicion a ${request.to} exige assignWorkerId`,
      );
    }
    if (!assigns && request.assignWorkerId !== undefined) {
      throw new OrderTransitionUsageError(
        `Solo se asigna un trabajador al pasar a ${ORDER_ASSIGNMENT_TARGET}, no a ${request.to}`,
      );
    }
    if (request.releaseWorker && requiresWorker) {
      throw new OrderTransitionUsageError(
        `El estado ${request.to} exige un trabajador asignado: no se puede liberar`,
      );
    }

    // 1. Trabajador (antes que el pedido).
    let releasedWorkerId: string | null = null;
    if (request.assignWorkerId !== undefined) {
      await this.workerProfiles.lockApprovedWorker(tx, request.assignWorkerId);
    } else if (request.releaseWorker) {
      const current = await tx.order.findUnique({
        where: { id: request.orderId },
        select: { assignedWorkerId: true },
      });
      releasedWorkerId = current?.assignedWorkerId ?? null;
      if (releasedWorkerId) {
        await this.activeWork.lockWorker(tx, releasedWorkerId);
      }
    }

    // 2. Pedido.
    const locked = await lockOrder(tx, request.orderId);
    if (!locked) {
      throw orderNotFound();
    }
    if (request.from !== undefined && request.from !== locked.status) {
      throw new ConflictException(
        `El pedido cambió de estado (ahora ${locked.effectiveStatus}). Vuelva a consultarlo.`,
      );
    }
    // Un pedido vencido sin marcar ya no avanza (reloj de la BD).
    if (locked.effectiveStatus !== locked.status) {
      throw notModifiable(locked.effectiveStatus, 'modificar');
    }
    if (!isAllowedTransition(locked.status, request.to)) {
      throw new ConflictException(
        `No se permite pasar un pedido de ${locked.status} a ${request.to}`,
      );
    }

    let assignedWorkerId = locked.assignedWorkerId;
    if (request.assignWorkerId !== undefined) {
      if (request.assignWorkerId === locked.clientId) {
        throw new ConflictException(
          'Un trabajador no puede tomar su propio pedido (RN-14)',
        );
      }
      if (
        locked.assignedWorkerId !== null &&
        locked.assignedWorkerId !== request.assignWorkerId
      ) {
        throw new ConflictException(
          'El pedido ya tiene otro trabajador asignado',
        );
      }
      assignedWorkerId = request.assignWorkerId;
    } else if (request.releaseWorker) {
      // La asignacion no debe haber cambiado entre la lectura y el bloqueo.
      if (locked.assignedWorkerId !== releasedWorkerId) {
        throw new ConflictException(
          'La asignación del pedido cambió. Vuelva a consultarlo.',
        );
      }
      assignedWorkerId = null;
    }
    if (requiresWorker && assignedWorkerId === null) {
      // Invariante roto: un estado con acuerdo siempre tiene trabajador.
      throw new OrderTransitionUsageError(
        `El estado ${request.to} exige un trabajador asignado y el pedido no lo tiene`,
      );
    }

    await this.applyTransition(tx, {
      orderId: request.orderId,
      from: locked.status,
      to: request.to,
      actor: request.actor,
      reason: request.reason ?? null,
      assignedWorkerId:
        assignedWorkerId !== locked.assignedWorkerId
          ? { value: assignedWorkerId }
          : undefined,
    });
    return { fromStatus: locked.status, toStatus: change.to, assignedWorkerId };
  }

  /**
   * Aplica una transicion ya bloqueada en una sola sentencia (estado,
   * asignacion y marcas de tiempo) y deja el historial en la misma
   * transaccion. Nunca cambia el vencimiento (T5.1): volver a PUBLICADO
   * conserva el plazo original.
   */
  private async applyTransition(
    tx: Db,
    change: {
      orderId: string;
      from: OrderStatus;
      to: OrderStatus;
      actor: OrderActor;
      reason: string | null;
      assignedWorkerId?: { value: string | null };
    },
  ): Promise<void> {
    if (!isAllowedTransition(change.from, change.to)) {
      throw new ConflictException(
        `No se permite pasar un pedido de ${change.from} a ${change.to}`,
      );
    }
    const cancelled = change.to === OrderStatus.CANCELADO;
    const setWorker = change.assignedWorkerId !== undefined;
    const workerId = change.assignedWorkerId?.value ?? null;
    await tx.$executeRaw`
      UPDATE "orders"
      SET "status" = ${change.to}::"OrderStatus",
          "cancelled_at" = CASE WHEN ${cancelled} THEN now() ELSE "cancelled_at" END,
          "assigned_worker_id" = CASE WHEN ${setWorker} THEN ${workerId}::uuid ELSE "assigned_worker_id" END,
          "updated_at" = now()
      WHERE "id" = ${change.orderId}::uuid`;
    await recordStatusChange(tx, {
      orderId: change.orderId,
      fromStatus: change.from,
      toStatus: change.to,
      actor: change.actor,
      reason: change.reason,
    });
  }

  // ---------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------

  private assertImageCount(count: number): void {
    const { minImages, maxImages } = this.settings;
    if (count < minImages || count > maxImages) {
      throw new BadRequestException(
        minImages === maxImages
          ? `Debe adjuntar ${minImages} fotografía(s) en el campo "images"`
          : `Debe adjuntar entre ${minImages} y ${maxImages} fotografías en el campo "images"`,
      );
    }
  }

  private async assertOwnOrderExists(
    clientId: string,
    orderId: string,
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, clientId },
      select: { id: true },
    });
    if (!order) {
      throw orderNotFound();
    }
  }

  /**
   * Advertencias orientativas: posibles duplicados (mismo cliente, categoria
   * y zona, activos, dentro de la ventana configurada y con descripcion muy
   * parecida) y posibles datos personales en la descripcion.
   */
  private async warningsFor(
    clientId: string,
    input: { categoryId: string; zoneId: string; description: string },
    excludeOrderId?: string,
  ): Promise<OrderWarning[]> {
    const now = await dbNow(this.prisma);
    const since = new Date(
      now.getTime() - this.settings.duplicateWindowDays * 24 * 60 * 60 * 1000,
    );
    const candidates = await this.prisma.order.findMany({
      where: {
        clientId,
        categoryId: input.categoryId,
        zoneId: input.zoneId,
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        createdAt: { gte: since },
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
      select: { id: true, description: true, status: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const duplicates = candidates
      .filter((order) =>
        ACTIVE_ORDER_STATUSES.includes(effectiveStatus(order, now)),
      )
      .filter(
        (order) =>
          textSimilarity(order.description, input.description) >=
          DUPLICATE_SIMILARITY_THRESHOLD,
      )
      .map((order) => order.id);

    return [
      duplicateWarning(duplicates),
      personalDataWarning(input.description),
    ].filter((warning): warning is OrderWarning => warning !== null);
  }
}

/** Filtro por estado efectivo para la lista del cliente. */
function ownStatusFilter(
  status: OrderStatus | undefined,
  now: Date,
): Prisma.OrderWhereInput {
  if (!status) {
    return {};
  }
  if (status === OrderStatus.VENCIDO) {
    return {
      OR: [
        { status: OrderStatus.VENCIDO },
        {
          status: { in: [...ORDER_EXPIRABLE_STATUSES] },
          expiresAt: { lte: now },
        },
      ],
    };
  }
  if (ORDER_EXPIRABLE_STATUSES.includes(status)) {
    return { status, expiresAt: { gt: now } };
  }
  return { status };
}

export function orderNotFound(): NotFoundException {
  return new NotFoundException('El pedido no existe');
}

/** Posicion libre mas baja (las fotos se muestran en ese orden). */
function firstFreePosition(positions: number[]): number {
  let position = 1;
  while (positions.includes(position)) position += 1;
  return position;
}

/**
 * Error claro segun el estado efectivo: con acuerdo se indica "Cancelar
 * trabajo" (RF-34); un pedido vencido o cerrado ya no se modifica.
 */
export function notModifiable(
  status: OrderStatus,
  action: 'modificar' | 'cancelar',
): ConflictException {
  if (ORDER_AGREED_STATUSES.includes(status)) {
    return new ConflictException(
      `El pedido ya tiene un acuerdo: no se puede ${action} por esta vía. Use «Cancelar trabajo» (RF-34).`,
    );
  }
  if (status === OrderStatus.VENCIDO) {
    return new ConflictException(
      `El pedido venció y ya no se puede ${action}.`,
    );
  }
  return new ConflictException(
    `No se puede ${action} un pedido en estado ${status}`,
  );
}

export function isAllowedTransition(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface LockedOrder {
  status: OrderStatus;
  clientId: string;
  assignedWorkerId: string | null;
  /** Estado considerando el vencimiento con el reloj de la BD. */
  effectiveStatus: OrderStatus;
}

interface LockedRow {
  status: OrderStatus;
  clientId: string;
  assignedWorkerId: string | null;
  expired: boolean;
}

/**
 * Bloquea la fila del pedido (SELECT ... FOR UPDATE) dentro de la
 * transaccion. Con `clientId` solo encuentra pedidos de ese cliente.
 * Orden de bloqueos: si la operacion tambien bloquea un trabajador, debe
 * hacerlo ANTES de llamar a esta funcion.
 */
export async function lockOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  clientId?: string,
): Promise<LockedOrder | null> {
  const [row] = clientId
    ? await tx.$queryRaw<LockedRow[]>`
        SELECT "status", "client_id"::text AS "clientId",
               "assigned_worker_id"::text AS "assignedWorkerId",
               "expires_at" <= now() AS "expired"
        FROM "orders"
        WHERE "id" = ${orderId}::uuid AND "client_id" = ${clientId}::uuid
        FOR UPDATE`
    : await tx.$queryRaw<LockedRow[]>`
        SELECT "status", "client_id"::text AS "clientId",
               "assigned_worker_id"::text AS "assignedWorkerId",
               "expires_at" <= now() AS "expired"
        FROM "orders"
        WHERE "id" = ${orderId}::uuid
        FOR UPDATE`;
  if (!row) {
    return null;
  }
  return {
    status: row.status,
    clientId: row.clientId,
    assignedWorkerId: row.assignedWorkerId,
    effectiveStatus:
      row.expired && ORDER_EXPIRABLE_STATUSES.includes(row.status)
        ? OrderStatus.VENCIDO
        : row.status,
  };
}
