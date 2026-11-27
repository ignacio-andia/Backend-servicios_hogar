import {
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { RoleName } from '../../generated/prisma/enums.js';
import { Auth } from '../auth/decorators/auth.decorator.js';
import { FinancialReportQueryDto } from './dto/financial-report-query.dto.js';
import { ReportQueryDto } from './dto/report-query.dto.js';
import { toCsv } from './report-format.js';
import {
  type FinancialReport,
  type Report,
  REPORT_TYPES,
  ReportsService,
  type ReportType,
} from './reports.service.js';

const REPORT_TYPE_ENUM = Object.fromEntries(
  REPORT_TYPES.map((type) => [type, type]),
);

/** Reportes de la plataforma (RF-52). Solo administradores. */
@Controller('admin/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Reporte financiero de servicios. Va ANTES de `:type`: Nest evalua las
   * rutas en orden y `:type` lo rechazaria. El CSV termina con una fila de
   * totales.
   */
  @Auth(RoleName.ADMINISTRADOR)
  @Get('financiero')
  async financial(
    @Query() { from, to, status, format }: FinancialReportQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FinancialReport | StreamableFile> {
    const report = await this.reports.buildFinancial(from, to, status);
    if (format === 'json') {
      return report;
    }
    const { totals } = report;
    const totalRow = [
      'TOTAL',
      `${totals.orders} pedidos`,
      '',
      '',
      '',
      '',
      '',
      '',
      totals.expected,
      totals.income,
      totals.pending,
      totals.commission,
    ];
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(
      Buffer.from(toCsv(report.columns, [...report.rows, totalRow]), 'utf8'),
      {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="reporte-financiero-${from}-${to}.csv"`,
      },
    );
  }

  /** Tabla y totales en JSON, o el mismo contenido como archivo CSV. */
  @Auth(RoleName.ADMINISTRADOR)
  @Get(':type')
  async get(
    @Param('type', new ParseEnumPipe(REPORT_TYPE_ENUM)) type: ReportType,
    @Query() { from, to, format }: ReportQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Report | StreamableFile> {
    const report = await this.reports.build(type, from, to);
    if (format === 'json') {
      return report;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(
      Buffer.from(toCsv(report.columns, report.rows), 'utf8'),
      {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="reporte-${type}-${from}-${to}.csv"`,
      },
    );
  }
}
