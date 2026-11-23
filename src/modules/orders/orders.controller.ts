import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { ApprovedWorkerGuard } from '../worker-profile/approved-worker.guard.js';
import type { ApprovedWorker } from '../worker-profile/worker-profile.service.js';
import { CurrentApprovedWorker } from './current-approved-worker.decorator.js';
import { CancelOrderDto } from './dto/cancel-order.dto.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { DuplicateCheckDto } from './dto/duplicate-check.dto.js';
import {
  ImageVariantQueryDto,
  ListAvailableOrdersQueryDto,
  ListOwnOrdersQueryDto,
} from './dto/list-orders-query.dto.js';
import { UpdateOrderDto } from './dto/update-order.dto.js';
import type { UploadedImageFile } from './images/order-image.processor.js';
import type { ImageDownload } from './images/order-images.service.js';
import { OrderImageTooLargeFilter } from './order-image-too-large.filter.js';
import type {
  AdminOrderSummary,
  AdminOrderView,
  OrderWarning,
  OrderWithWarnings,
  OwnerOrderView,
  PaginatedOrders,
  WorkerOrderView,
} from './order-views.js';
import { OrderVisibilityService } from './order-visibility.service.js';
import { ORDER_MAX_IMAGES } from './orders.rules.js';
import { OrdersService } from './orders.service.js';

/**
 * Pedidos. Las rutas `me` son del cliente dueno; un pedido ajeno responde 404.
 * Las fotos solo se entregan por estas rutas autorizadas.
 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly visibility: OrderVisibilityService,
  ) {}

  // RF-14: crear un pedido (multipart: campos + "images").
  @Post()
  @Auth(RoleName.CLIENTE)
  // Una foto mas que el maximo: la quinta recibe el mensaje del servicio; con
  // mas, multer corta la peticion sin cargarlas en memoria (T5.3).
  @UseInterceptors(FilesInterceptor('images', ORDER_MAX_IMAGES + 1))
  @UseFilters(OrderImageTooLargeFilter)
  create(
    @CurrentUser() user: PublicUser,
    @Body() dto: CreateOrderDto,
    @UploadedFiles() files: UploadedImageFile[] | undefined,
  ): Promise<OrderWithWarnings> {
    return this.orders.create(user.id, dto, files ?? []);
  }

  // RF-15: aviso orientativo de posibles duplicados antes de publicar.
  @Post('duplicate-check')
  @HttpCode(HttpStatus.OK)
  @Auth(RoleName.CLIENTE)
  checkDuplicates(
    @CurrentUser() user: PublicUser,
    @Body() dto: DuplicateCheckDto,
  ): Promise<{ warnings: OrderWarning[] }> {
    return this.orders.checkDuplicates(user.id, dto);
  }

  @Get('me')
  @Auth(RoleName.CLIENTE)
  listOwn(
    @CurrentUser() user: PublicUser,
    @Query() query: ListOwnOrdersQueryDto,
  ): Promise<PaginatedOrders<OwnerOrderView>> {
    return this.orders.listOwn(user.id, query);
  }

  @Get('me/:orderId')
  @Auth(RoleName.CLIENTE)
  getOwn(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<OwnerOrderView> {
    return this.orders.getOwn(user.id, orderId);
  }

  @Get('me/:orderId/images/:imageId')
  @Auth(RoleName.CLIENTE)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadOwnImage(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Query() { variant }: ImageVariantQueryDto,
  ): Promise<StreamableFile> {
    return toStreamable(
      await this.orders.openOwnImage(user.id, orderId, imageId, variant),
    );
  }

  // RF-18: editar datos. No cambia el vencimiento (T5.1).
  @Patch('me/:orderId')
  @Auth(RoleName.CLIENTE)
  update(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderDto,
  ): Promise<OrderWithWarnings> {
    return this.orders.update(user.id, orderId, dto);
  }

  // RF-18: agregar, reemplazar o eliminar fotos (cuentan como edicion).
  @Post('me/:orderId/images')
  @Auth(RoleName.CLIENTE)
  @UseInterceptors(FileInterceptor('image'))
  @UseFilters(OrderImageTooLargeFilter)
  addImage(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @UploadedFile() file: UploadedImageFile | undefined,
  ): Promise<OwnerOrderView> {
    return this.orders.addImage(user.id, orderId, file);
  }

  @Put('me/:orderId/images/:imageId')
  @Auth(RoleName.CLIENTE)
  @UseInterceptors(FileInterceptor('image'))
  @UseFilters(OrderImageTooLargeFilter)
  replaceImage(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @UploadedFile() file: UploadedImageFile | undefined,
  ): Promise<OwnerOrderView> {
    return this.orders.replaceImage(user.id, orderId, imageId, file);
  }

  @Delete('me/:orderId/images/:imageId')
  @Auth(RoleName.CLIENTE)
  deleteImage(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<OwnerOrderView> {
    return this.orders.deleteImage(user.id, orderId, imageId);
  }

  // RF-18: cancelar (solo PUBLICADO o EN_NEGOCIACION). Borra las fotos y
  // conserva el pedido y su historial.
  @Post('me/:orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @Auth(RoleName.CLIENTE)
  cancel(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CancelOrderDto,
  ): Promise<OwnerOrderView> {
    return this.orders.cancel(user.id, orderId, dto);
  }

  // T5.4: registro minimo de los pedidos para administradores (solo
  // lectura): sin direccion, fotos ni descripcion; sin el nombre del cliente
  // si el pedido fue anonimizado.
  @Get('admin')
  @Auth(RoleName.ADMINISTRADOR)
  listForAdmin(
    @Query() query: ListOwnOrdersQueryDto,
  ): Promise<PaginatedOrders<AdminOrderSummary>> {
    return this.orders.listForAdmin(query);
  }

  @Get('admin/:orderId')
  @Auth(RoleName.ADMINISTRADOR)
  getForAdmin(
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<AdminOrderView> {
    return this.orders.getForAdmin(orderId);
  }

  // RF-17: pedidos visibles para un trabajador aprobado (sin direccion ni
  // datos del cliente). ApprovedWorkerGuard va despues de JwtAuthGuard.
  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Get('available')
  listAvailable(
    @CurrentApprovedWorker() worker: ApprovedWorker,
    @Query() query: ListAvailableOrdersQueryDto,
  ): Promise<PaginatedOrders<WorkerOrderView>> {
    return this.visibility.listAvailable(worker, query);
  }

  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Get('available/:orderId')
  getAvailable(
    @CurrentApprovedWorker() worker: ApprovedWorker,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<WorkerOrderView> {
    return this.visibility.getAvailable(worker, orderId);
  }

  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Get('available/:orderId/images/:imageId')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadAvailableImage(
    @CurrentApprovedWorker() worker: ApprovedWorker,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Query() { variant }: ImageVariantQueryDto,
  ): Promise<StreamableFile> {
    return toStreamable(
      await this.visibility.openAvailableImage(
        worker,
        orderId,
        imageId,
        variant,
      ),
    );
  }
}

export function toStreamable(file: ImageDownload): StreamableFile {
  return new StreamableFile(file.stream, {
    type: file.mimeType,
    length: file.sizeBytes,
    disposition: 'inline',
  });
}
