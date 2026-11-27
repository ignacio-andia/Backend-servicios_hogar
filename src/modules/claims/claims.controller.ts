import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFiles,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { UploadedImageFile } from '../orders/images/order-image.processor.js';
import { OrderImageTooLargeFilter } from '../orders/order-image-too-large.filter.js';
import type { PublicUser } from '../users/users.service.js';
import type {
  ClaimAssigneeView,
  ClaimPartyView,
  ClaimView,
  PaginatedClaims,
} from './claim-views.js';
import { CLAIM_IMAGES_TECHNICAL_CEILING } from './claims.config.js';
import { ClaimsService } from './claims.service.js';
import {
  ClaimImageQueryDto,
  CreateClaimDto,
  DecideClaimDto,
  ListClaimsQueryDto,
  UpdateClaimAssignmentDto,
} from './dto/claim.dto.js';

/**
 * Reclamos (RF-37, RF-38) y su priorizacion. Controller solo HTTP: la logica
 * esta en ClaimsService. Un reclamo ajeno responde 404.
 */
@Controller()
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  // RF-37: multipart con `description` y fotos opcionales en `images`. Una
  // foto mas que el tope tecnico: la que sobra recibe el mensaje del servicio;
  // con mas, multer corta sin cargarlas en memoria.
  @Post('orders/:orderId/claims')
  @Auth(RoleName.CLIENTE)
  @UseInterceptors(
    FilesInterceptor('images', CLAIM_IMAGES_TECHNICAL_CEILING + 1),
  )
  @UseFilters(OrderImageTooLargeFilter)
  create(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateClaimDto,
    @UploadedFiles() files: UploadedImageFile[] | undefined,
  ): Promise<ClaimView> {
    return this.claims.create(user.id, orderId, dto, files ?? []);
  }

  // Reclamo del pedido: completo para el cliente; solo estado y decision
  // para el trabajador asignado.
  @Get('orders/:orderId/claim')
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  getByOrder(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ClaimView | ClaimPartyView> {
    return this.claims.getByOrderFor(user.id, orderId);
  }

  // Foto del reclamo: el cliente que lo presento o un administrador.
  @Get('claims/:claimId/images/:imageId')
  @Auth(RoleName.CLIENTE, RoleName.ADMINISTRADOR)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadImage(
    @CurrentUser() user: PublicUser,
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Query() { variant }: ClaimImageQueryDto,
  ): Promise<StreamableFile> {
    const image = await this.claims.openImage(user, claimId, imageId, variant);
    return new StreamableFile(image.stream, {
      type: image.mimeType,
      length: image.sizeBytes,
    });
  }

  // --- Administrador (RF-38 y priorizacion) -------------------------------

  // Filtros: status, priority, situation (PENDIENTE | VENCIDO | EN_PLAZO),
  // assigneeId (UUID o "none"), page y limit.
  @Get('admin/claims')
  @Auth(RoleName.ADMINISTRADOR)
  list(@Query() query: ListClaimsQueryDto): Promise<PaginatedClaims> {
    return this.claims.listForAdmin(query);
  }

  // IMPORTANTE: va ANTES de 'admin/claims/:claimId'. Express empareja las
  // rutas en orden; si fuera despues, "assignees" se tomaria como un claimId
  // y ParseUUIDPipe responderia 400.
  @Get('admin/claims/assignees')
  @Auth(RoleName.ADMINISTRADOR)
  listAssignees(): Promise<ClaimAssigneeView[]> {
    return this.claims.listAssignees();
  }

  @Get('admin/claims/:claimId')
  @Auth(RoleName.ADMINISTRADOR)
  getForAdmin(
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<ClaimView> {
    return this.claims.getForAdmin(claimId);
  }

  // Prioridad, responsable y fecha limite (RN-2 a RN-5, RN-7).
  @Patch('admin/claims/:claimId/assignment')
  @Auth(RoleName.ADMINISTRADOR)
  updateAssignment(
    @CurrentUser() user: PublicUser,
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: UpdateClaimAssignmentDto,
  ): Promise<ClaimView> {
    return this.claims.updateAssignment(user.id, claimId, dto);
  }

  @Post('admin/claims/:claimId/review')
  @Auth(RoleName.ADMINISTRADOR)
  @HttpCode(HttpStatus.OK)
  markInReview(
    @CurrentUser() user: PublicUser,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<ClaimView> {
    return this.claims.markInReview(user.id, claimId);
  }

  @Post('admin/claims/:claimId/decision')
  @Auth(RoleName.ADMINISTRADOR)
  @HttpCode(HttpStatus.OK)
  decide(
    @CurrentUser() user: PublicUser,
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: DecideClaimDto,
  ): Promise<ClaimView> {
    return this.claims.decide(user.id, claimId, dto);
  }
}