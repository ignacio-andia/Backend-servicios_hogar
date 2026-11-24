import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { OwnerOrderView } from '../orders/order-views.js';
import type { PublicUser } from '../users/users.service.js';
import { ApprovedWorkerGuard } from '../worker-profile/approved-worker.guard.js';
import { CancelWorkDto } from './dto/cancel-work.dto.js';
import { CreateAdditionalBudgetDto } from './dto/create-additional-budget.dto.js';
import { ReportNoShowDto } from './dto/report-no-show.dto.js';
import { ServiceWorkflowService } from './service-workflow.service.js';
import {
  WorkflowQueryService,
  WorkflowView,
} from './workflow-query.service.js';

/**
 * Ciclo de vida del trabajo (RF-25 a RF-28, RF-34, RF-36). Controller solo
 * HTTP: la logica esta en ServiceWorkflowService. Un pedido ajeno, o una
 * accion de un usuario que no es parte del pedido, responde 404.
 */
@Controller('orders/:orderId')
export class ServiceWorkflowController {
  constructor(
    private readonly workflow: ServiceWorkflowService,
    private readonly queries: WorkflowQueryService,
  ) {}

  /** Estado del flujo para el cliente dueno o el trabajador asignado. */
  @Auth(RoleName.CLIENTE, RoleName.TRABAJADOR)
  @Get('workflow')
  get(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<WorkflowView> {
    return this.queries.getWorkflowFor(user.id, orderId);
  }

  // --- Trabajador asignado -------------------------------------------------

  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Post('visit')
  registerVisit(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.workflow.registerVisit(user.id, orderId);
  }

  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Post('visit/payment-confirmation')
  @HttpCode(HttpStatus.OK)
  confirmVisitPayment(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.workflow.confirmVisitPayment(user.id, orderId);
  }

  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Post('start')
  @HttpCode(HttpStatus.OK)
  start(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.workflow.startWork(user.id, orderId);
  }

  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Post('additional-budgets')
  createAdditionalBudget(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateAdditionalBudgetDto,
  ) {
    return this.workflow.createAdditionalBudget(user.id, orderId, dto);
  }

  @UseGuards(ApprovedWorkerGuard)
  @Auth(RoleName.TRABAJADOR)
  @Post('finish')
  @HttpCode(HttpStatus.OK)
  finish(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.workflow.finishWork(user.id, orderId);
  }

  // --- Cliente dueno -------------------------------------------------------

  @Auth(RoleName.CLIENTE)
  @Post('additional-budgets/:budgetId/accept')
  @HttpCode(HttpStatus.OK)
  acceptAdditionalBudget(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('budgetId', ParseUUIDPipe) budgetId: string,
  ) {
    return this.workflow.acceptAdditionalBudget(user.id, orderId, budgetId);
  }

  @Auth(RoleName.CLIENTE)
  @Post('confirm-conformity')
  @HttpCode(HttpStatus.OK)
  confirmConformity(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.workflow.confirmConformity(user.id, orderId);
  }

  @Auth(RoleName.CLIENTE)
  @Post('cancel-work')
  @HttpCode(HttpStatus.OK)
  cancelWork(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CancelWorkDto,
  ): Promise<OwnerOrderView> {
    return this.workflow.cancelWork(user.id, orderId, dto);
  }

  @Auth(RoleName.CLIENTE)
  @Post('no-show')
  @HttpCode(HttpStatus.OK)
  reportNoShow(
    @CurrentUser() user: PublicUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: ReportNoShowDto,
  ) {
    return this.workflow.reportNoShow(user.id, orderId, dto);
  }
}
