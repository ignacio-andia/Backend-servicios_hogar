-- T4.2: cancelacion automatica de solicitudes de cambio de zona al suspender el
-- perfil, y notificaciones del resultado de una solicitud. Solo agrega tipos,
-- valores de enum, una columna nula y un CHECK: no modifica ni borra datos.
-- Requiere PostgreSQL 12 o superior (ALTER TYPE ... ADD VALUE en transaccion).

-- Causa de una cancelacion automatica (no es una decision administrativa).
CREATE TYPE "ZoneChangeCancellationCause" AS ENUM ('SUSPENSION_PERFIL');

-- Nuevo estado final de una solicitud. El CHECK de resolucion existente
-- (decided_at y decided_by_id obligatorios fuera de PENDIENTE) tambien se
-- aplica: en una cancelacion registran quien la provoco y cuando.
ALTER TYPE "ZoneChangeRequestStatus" ADD VALUE 'CANCELADA';

ALTER TABLE "zone_change_requests" ADD COLUMN "cancellation_cause" "ZoneChangeCancellationCause";

-- La causa existe solo en las solicitudes CANCELADA. Se compara como texto
-- porque un valor de enum recien agregado no puede usarse en la misma
-- transaccion. Las filas existentes no son CANCELADA y tienen la causa nula.
ALTER TABLE "zone_change_requests" ADD CONSTRAINT "zone_change_requests_cancellation_check"
    CHECK (("status"::text = 'CANCELADA') = ("cancellation_cause" IS NOT NULL));

-- Notificaciones del resultado de una solicitud de cambio de zona.
ALTER TYPE "NotificationType" ADD VALUE 'SOLICITUD_ZONA_APROBADA';
ALTER TYPE "NotificationType" ADD VALUE 'SOLICITUD_ZONA_RECHAZADA';
ALTER TYPE "NotificationType" ADD VALUE 'SOLICITUD_ZONA_CANCELADA';
ALTER TYPE "NotificationResourceType" ADD VALUE 'SOLICITUD_CAMBIO_ZONA';
