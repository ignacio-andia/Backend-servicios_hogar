import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { TimelineQueryDto } from './dto/timeline-query.dto.js';
import { TimelineService } from './timeline.service.js';
import type { TimelinePage } from './timeline.types.js';

/** Seguimiento del pedido (RF-32). Controller solo HTTP. */
@Controller('orders/:orderId')
export class TimelineController {
  constructor(private readonly timeline: TimelineService) {}

  /**
   * Linea de tiempo del pedido: eventos del mas antiguo al mas reciente, con
   * fecha, hora y autor, paginados por cursor. Cliente dueno, trabajador
   * asignado o administrador; cualquier otro recibe 404. No incluye ubicacion
   * en vivo ni la direccion.
   */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR, RoleName.ADMINISTRADOR)
  @Get('timeline')
  get(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query() query: TimelineQueryDto,
  ): Promise<TimelinePage> {
    return this.timeline.getTimeline(
      { userId: user.id, roles: user.roles },
      orderId,
      { limit: query.limit, cursor: query.cursor },
    );
  }
}
