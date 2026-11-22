import {
  NotificationResourceType,
  NotificationType,
  WorkerProfileStatus,
} from '../../generated/prisma/enums.js';
import {
  decisionNotification,
  submissionNotification,
} from './worker-profile.notifications.js';

const PROFILE_ID = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const S = WorkerProfileStatus;

describe('notificaciones de verificacion de perfiles', () => {
  it.each([
    [S.PENDIENTE, S.APROBADO, NotificationType.PERFIL_APROBADO],
    [S.SUSPENDIDO, S.APROBADO, NotificationType.PERFIL_REACTIVADO],
    [S.PENDIENTE, S.OBSERVADO, NotificationType.PERFIL_OBSERVADO],
    [S.PENDIENTE, S.RECHAZADO, NotificationType.PERFIL_RECHAZADO],
    [S.APROBADO, S.SUSPENDIDO, NotificationType.PERFIL_SUSPENDIDO],
  ])('decision %s -> %s usa el tipo %s', (from, to, type) => {
    const notification = decisionNotification(PROFILE_ID, from, to, 'Motivo X');

    expect(notification).toMatchObject({
      type,
      resource: {
        type: NotificationResourceType.PERFIL_TRABAJADOR,
        id: PROFILE_ID,
      },
    });
    expect(notification.message).toContain('Motivo X');
  });

  it('sin motivo el mensaje no agrega la etiqueta', () => {
    const { message } = decisionNotification(
      PROFILE_ID,
      S.PENDIENTE,
      S.APROBADO,
      null,
    );

    expect(message).toBe(
      'Su perfil de trabajador fue aprobado. Ya puede ver y atender pedidos de su zona.',
    );
  });

  it('el rechazo incluye el motivo y como seguir', () => {
    expect(
      decisionNotification(PROFILE_ID, S.PENDIENTE, S.RECHAZADO, 'Foto borrosa')
        .message,
    ).toBe(
      'Su perfil de trabajador fue rechazado. Puede corregirlo y volver a enviarlo a revisión. Motivo: Foto borrosa',
    );
  });

  it.each([S.BORRADOR, S.PENDIENTE])(
    'una decision hacia %s no tiene notificacion',
    (to) => {
      expect(() =>
        decisionNotification(PROFILE_ID, S.PENDIENTE, to, null),
      ).toThrow();
    },
  );

  it.each([
    [S.BORRADOR, NotificationType.VERIFICACION_SOLICITADA],
    [S.OBSERVADO, NotificationType.VERIFICACION_REENVIADA_OBSERVACION],
    [S.RECHAZADO, NotificationType.VERIFICACION_REENVIADA_RECHAZO],
  ])(
    'envio desde %s usa el tipo %s, sin datos del trabajador',
    (from, type) => {
      const notification = submissionNotification(PROFILE_ID, from);

      expect(notification.type).toBe(type);
      expect(notification.resource).toEqual({
        type: NotificationResourceType.PERFIL_TRABAJADOR,
        id: PROFILE_ID,
      });
      expect(notification.message).toMatch(/^Un trabajador /);
    },
  );
});
