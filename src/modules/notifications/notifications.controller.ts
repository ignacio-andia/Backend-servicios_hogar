import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto.js';
import type {
  NotificationView,
  PaginatedNotifications,
} from './notifications.service.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Bandeja de notificaciones del usuario autenticado, con cualquier rol. El
 * destinatario sale siempre del token: ninguna ruta acepta un userId.
 */
@Controller('notifications')
@Auth()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: PublicUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<PaginatedNotifications> {
    return this.notifications.list(user.id, query);
  }

  @Get('unread-count')
  countUnread(@CurrentUser() user: PublicUser): Promise<{ unread: number }> {
    return this.notifications.countUnread(user.id);
  }

  @Patch('read-all')
  markAllAsRead(@CurrentUser() user: PublicUser): Promise<{ updated: number }> {
    return this.notifications.markAllAsRead(user.id);
  }

  @Patch(':notificationId/read')
  markAsRead(
    @CurrentUser() user: PublicUser,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<NotificationView> {
    return this.notifications.markAsRead(user.id, notificationId);
  }
}
