import { WorkerProfileStatus } from '../../generated/prisma/enums.js';

// Estados en los que el trabajador puede corregir datos, especialidades y
// documentos (CU-06 A2 y CU-07: completando o corrigiendo su perfil).
export const EDITABLE_STATUSES: readonly WorkerProfileStatus[] = [
  WorkerProfileStatus.BORRADOR,
  WorkerProfileStatus.OBSERVADO,
];

// Estados desde los que el trabajador puede enviar el perfil a revision.
export const SUBMITTABLE_STATUSES = EDITABLE_STATUSES;

// La zona solo se elige directamente antes del primer envio (RF-13).
export const ZONE_DIRECTLY_EDITABLE_STATUS = WorkerProfileStatus.BORRADOR;

// Estados desde los que no tiene sentido pedir un cambio de zona.
export const ZONE_REQUEST_BLOCKED_STATUSES: readonly WorkerProfileStatus[] = [
  WorkerProfileStatus.BORRADOR,
  WorkerProfileStatus.RECHAZADO,
];

/**
 * Cambios de estado que solo puede hacer un administrador (modulo de
 * verificacion, RF-10 y RF-47). El trabajador nunca llega a estos estados.
 */
export const ADMIN_TRANSITIONS: Readonly<
  Partial<Record<WorkerProfileStatus, readonly WorkerProfileStatus[]>>
> = {
  [WorkerProfileStatus.PENDIENTE]: [
    WorkerProfileStatus.APROBADO,
    WorkerProfileStatus.OBSERVADO,
    WorkerProfileStatus.RECHAZADO,
  ],
  [WorkerProfileStatus.APROBADO]: [WorkerProfileStatus.SUSPENDIDO],
  [WorkerProfileStatus.SUSPENDIDO]: [WorkerProfileStatus.APROBADO],
};

// Decisiones que deben explicarse al trabajador (RF-10 y CU-03 A1).
export const STATUSES_REQUIRING_REASON: readonly WorkerProfileStatus[] = [
  WorkerProfileStatus.OBSERVADO,
  WorkerProfileStatus.RECHAZADO,
  WorkerProfileStatus.SUSPENDIDO,
];

// Mensajes de CU-03 para quien aun no puede usar funciones de trabajador.
export const NOT_APPROVED_MESSAGES: Readonly<
  Record<WorkerProfileStatus, string>
> = {
  BORRADOR:
    'Su perfil de trabajador aún no fue enviado a revisión. Complételo y envíelo.',
  PENDIENTE: 'Su perfil de trabajador está pendiente de revisión.',
  OBSERVADO:
    'Su perfil de trabajador tiene observaciones. Corríjalo y vuelva a enviarlo.',
  APROBADO: 'Su perfil de trabajador está aprobado.',
  RECHAZADO:
    'Su perfil de trabajador fue rechazado y no puede ofrecer servicios.',
  SUSPENDIDO: 'Su perfil de trabajador está suspendido.',
};
