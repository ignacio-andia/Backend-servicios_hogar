import { Injectable, NotFoundException } from '@nestjs/common';
import {
  NotificationResourceType,
  NotificationType,
  Prisma,
  RoleName,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto.js';

/**
 * Datos de una notificacion nueva. El texto lo arma el modulo que origina el
 * evento: este modulo no conoce reglas de perfiles, pedidos ni ofertas.
 * No incluya documentos, contrasenas, tokens ni datos privados innecesarios.
 */
export interface NewNotification {
  type: NotificationType;
  title: string;
  message: string;
  resource?: { type: NotificationResourceType; id: string };
}

const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  title: true,
  message: true,
  resourceType: true,
  resourceId: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationView = Prisma.NotificationGetPayload<{
  select: typeof NOTIFICATION_SELECT;
}>;

export interface PaginatedNotifications {
  data: NotificationView[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Notificaciones internas (v1.0 §6). Se guardan en PostgreSQL y se conservan
 * todas. Cada usuario solo ve y marca las suyas: la identidad siempre llega
 * del token, nunca del cliente.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crea una notificacion para un usuario. Pase el cliente de la transaccion
   * del evento que la origina: si la notificacion falla, el evento se revierte
   * y nunca queda uno sin la otra.
   */
  async create(
    userId: string,
    notification: NewNotification,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.notification.create({ data: toData(userId, notification) });
  }

  /**
   * Crea la misma notificacion para cada usuario activo con el rol indicado
   * (por ejemplo, todos los administradores). excludeUserIds deja fuera a
   * quien origino el evento. Devuelve cuantas se crearon. Igual que create,
   * debe recibir el cliente de la transaccion del evento.
   */
  async createForRole(
    role: RoleName,
    notification: NewNotification,
    { excludeUserIds = [] }: { excludeUserIds?: readonly string[] } = {},
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    const recipients = await db.user.findMany({
      where: {
        status: UserStatus.ACTIVO,
        roles: { some: { role } },
        id: { notIn: [...excludeUserIds] },
      },
      select: { id: true },
    });
    if (recipients.length === 0) {
      return 0;
    }
    const { count } = await db.notification.createMany({
      data: recipients.map(({ id }) => toData(id, notification)),
    });
    return count;
  }

  async list(
    userId: string,
    { unread, page, limit }: ListNotificationsQueryDto,
  ): Promise<PaginatedNotifications> {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(unread === undefined
        ? {}
        : { readAt: unread ? null : { not: null } }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        select: NOTIFICATION_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async countUnread(userId: string): Promise<{ unread: number }> {
    const unread = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { unread };
  }

  /**
   * Marca una notificacion propia como leida. Es idempotente: si ya estaba
   * leida conserva la fecha original. Una notificacion ajena o inexistente
   * responde 404, sin revelar si existe.
   */
  async markAsRead(
    userId: string,
    notificationId: string,
  ): Promise<NotificationView> {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: NOTIFICATION_SELECT,
    });
    if (!notification) {
      throw new NotFoundException('La notificación no existe');
    }
    return notification;
  }

  /** Marca como leidas todas las notificaciones propias no leidas. */
  async markAllAsRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }
}

function toData(
  userId: string,
  { type, title, message, resource }: NewNotification,
): Prisma.NotificationCreateManyInput {
  return {
    userId,
    type,
    title,
    message,
    resourceType: resource?.type ?? null,
    resourceId: resource?.id ?? null,
  };
}
