import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApprovedWorkerGuard,
  ApprovedWorkerRequest,
} from './approved-worker.guard.js';
import { WorkerProfileService } from './worker-profile.service.js';

const contextFor = (request: ApprovedWorkerRequest) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('ApprovedWorkerGuard', () => {
  const approved = {
    profileId: 'p',
    userId: 'u',
    zoneId: 'z',
    categoryIds: ['c'],
  };

  it('exige un usuario autenticado', async () => {
    const guard = new ApprovedWorkerGuard({} as WorkerProfileService);

    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('bloquea perfiles no aprobados', async () => {
    const service = {
      assertWorkerApproved: vi
        .fn()
        .mockRejectedValue(new ForbiddenException('pendiente')),
    };
    const guard = new ApprovedWorkerGuard(
      service as unknown as WorkerProfileService,
    );

    await expect(
      guard.canActivate(contextFor({ user: { id: 'u' } as never })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deja pasar perfiles aprobados y adjunta el perfil al request', async () => {
    const service = {
      assertWorkerApproved: vi.fn().mockResolvedValue(approved),
    };
    const guard = new ApprovedWorkerGuard(
      service as unknown as WorkerProfileService,
    );
    const request: ApprovedWorkerRequest = { user: { id: 'u' } as never };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.approvedWorker).toBe(approved);
    expect(service.assertWorkerApproved).toHaveBeenCalledWith('u');
  });
});
