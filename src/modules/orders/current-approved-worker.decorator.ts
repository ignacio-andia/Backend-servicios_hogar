import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ApprovedWorkerRequest } from '../worker-profile/approved-worker.guard.js';
import type { ApprovedWorker } from '../worker-profile/worker-profile.service.js';

/** Perfil aprobado que ApprovedWorkerGuard deja en el request. */
export const CurrentApprovedWorker = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ApprovedWorker =>
    context.switchToHttp().getRequest<ApprovedWorkerRequest>().approvedWorker!,
);
