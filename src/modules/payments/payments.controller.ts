import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { PaymentConcept, RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { PublicUser } from '../users/users.service.js';
import { DeclarePaymentDto } from './dto/declare-payment.dto.js';
import { ListPaymentDifferencesQueryDto } from './dto/list-differences-query.dto.js';
import type {
  DeclarationResult,
  PaymentDifferenceView,
  PaymentsOverview,
  ReceiptsView,
} from './payment-views.js';
import { PaymentsService } from './payments.service.js';

/**
 * Pagos y constancias (RF-39 a RF-43). Controller solo HTTP: la logica esta en
 * PaymentsService. Un pedido ajeno responde 404. La identidad y la parte
 * (cliente o trabajador) salen del token y del pedido, nunca del cuerpo.
 */
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Pagos del pedido, declaraciones y saldo esperado. */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR, RoleName.ADMINISTRADOR)
  @Get('orders/:orderId/payments')
  overview(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<PaymentsOverview> {
    return this.payments.getOverview(
      { userId: user.id, roles: user.roles },
      orderId,
    );
  }

  /** Constancia del servicio y de cada pago (RF-41). */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR, RoleName.ADMINISTRADOR)
  @Get('orders/:orderId/receipts')
  receipts(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<ReceiptsView> {
    return this.payments.getReceipts(
      { userId: user.id, roles: user.roles },
      orderId,
    );
  }

  /**
   * «Ya pagué» (cliente) o «Confirmo que me pagaron» (trabajador asignado).
   * Una declaracion por parte y concepto; no se edita ni se borra.
   */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  @Post('orders/:orderId/payments/:concept/declarations')
  @HttpCode(HttpStatus.CREATED)
  declare(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('concept', new ParseEnumPipe(PaymentConcept))
    concept: PaymentConcept,
    @Body() dto: DeclarePaymentDto,
  ): Promise<DeclarationResult> {
    return this.payments.declare(user.id, orderId, concept, dto);
  }

  /** Pagos con declaraciones de monto distinto, para revision (RF-42 A1). */
  @Auth(RoleName.ADMINISTRADOR)
  @Get('admin/payments/differences')
  differences(@Query() query: ListPaymentDifferencesQueryDto): Promise<{
    data: PaymentDifferenceView[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    return this.payments.listDifferences(query.page, query.limit);
  }
}
