import {
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../../common/decorators/trim.decorator.js';
import type { WorkerProfileStatus } from '../../../generated/prisma/enums.js';
import {
  ADMIN_TARGET_STATUSES,
  STATUSES_REQUIRING_REASON,
} from '../worker-profile.rules.js';

// Igual que worker_profile_status_history.reason (VARCHAR 1000).
export const STATUS_REASON_MAX_LENGTH = 1000;

export type AdminTargetStatus = (typeof ADMIN_TARGET_STATUSES)[number];

const requiresReason = (dto: ChangeWorkerProfileStatusDto): boolean =>
  STATUSES_REQUIRING_REASON.includes(dto.status as WorkerProfileStatus);

/**
 * Decision administrativa sobre un perfil (RF-10, RF-47). El motivo es
 * obligatorio y no puede estar vacio para OBSERVADO, RECHAZADO y SUSPENDIDO:
 * es lo que el trabajador ve para corregir su solicitud. Al aprobar es
 * opcional, pero si se envia tampoco puede estar vacio.
 */
export class ChangeWorkerProfileStatusDto {
  @IsIn(ADMIN_TARGET_STATUSES, {
    message: `status debe ser uno de: ${ADMIN_TARGET_STATUSES.join(', ')}`,
  })
  status: AdminTargetStatus;

  @Trim()
  @ValidateIf(
    (dto: ChangeWorkerProfileStatusDto, value: unknown) =>
      requiresReason(dto) || value !== undefined,
  )
  @IsString({ message: 'reason debe ser un texto' })
  @IsNotEmpty({
    message:
      'reason es obligatorio y no puede estar vacío para OBSERVADO, RECHAZADO y SUSPENDIDO',
  })
  @MaxLength(STATUS_REASON_MAX_LENGTH)
  reason?: string;
}
