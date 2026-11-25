import type { Prisma } from '../../generated/prisma/client.js';
import { OfferStatus } from '../../generated/prisma/enums.js';
import { ORDER_OPEN_FOR_OFFERS_STATUSES } from '../orders/orders.rules.js';

/**
 * Cuantas ofertas en negociacion abierta cumplen `filter`: VIGENTE, sin vencer
 * (reloj de la BD) y de un pedido PUBLICADO o EN_NEGOCIACION que tampoco
 * vencio. Una oferta ACEPTADA no cuenta (ese trabajo lo representa el pedido
 * asignado) ni ninguna otra cerrada. Solo lectura, con `db`, la transaccion
 * del llamador.
 */
export async function countOpenOffers(
  db: Prisma.TransactionClient,
  filter: { workerId: string; orderId?: string },
): Promise<number> {
  return db.offer.count({ where: await openOfferWhere(db, filter) });
}

/** Pedidos en los que el trabajador tiene una oferta abierta (mismo criterio). */
export async function findOpenOfferOrderIds(
  db: Prisma.TransactionClient,
  workerId: string,
): Promise<string[]> {
  const offers = await db.offer.findMany({
    where: await openOfferWhere(db, { workerId }),
    select: { orderId: true },
  });
  return offers.map((offer) => offer.orderId);
}

async function openOfferWhere(
  db: Prisma.TransactionClient,
  filter: { workerId: string; orderId?: string },
): Promise<Prisma.OfferWhereInput> {
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return {
    ...filter,
    status: OfferStatus.VIGENTE,
    expiresAt: { gt: now },
    order: {
      status: { in: [...ORDER_OPEN_FOR_OFFERS_STATUSES] },
      expiresAt: { gt: now },
    },
  };
}
