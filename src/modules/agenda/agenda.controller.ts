import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { ApprovedWorkerGuard } from '../worker-profile/approved-worker.guard.js';
import {
  AgendaService,
  type AgendaView,
  type AvailabilityResult,
} from './agenda.service.js';
import { CheckAvailabilityDto } from './dto/check-availability.dto.js';

/**
 * «Mi agenda» del trabajador (RF-29 a RF-31). El horario semanal se guarda con
 * PUT /worker-profile/me/schedules (ya existente); aqui se consulta la agenda
 * y se comprueba un horario. Solo trabajadores aprobados.
 */
@Controller('agenda')
export class AgendaController {
  constructor(private readonly agenda: AgendaService) {}

  /** Horario semanal y trabajos acordados que ocupan la agenda. */
  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Get('me')
  get(@CurrentUser() user: PublicUser): Promise<AgendaView> {
    return this.agenda.getAgenda(user.id);
  }

  /**
   * Comprueba un rango [inicio, inicio + duracion): muestra los trabajos en
   * conflicto y si cae dentro del horario de atencion. No reserva nada.
   */
  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Post('me/check')
  @HttpCode(HttpStatus.OK)
  check(
    @CurrentUser() user: PublicUser,
    @Body() dto: CheckAvailabilityDto,
  ): Promise<AvailabilityResult> {
    return this.agenda.checkAvailability(user.id, dto);
  }
}
