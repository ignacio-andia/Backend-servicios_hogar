import { BadRequestException, Injectable } from '@nestjs/common';
import { CatalogKind, CatalogsService } from '../catalogs/catalogs.service.js';
import { ClaimsService } from '../claims/claims.service.js';
import { OrdersService } from '../orders/orders.service.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import { WorkerProfileService } from '../worker-profile/worker-profile.service.js';
import {
  countBy,
  type ReportCell,
  type ReportRange,
  toReportRange,
} from './report-format.js';

export const REPORT_TYPES = [
  'pedidos',
  'trabajadores',
  'calificaciones',
  'cancelaciones',
  'reclamos',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const EMPTY_REPORT_MESSAGE = 'No hay datos en el rango indicado.';

export interface Report {
  report: ReportType;
  from: string;
  to: string;
  /** Que fecha de cada registro decide si entra en el rango. */
  basis: string;
  columns: string[];
  rows: ReportCell[][];
  total: number;
  message: string | null;
}

interface Table {
  basis: string;
  columns: string[];
  /** Una fila por registro; se agrupan y cuentan. */
  records: ReportCell[][];
}

type Located = { categoryId: string; zoneId: string };

/**
 * Reportes administrativos (RF-52). Solo lectura: cada modulo entrega sus
 * propios registros, sin datos personales, y aqui se agrupan y cuentan.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly orders: OrdersService,
    private readonly workerProfiles: WorkerProfileService,
    private readonly reviews: ReviewsService,
    private readonly claims: ClaimsService,
    private readonly catalogs: CatalogsService,
  ) {}

  async build(type: ReportType, from: string, to: string): Promise<Report> {
    const range = toReportRange(from, to);
    if (!range) {
      throw new BadRequestException(
        'Rango de fechas no válido: use fechas existentes con from anterior o igual a to.',
      );
    }
    const { basis, columns, records } = await this.table(type, range);
    return {
      report: type,
      from,
      to,
      basis,
      columns: [...columns, 'total'],
      rows: countBy(records),
      total: records.length,
      message: records.length === 0 ? EMPTY_REPORT_MESSAGE : null,
    };
  }

  private async table(type: ReportType, range: ReportRange): Promise<Table> {
    switch (type) {
      case 'pedidos': {
        const rows = await this.orders.listForReport(range);
        const name = await this.names(rows);
        return {
          basis: 'fecha de publicación del pedido',
          columns: ['categoria', 'zona', 'estado'],
          records: rows.map((r) => [...name(r), r.status]),
        };
      }
      case 'cancelaciones': {
        const rows = await this.orders.listCancellationsForReport(range);
        const name = await this.names(rows);
        return {
          basis: 'fecha de la cancelación',
          columns: ['categoria', 'zona', 'estado_anterior'],
          records: rows.map((r) => [...name(r), r.fromStatus]),
        };
      }
      case 'trabajadores': {
        const rows = await this.workerProfiles.listForReport(range);
        const zones = await this.zoneNames(rows.map((r) => r.zoneId));
        return {
          basis: 'fecha de creación del perfil (estado actual)',
          columns: ['zona', 'estado'],
          records: rows.map((r) => [zones(r.zoneId), r.status]),
        };
      }
      case 'calificaciones': {
        const rows = await this.reviews.listForReport(range);
        return {
          basis: 'fecha de la calificación',
          columns: ['autor', 'estrellas', 'visible'],
          records: rows.map((r) => [
            r.authorRole,
            r.rating,
            r.hidden ? 'no' : 'si',
          ]),
        };
      }
      case 'reclamos': {
        const rows = await this.claims.listForReport(range);
        const name = await this.names(rows);
        return {
          basis: 'fecha de presentación del reclamo (estado actual)',
          columns: ['categoria', 'zona', 'estado'],
          records: rows.map((r) => [...name(r), r.status]),
        };
      }
    }
  }

  private async zoneNames(ids: string[]) {
    const zones = await this.catalogs.findByIds(CatalogKind.ZONE, ids);
    const names = new Map(zones.map((zone) => [zone.id, zone.name]));
    return (id: string) => names.get(id) ?? id;
  }

  /** Nombres de categoria y zona de cada registro. */
  private async names(rows: Located[]) {
    const categories = await this.catalogs.findByIds(
      CatalogKind.CATEGORY,
      rows.map((row) => row.categoryId),
    );
    const byId = new Map(categories.map((item) => [item.id, item.name]));
    const zone = await this.zoneNames(rows.map((row) => row.zoneId));
    return (row: Located): [string, string] => [
      byId.get(row.categoryId) ?? row.categoryId,
      zone(row.zoneId),
    ];
  }
}
