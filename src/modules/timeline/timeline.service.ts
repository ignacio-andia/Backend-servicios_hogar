import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ORDER_PARTICIPANTS_READER,
  type OrderParticipantsReader,
} from '../../common/contracts/order-participants.reader.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { RoleName } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { buildTimelinePage } from './timeline-page.js';
import { TimelineSourceRegistry } from './timeline-source.registry.js';
import type { TimelinePage } from './timeline.types.js';

export interface TimelineViewer {
  userId: string;
  roles: readonly RoleName[];
}

/**
 * Linea de tiempo del pedido (RF-32). Visible para el cliente del pedido, el
 * trabajador asignado y los administradores (CU-32 A1). No lee tablas: arma la
 * lectura con los lectores publicos registrados por los modulos propietarios.
 * Si un pedido no es del usuario, responde 404 igual que si no existiera, para
 * no revelar pedidos ajenos.
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: TimelineSourceRegistry,
    @Inject(ORDER_PARTICIPANTS_READER)
    private readonly participants: OrderParticipantsReader,
  ) {}

  async getTimeline(
    viewer: TimelineViewer,
    orderId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<TimelinePage> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await this.participants.findParticipants(tx, orderId);
      const isAdmin = viewer.roles.includes(RoleName.ADMINISTRADOR);
      const isParticipant =
        order !== null &&
        (order.clientId === viewer.userId ||
          order.assignedWorkerId === viewer.userId);
      if (!order || (!isAdmin && !isParticipant)) {
        throw new NotFoundException('Pedido no encontrado');
      }
      const lists = await Promise.all(
        this.sources.list().map((source) => source.listEvents(tx, orderId)),
      );
      return buildTimelinePage(lists.flat(), options);
    });
  }
}
