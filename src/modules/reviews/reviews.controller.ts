import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { CreateReviewDto } from './dto/create-review.dto.js';
import { ListReviewsQueryDto } from './dto/review-queries.dto.js';
import { SearchWorkersQueryDto } from './dto/search-workers-query.dto.js';
import type {
  AdminReviewView,
  MyReviewStatus,
  Paginated,
  PublicOpinionView,
  PublicWorkerProfileView,
  ReviewView,
  WorkerSearchPage,
} from './review-views.js';
import { ReviewsService } from './reviews.service.js';

/**
 * Calificaciones mutuas y perfil publico del trabajador (RF-44 a RF-46).
 * Controller solo HTTP. Las rutas de `workers/` son PUBLICAS (RF-46: actor
 * Cliente o Visitante) y solo devuelven datos publicos de trabajadores
 * aprobados; el resto exige sesion.
 */
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** Califica al otro participante del pedido. El autor sale del token. */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  @Post('orders/:orderId/reviews')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateReviewDto,
  ): Promise<ReviewView> {
    return this.reviews.create(user.id, orderId, dto);
  }

  /** Si puede calificar este pedido (o el motivo) y su calificacion, si existe. */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  @Get('orders/:orderId/reviews/mine')
  mine(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<MyReviewStatus> {
    return this.reviews.getMine(user.id, orderId);
  }

  /** RF-16: el cliente busca trabajadores de una categoria y zona. */
  @Auth(RoleName.CLIENTE)
  @Get('workers/search')
  searchWorkers(
    @CurrentUser() user: PublicUser,
    @Query() query: SearchWorkersQueryDto,
  ): Promise<WorkerSearchPage> {
    return this.reviews.searchWorkers(user.id, query);
  }

  /** Calificaciones recibidas por el usuario (visibles). */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  @Get('reviews/received')
  received(
    @CurrentUser() user: PublicUser,
    @Query() query: ListReviewsQueryDto,
  ): Promise<Paginated<ReviewView>> {
    return this.reviews.listReceived(user.id, query.page, query.limit);
  }

  /** PUBLICO: perfil del trabajador con promedio y opiniones recientes. */
  @Get('workers/:workerId/public-profile')
  publicProfile(
    @Param('workerId', ParseUUIDPipe) workerId: string,
  ): Promise<PublicWorkerProfileView> {
    return this.reviews.getPublicProfile(workerId);
  }

  /** PUBLICO: opiniones visibles del trabajador, paginadas. */
  @Get('workers/:workerId/reviews')
  opinions(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Query() query: ListReviewsQueryDto,
  ): Promise<Paginated<PublicOpinionView>> {
    return this.reviews.listPublicOpinions(workerId, query.page, query.limit);
  }

  @Auth(RoleName.ADMINISTRADOR)
  @Get('admin/reviews')
  listForAdmin(
    @Query() query: ListReviewsQueryDto,
  ): Promise<Paginated<AdminReviewView>> {
    return this.reviews.listForAdmin(query.page, query.limit);
  }

  /** Oculta una opinion que incumple las reglas (RF-46 A1); no se borra. */
  @Auth(RoleName.ADMINISTRADOR)
  @Patch('admin/reviews/:reviewId/hide')
  hide(
    @CurrentUser() user: PublicUser,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ): Promise<AdminReviewView> {
    return this.reviews.hide(user.id, reviewId);
  }
}
