import type { Prisma } from '../../generated/prisma/client.js';
import { CatalogKind, CatalogsService } from '../catalogs/catalogs.service.js';
import { CatalogRef, toRef } from './order-views.js';

// Auxiliares internos compartidos por los servicios de OrdersModule.

export interface CatalogRefs {
  categories: Map<string, CatalogRef>;
  zones: Map<string, CatalogRef>;
}

/** Hora de la BD: todas las comparaciones de vencimiento usan este reloj. */
export async function dbNow(db: Prisma.TransactionClient): Promise<Date> {
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return now;
}

/** Categorias y zonas de los pedidos, con su estado, en dos consultas. */
export async function catalogRefs(
  catalogs: CatalogsService,
  orders: { categoryId: string; zoneId: string }[],
): Promise<CatalogRefs> {
  const [categories, zones] = await Promise.all([
    catalogs.findByIds(
      CatalogKind.CATEGORY,
      orders.map((order) => order.categoryId),
    ),
    catalogs.findByIds(
      CatalogKind.ZONE,
      orders.map((order) => order.zoneId),
    ),
  ]);
  return {
    categories: new Map(categories.map((item) => [item.id, toRef(item)])),
    zones: new Map(zones.map((item) => [item.id, toRef(item)])),
  };
}
