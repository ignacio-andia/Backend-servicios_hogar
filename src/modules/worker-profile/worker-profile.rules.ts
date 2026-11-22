import { WorkerProfileStatus } from '../../generated/prisma/enums.js';
import { ActiveWorkKind } from './active-work.registry.js';

// Estados en los que el trabajador puede corregir datos, especialidades y
// documentos (CU-06 A2 y CU-07: completando o corrigiendo su perfil).
// RECHAZADO no es terminal (v1.0 §5): el trabajador corrige y vuelve a
// enviar; el rechazo y su motivo quedan en el historial. La zona sigue fija
// fuera de BORRADOR (RF-13, decision del equipo).
export const EDITABLE_STATUSES: readonly WorkerProfileStatus[] = [
  WorkerProfileStatus.BORRADOR,
  WorkerProfileStatus.OBSERVADO,
  WorkerProfileStatus.RECHAZADO,
];

// Estados desde los que el trabajador puede enviar el perfil a revision
// (BORRADOR -> PENDIENTE; OBSERVADO o RECHAZADO -> PENDIENTE, como reenvio).
export const SUBMITTABLE_STATUSES = EDITABLE_STATUSES;

// La zona solo se elige directamente antes del primer envio (RF-13).
export const ZONE_DIRECTLY_EDITABLE_STATUS = WorkerProfileStatus.BORRADOR;

/**
 * Estados del perfil desde los que se puede pedir un cambio de zona: solo
 * APROBADO (especificacion v1.0 §4, T4.2). BORRADOR elige la zona
 * directamente; PENDIENTE, OBSERVADO, RECHAZADO y SUSPENDIDO no pueden pedirla.
 */
export const ZONE_REQUEST_ALLOWED_STATUSES: readonly WorkerProfileStatus[] = [
  WorkerProfileStatus.APROBADO,
];

/**
 * Estados del perfil para los que un administrador no puede aprobar una
 * solicitud pendiente (especificacion v1.0 §4). Se vuelve a leer con la fila
 * del trabajador bloqueada, dentro de la transaccion de la decision.
 */
export const ZONE_APPROVAL_BLOCKED_STATUSES: readonly WorkerProfileStatus[] = [
  WorkerProfileStatus.SUSPENDIDO,
  WorkerProfileStatus.RECHAZADO,
];

export interface ZoneChangePolicy {
  /**
   * Si el administrador debe indicar un motivo no vacio al rechazar.
   * Confirmado por la especificacion v1.0 §4 (T4.2): es obligatorio.
   */
  rejectionCommentRequired: boolean;
  /** Trabajo activo que impide pedir el cambio (regla confirmada). */
  activeWorkSources: readonly ActiveWorkKind[];
  /**
   * PENDIENTE DE CONFIRMAR CON EL DOCENTE: si al aprobar se vuelve a verificar
   * que el trabajador no tenga pedidos u ofertas activos. La verificacion esta
   * implementada (dentro de la transaccion y con la fila del trabajador
   * bloqueada) pero desactivada: la regla confirmada solo habla de solicitar.
   */
  recheckActiveWorkOnApproval: boolean;
}

/**
 * Politica de solicitudes de cambio de zona (RF-13), centralizada aqui.
 *
 * PENDIENTE DE CONFIRMAR CON EL DOCENTE (B): si al aprobar un cambio de zona
 * el perfil debe volver a revision. Hoy la aprobacion solo reemplaza la zona;
 * el efecto esta aislado en ZoneChangeRequestsService.applyApprovedChange
 * para poder agregarlo sin cambiar la entidad ni el flujo.
 */
export const ZONE_CHANGE_POLICY: ZoneChangePolicy = {
  rejectionCommentRequired: true,
  activeWorkSources: [ActiveWorkKind.PEDIDOS, ActiveWorkKind.OFERTAS],
  recheckActiveWorkOnApproval: false,
};

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

/**
 * Estados que un administrador puede asignar por HTTP (destinos de
 * ADMIN_TRANSITIONS). Que la transicion sea valida desde el estado actual lo
 * decide ADMIN_TRANSITIONS en el servicio.
 */
export const ADMIN_TARGET_STATUSES = [
  WorkerProfileStatus.APROBADO,
  WorkerProfileStatus.OBSERVADO,
  WorkerProfileStatus.RECHAZADO,
  WorkerProfileStatus.SUSPENDIDO,
] as const;

/**
 * Mientras el trabajador tenga una solicitud de cambio de zona PENDIENTE no
 * puede participar en trabajos nuevos (especificacion v1.0 §4, T4.3): ni
 * ofertar ni recibir asignaciones. No afecta a los trabajos que ya tiene.
 * Lo aplica WorkerProfileService.lockApprovedWorker, que usan la asignacion
 * de pedidos y el futuro modulo de ofertas (OrderVisibilityService.assertOpenForOffers).
 */
export const PENDING_ZONE_CHANGE_BLOCKS_NEW_WORK_MESSAGE =
  'Tiene una solicitud de cambio de zona pendiente: no puede ofertar ni tomar trabajos nuevos hasta que se resuelva o la retire.';

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
    'Su perfil de trabajador fue rechazado y no puede ofrecer servicios. Puede corregirlo y volver a enviarlo a revisión.',
  SUSPENDIDO: 'Su perfil de trabajador está suspendido.',
};
