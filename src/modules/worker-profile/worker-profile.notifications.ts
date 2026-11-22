import {
  NotificationResourceType,
  NotificationType,
  WorkerProfileStatus,
} from '../../generated/prisma/enums.js';
import type { NewNotification } from '../notifications/notifications.service.js';

// Textos de las notificaciones de verificacion de perfiles (T3.2). Viven en
// este modulo porque dependen de sus reglas; el de notificaciones solo las
// guarda. Al administrador no se le envian datos personales del trabajador:
// el id del perfil basta para abrir el detalle (#57).

const profileResource = (profileId: string) => ({
  type: NotificationResourceType.PERFIL_TRABAJADOR,
  id: profileId,
});

const withReason = (text: string, label: string, reason: string | null) =>
  reason ? `${text} ${label}: ${reason}` : text;

/**
 * Notificacion para el trabajador sobre una decision administrativa. El
 * motivo es privado: solo lo recibe el dueno del perfil.
 */
export function decisionNotification(
  profileId: string,
  from: WorkerProfileStatus,
  to: WorkerProfileStatus,
  reason: string | null,
): NewNotification {
  const resource = profileResource(profileId);
  switch (to) {
    case WorkerProfileStatus.APROBADO:
      return from === WorkerProfileStatus.SUSPENDIDO
        ? {
            type: NotificationType.PERFIL_REACTIVADO,
            title: 'Perfil de trabajador reactivado',
            message: withReason(
              'Su perfil de trabajador fue reactivado. Ya puede volver a atender pedidos.',
              'Comentario',
              reason,
            ),
            resource,
          }
        : {
            type: NotificationType.PERFIL_APROBADO,
            title: 'Perfil de trabajador aprobado',
            message: withReason(
              'Su perfil de trabajador fue aprobado. Ya puede ver y atender pedidos de su zona.',
              'Comentario',
              reason,
            ),
            resource,
          };
    case WorkerProfileStatus.OBSERVADO:
      return {
        type: NotificationType.PERFIL_OBSERVADO,
        title: 'Perfil de trabajador con observaciones',
        message: withReason(
          'Su perfil de trabajador tiene observaciones. Corríjalo y vuelva a enviarlo a revisión.',
          'Motivo',
          reason,
        ),
        resource,
      };
    case WorkerProfileStatus.RECHAZADO:
      return {
        type: NotificationType.PERFIL_RECHAZADO,
        title: 'Perfil de trabajador rechazado',
        message: withReason(
          'Su perfil de trabajador fue rechazado. Puede corregirlo y volver a enviarlo a revisión.',
          'Motivo',
          reason,
        ),
        resource,
      };
    case WorkerProfileStatus.SUSPENDIDO:
      return {
        type: NotificationType.PERFIL_SUSPENDIDO,
        title: 'Perfil de trabajador suspendido',
        message: withReason(
          'Su perfil de trabajador fue suspendido y no puede atender pedidos.',
          'Motivo',
          reason,
        ),
        resource,
      };
    default:
      // ADMIN_TRANSITIONS nunca lleva a BORRADOR ni a PENDIENTE.
      throw new Error(`Decision administrativa sin notificacion: ${to}`);
  }
}

/**
 * Notificacion para los administradores cuando un trabajador envia su perfil
 * a verificacion. El tipo distingue el primer envio de los reenvios.
 */
export function submissionNotification(
  profileId: string,
  from: WorkerProfileStatus,
): NewNotification {
  const resource = profileResource(profileId);
  switch (from) {
    case WorkerProfileStatus.OBSERVADO:
      return {
        type: NotificationType.VERIFICACION_REENVIADA_OBSERVACION,
        title: 'Solicitud de verificación reenviada',
        message:
          'Un trabajador corrigió las observaciones de su perfil y lo reenvió a verificación.',
        resource,
      };
    case WorkerProfileStatus.RECHAZADO:
      return {
        type: NotificationType.VERIFICACION_REENVIADA_RECHAZO,
        title: 'Solicitud de verificación reenviada tras un rechazo',
        message:
          'Un trabajador corrigió su perfil rechazado y lo reenvió a verificación.',
        resource,
      };
    default:
      return {
        type: NotificationType.VERIFICACION_SOLICITADA,
        title: 'Nueva solicitud de verificación',
        message: 'Un trabajador envió su perfil a verificación.',
        resource,
      };
  }
}

// ---------------------------------------------------------------------------
// Solicitudes de cambio de zona (T4.2). Solo las recibe el trabajador dueno de
// la solicitud; el motivo del rechazo es privado.
// ---------------------------------------------------------------------------

const zoneRequestResource = (requestId: string) => ({
  type: NotificationResourceType.SOLICITUD_CAMBIO_ZONA,
  id: requestId,
});

export interface ZoneRequestNames {
  fromZone: string;
  toZone: string;
}

/** Resultado de la decision administrativa sobre una solicitud. */
export function zoneRequestDecisionNotification(
  requestId: string,
  decision: 'APROBADA' | 'RECHAZADA',
  { fromZone, toZone }: ZoneRequestNames,
  comment: string | null,
): NewNotification {
  const resource = zoneRequestResource(requestId);
  return decision === 'APROBADA'
    ? {
        type: NotificationType.SOLICITUD_ZONA_APROBADA,
        title: 'Cambio de zona aprobado',
        message: withReason(
          `Su solicitud de cambio de zona fue aprobada. Su nueva zona de atención es "${toZone}".`,
          'Comentario',
          comment,
        ),
        resource,
      }
    : {
        type: NotificationType.SOLICITUD_ZONA_RECHAZADA,
        title: 'Cambio de zona rechazado',
        message: withReason(
          `Su solicitud de cambio a la zona "${toZone}" fue rechazada. Conserva su zona "${fromZone}".`,
          'Motivo',
          comment,
        ),
        resource,
      };
}

/** Cancelacion automatica de la solicitud pendiente al suspender el perfil. */
export function zoneRequestCancelledBySuspensionNotification(
  requestId: string,
  { fromZone, toZone }: ZoneRequestNames,
): NewNotification {
  return {
    type: NotificationType.SOLICITUD_ZONA_CANCELADA,
    title: 'Solicitud de cambio de zona cancelada',
    message: `Su solicitud de cambio a la zona "${toZone}" se canceló porque su perfil de trabajador fue suspendido. Conserva su zona "${fromZone}".`,
    resource: zoneRequestResource(requestId),
  };
}

/**
 * Aviso al trabajador RECHAZADO de que un administrador le asigno otra zona
 * porque la suya fue desactivada (T4.4). La justificacion queda en la
 * bitacora; el aviso solo informa el cambio y como seguir.
 */
export function zoneReassignedNotification(
  profileId: string,
  { fromZone, toZone }: ZoneRequestNames,
): NewNotification {
  return {
    type: NotificationType.ZONA_REASIGNADA,
    title: 'Zona de atención reasignada',
    message: `Su zona "${fromZone}" fue desactivada y un administrador le asignó la zona "${toZone}". Puede corregir su perfil y volver a enviarlo a revisión.`,
    resource: profileResource(profileId),
  };
}

/** Confirmacion al trabajador de que retiro su solicitud pendiente (T4.3). */
export function zoneRequestWithdrawnNotification(
  requestId: string,
  { fromZone, toZone }: ZoneRequestNames,
): NewNotification {
  return {
    type: NotificationType.SOLICITUD_ZONA_RETIRADA,
    title: 'Solicitud de cambio de zona retirada',
    message: `Retiró su solicitud de cambio a la zona "${toZone}". Conserva su zona "${fromZone}" y ya puede volver a ofertar y tomar trabajos en ella.`,
    resource: zoneRequestResource(requestId),
  };
}
