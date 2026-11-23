import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { ApprovedWorkerGuard } from '../worker-profile/approved-worker.guard.js';
import { CounterOfferDto } from './dto/counter-offer.dto.js';
import { CreateOfferDto } from './dto/create-offer.dto.js';
import {
  ListOffersQueryDto,
  ListReceivedOffersQueryDto,
} from './dto/list-offers-query.dto.js';
import type {
  OfferDetail,
  OfferView,
  PaginatedOffers,
  ReceivedOfferView,
} from './offer-views.js';
import { OffersService } from './offers.service.js';

/**
 * Ofertas (RF-19 a RF-24). `me` son las ofertas del trabajador; `received`,
 * las que recibio el cliente en sus pedidos. Una oferta ajena responde 404.
 * Ninguna respuesta incluye la direccion del pedido.
 */
@Controller('offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  // RF-19. ApprovedWorkerGuard rechaza rapido a quien no esta aprobado; la
  // decision se vuelve a tomar dentro de la transaccion, con bloqueo.
  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Post('orders/:orderId')
  create(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateOfferDto,
  ): Promise<OfferDetail<OfferView>> {
    return this.offers.create(user.id, orderId, dto);
  }

  // RF-20: contraoferta (solo el monto) del cliente dueno del pedido o del
  // trabajador de la oferta, segun el turno. Quien no participa recibe 404.
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  @Post(':offerId/counter')
  @HttpCode(HttpStatus.OK)
  counter(
    @CurrentUser() user: PublicUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() dto: CounterOfferDto,
  ): Promise<OfferDetail<OfferView>> {
    return this.offers.counter(user.id, offerId, dto);
  }

  // RF-20: el cliente dueno del pedido rechaza la oferta, en su turno. Si no
  // quedan ofertas vigentes el pedido vuelve a PUBLICADO.
  @Auth(RoleName.CLIENTE)
  @Post(':offerId/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: PublicUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<OfferDetail<OfferView>> {
    return this.offers.reject(user.id, offerId);
  }

  // El trabajador retira su oferta vigente (sin importar el turno). No podra
  // volver a ofertar por ese pedido.
  @Auth(RoleName.TRABAJADOR)
  @Post(':offerId/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(
    @CurrentUser() user: PublicUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<OfferDetail<OfferView>> {
    return this.offers.withdraw(user.id, offerId);
  }

  // Sus ofertas se consultan aunque el perfil ya no este aprobado.
  @Auth(RoleName.TRABAJADOR)
  @Get('me')
  listOwn(
    @CurrentUser() user: PublicUser,
    @Query() query: ListOffersQueryDto,
  ): Promise<PaginatedOffers<OfferView>> {
    return this.offers.listOwn(user.id, query);
  }

  @Auth(RoleName.TRABAJADOR)
  @Get('me/:offerId')
  getOwn(
    @CurrentUser() user: PublicUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<OfferDetail<OfferView>> {
    return this.offers.getOwn(user.id, offerId);
  }

  @Auth(RoleName.CLIENTE)
  @Get('received')
  listReceived(
    @CurrentUser() user: PublicUser,
    @Query() query: ListReceivedOffersQueryDto,
  ): Promise<PaginatedOffers<ReceivedOfferView>> {
    return this.offers.listReceived(user.id, query);
  }

  @Auth(RoleName.CLIENTE)
  @Get('received/:offerId')
  getReceived(
    @CurrentUser() user: PublicUser,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<OfferDetail<ReceivedOfferView>> {
    return this.offers.getReceived(user.id, offerId);
  }
}
