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
