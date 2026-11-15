import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Tipos de trabajo activo que impiden pedir un cambio de zona (RF-13).
 * OrdersModule registra PEDIDOS; OFERTAS la registrara el modulo de ofertas.
 */
export const ActiveWorkKind = {
  PEDIDOS: 'PEDIDOS',
  OFERTAS: 'OFERTAS',
} as const;
export type ActiveWorkKind =
  (typeof ActiveWorkKind)[keyof typeof ActiveWorkKind];

/**
 * Consulta que aportara cada modulo dueno de los datos. La definicion de
 * "activo" pertenece a ese modulo, no a WorkerProfileModule. Debe leer con
 * `db`, que es la transaccion del llamador, para que el conteo y la decision
 * se tomen dentro de la misma transaccion.
 */
export interface ActiveWorkSource {
  readonly kind: ActiveWorkKind;
  countActive(
    workerUserId: string,
    db: Prisma.TransactionClient,
  ): Promise<number>;
}

export type ActiveWorkCheck =
  | { verifiable: true; counts: Record<ActiveWorkKind, number> }
  | { verifiable: false; missingSources: ActiveWorkKind[] };

/**
 * Punto de integracion con pedidos y ofertas sin dependencia circular: esos
 * modulos importaran WorkerProfileModule (por ApprovedWorkerGuard), asi que
 * son ellos quienes registran aqui su consulta, por ejemplo en onModuleInit:
 *
 *   registry.register({
 *     kind: ActiveWorkKind.OFERTAS,
 *     countActive: (workerUserId, db) => db.<modelo>.count({ ... }),
 *   });
 *
 * Mientras falte alguna fuente, check() lo informa y no se acepta la operacion.
 *
 * Para evitar condiciones de carrera, toda operacion que cree o cambie trabajo
 * de un trabajador (enviar una oferta, asignar un pedido) y toda decision de
 * cambio de zona debe llamar a lockWorker() dentro de su transaccion antes de
 * leer o escribir: asi esas operaciones se ejecutan de a una por trabajador.
 * Para ofertas y asignaciones conviene WorkerProfileService.lockApprovedWorker,
 * que ademas relee el perfil aprobado con el bloqueo.
 *
 * ORDEN DE BLOQUEOS DEL PROYECTO: primero el trabajador, despues el pedido
 * y al final los catalogos (CatalogsService.findByIdsForShare).
 * Ninguna operacion que ya tenga bloqueado un pedido puede llamar a
 * lockWorker() (por ejemplo, los hooks de OrderLifecycleRegistry): el orden
 * inverso puede producir un deadlock.
 */
@Injectable()
export class WorkerActiveWorkRegistry {
  private readonly sources = new Map<ActiveWorkKind, ActiveWorkSource>();

  register(source: ActiveWorkSource): void {
    if (this.sources.has(source.kind)) {
      throw new Error(`Ya hay una fuente registrada para ${source.kind}`);
    }
    this.sources.set(source.kind, source);
  }

  async check(
    workerUserId: string,
    required: readonly ActiveWorkKind[],
    db: Prisma.TransactionClient,
  ): Promise<ActiveWorkCheck> {
    const missingSources = required.filter((kind) => !this.sources.has(kind));
    if (missingSources.length > 0) {
      return { verifiable: false, missingSources };
    }
    const entries = await Promise.all(
      required.map(
        async (kind) =>
          [
            kind,
            await this.sources.get(kind)!.countActive(workerUserId, db),
          ] as const,
      ),
    );
    return {
      verifiable: true,
      counts: Object.fromEntries(entries) as Record<ActiveWorkKind, number>,
    };
  }

  /**
   * Bloquea la fila del perfil del trabajador hasta que termine la
   * transaccion `db` (SELECT ... FOR UPDATE). Las demas operaciones que
   * llamen a este metodo para el mismo trabajador esperan su turno.
   */
  async lockWorker(
    db: Prisma.TransactionClient,
    workerUserId: string,
  ): Promise<void> {
    await db.$queryRaw`SELECT "id" FROM "worker_profiles" WHERE "user_id" = ${workerUserId}::uuid FOR UPDATE`;
  }
}
