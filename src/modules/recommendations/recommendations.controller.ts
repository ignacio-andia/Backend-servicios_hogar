import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { UpdateRecommendationSettingsDto } from './dto/update-recommendation-settings.dto.js';
import type {
  RecommendationSettingsOverview,
  RecommendationView,
} from './recommendation-views.js';
import { RecommendationsService } from './recommendations.service.js';

/**
 * Recomendacion de trabajadores. El cliente la genera y consulta para sus
 * pedidos; el administrador define los criterios (pesos y parametros).
 */
@Controller()
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  /** Genera y guarda una recomendacion nueva para el pedido. */
  @Auth(RoleName.CLIENTE)
  @Post('orders/:orderId/recommendations')
  generate(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<RecommendationView> {
    return this.recommendations.generate(user.id, orderId);
  }

  /** Recomendaciones guardadas del pedido (las 10 mas recientes). */
  @Auth(RoleName.CLIENTE)
  @Get('orders/:orderId/recommendations')
  list(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<RecommendationView[]> {
    return this.recommendations.listForOrder(user.id, orderId);
  }

  /** Criterios vigentes y el historial de versiones. */
  @Auth(RoleName.ADMINISTRADOR)
  @Get('admin/recommendation-settings')
  getSettings(): Promise<RecommendationSettingsOverview> {
    return this.recommendations.getSettings();
  }

  /** Crea una version nueva de los criterios (queda en la bitacora). */
  @Auth(RoleName.ADMINISTRADOR)
  @Put('admin/recommendation-settings')
  updateSettings(
    @CurrentUser() user: PublicUser,
    @Body() dto: UpdateRecommendationSettingsDto,
  ): Promise<RecommendationSettingsOverview> {
    return this.recommendations.updateSettings(user.id, dto);
  }
}
