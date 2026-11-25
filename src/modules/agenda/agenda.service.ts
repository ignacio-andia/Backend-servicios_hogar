import { Injectable } from '@nestjs/common';
import type { OrderStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { slotsOverlap } from '../offers/offer-negotiation.js';
import { OffersService } from '../offers/offers.service.js';
import { OrdersService } from '../orders/orders.service.js';
import {
  type ScheduleView,
  WorkerProfileService,
} from '../worker-profile/worker-profile.service.js';
import {
  SCHEDULE_TIME_ZONE,
  isWithinSchedules,
  toMinutes,
} from '../worker-profile/schedules.js';
import type { CheckAvailabilityDto } from './dto/check-availability.dto.js';

const MINUTE_MS = 60_000;

export interface AgendaJob {
  orderId: string;
  orderStatus: OrderStatus;
  startAt: Date;
  endAt: Date;
  durationMinutes: number;
}

export interface AgendaView {
  timeZone: string;
  /** Horario semanal de atencion (RF-29). No son reservas. */
  schedules: ScheduleView[];
  /** Trabajos acordados que ocupan la agenda (RF-30), del mas proximo al ultimo. */
  jobs: AgendaJob[];
}

export interface AvailabilityResult {
  startAt: Date;
  endAt: Date;
  /** true si no se cruza con ningun trabajo acordado (la regla RF-30). */
  available: boolean;
  /** Trabajos acordados que se cruzan con el rango (RF-30 A1). */
  conflicts: AgendaJob[];
  /**
   * Informativo: el rango cae completo dentro del horario de atencion. NO
   * bloquea nada: segun la aclaracion del docente el horario semanal no
   * limita las ofertas.
   */
  withinSchedule: boolean;
  /** Mensaje cuando el rango queda fuera del horario semanal. */
  note: string | null;
}

/**
 * Agenda del trabajador (RF-29 a RF-31). Solo LEE: reutiliza el horario
 * semanal de WorkerProfileModule (schedules.ts), los trabajos acordados de
 * OffersModule/OrdersModule y slotsOverlap. No cambia la aceptacion de ofertas
 * ni las reglas de cruces (que siguen en OffersService.accept, bajo bloqueo):
 * esta consulta solo permite ver la agenda y comprobar un horario antes.
 */
@Injectable()
export class AgendaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly offers: OffersService,
    private readonly workerProfiles: WorkerProfileService,
  ) {}

  async getAgenda(workerId: string): Promise<AgendaView> {
    const [profile, jobs] = await Promise.all([
      this.workerProfiles.getOwn(workerId),
      this.listJobs(workerId),
    ]);
    return {
      timeZone: SCHEDULE_TIME_ZONE,
      schedules: profile.schedules,
      jobs,
    };
  }

  async checkAvailability(
    workerId: string,
    dto: CheckAvailabilityDto,
  ): Promise<AvailabilityResult> {
    const start = new Date(dto.startAt);
    const end = new Date(start.getTime() + dto.durationMinutes * MINUTE_MS);
    const [profile, jobs] = await Promise.all([
      this.workerProfiles.getOwn(workerId),
      this.listJobs(workerId),
    ]);
    const candidate = {
      proposedStartAt: start,
      estimatedDurationMinutes: dto.durationMinutes,
    };
    const conflicts = jobs.filter((job) =>
      slotsOverlap(candidate, {
        proposedStartAt: job.startAt,
        estimatedDurationMinutes: job.durationMinutes,
      }),
    );
    const withinSchedule = isWithinSchedules(
      profile.schedules.map((schedule) => ({
        dayOfWeek: schedule.dayOfWeek,
        startMinutes: toMinutes(schedule.startTime),
        endMinutes: toMinutes(schedule.endTime),
        isActive: schedule.isActive,
      })),
      start,
      dto.durationMinutes,
    );
    return {
      startAt: start,
      endAt: end,
      available: conflicts.length === 0,
      conflicts,
      withinSchedule,
      note: withinSchedule
        ? null
        : `El rango queda fuera de tu horario de atención (hora de Bolivia, ${SCHEDULE_TIME_ZONE}). Es solo informativo.`,
    };
  }

  /** Trabajos acordados activos (CANCELADO y CERRADO ya liberaron la franja). */
  private async listJobs(workerId: string): Promise<AgendaJob[]> {
    return this.prisma.$transaction(async (tx) => {
      const orderIds = await this.orders.findActiveAssignedOrderIds(
        tx,
        workerId,
      );
      const slots = await this.offers.findAcceptedJobSlots(
        tx,
        workerId,
        orderIds,
      );
      const jobs: AgendaJob[] = [];
      for (const slot of slots) {
        const order = await this.orders.findOrderSummary(tx, slot.orderId);
        if (!order) {
          continue;
        }
        jobs.push({
          orderId: slot.orderId,
          orderStatus: order.status,
          startAt: slot.proposedStartAt,
          endAt: new Date(
            slot.proposedStartAt.getTime() +
              slot.estimatedDurationMinutes * MINUTE_MS,
          ),
          durationMinutes: slot.estimatedDurationMinutes,
        });
      }
      return jobs;
    });
  }
}
