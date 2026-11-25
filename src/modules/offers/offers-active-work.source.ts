import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  ActiveWorkKind,
  WorkerActiveWorkRegistry,
} from '../worker-profile/active-work.registry.js';
import { countOpenOffers } from './open-offers.js';

/**
 * Aporta a WorkerProfileModule (RF-13) cuantas negociaciones abiertas tiene un
 * trabajador: con alguna no puede solicitar un cambio de zona. Se registra aqui
 * para no crear una dependencia circular: OffersModule importa
 * WorkerProfileModule, no al reves.
 */
@Injectable()
export class OffersActiveWorkSource implements OnModuleInit {
  constructor(private readonly registry: WorkerActiveWorkRegistry) {}

  onModuleInit(): void {
    this.registry.register({
      kind: ActiveWorkKind.OFERTAS,
      // Usa la transaccion del llamador: el conteo y la decision van juntos.
      countActive: (workerUserId, db) =>
        countOpenOffers(db, { workerId: workerUserId }),
    });
  }
}
