import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { PublicUser } from '../users/users.service.js';
import {
  ApprovedWorker,
  WorkerProfileService,
} from './worker-profile.service.js';

export interface ApprovedWorkerRequest {
  user?: PublicUser;
  approvedWorker?: ApprovedWorker;
}

/**
 * Para endpoints de funciones de trabajador (ofertar, recibir pedidos):
 * solo deja pasar perfiles APROBADOS (RF-03, RF-09). Se usa despues de
 * JwtAuthGuard y deja el perfil en `request.approvedWorker`.
 * Los modulos que lo usen deben importar WorkerProfileModule.
 */
@Injectable()
export class ApprovedWorkerGuard implements CanActivate {
  constructor(private readonly workerProfiles: WorkerProfileService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApprovedWorkerRequest>();
    if (!request.user) {
      throw new UnauthorizedException();
    }
    request.approvedWorker = await this.workerProfiles.assertWorkerApproved(
      request.user.id,
    );
    return true;
  }
}
