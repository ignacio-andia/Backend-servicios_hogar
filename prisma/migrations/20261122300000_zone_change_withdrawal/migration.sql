-- T4.3: retiro voluntario de una solicitud de cambio de zona. Solo agrega
-- valores de enum: no modifica ni borra datos. Requiere PostgreSQL 12 o superior.

-- El trabajador retira su solicitud pendiente: queda CANCELADA con esta causa.
-- Los CHECK existentes siguen valiendo: decided_at y decided_by_id (aqui el
-- propio trabajador) son obligatorios fuera de PENDIENTE, y la causa solo
-- existe en CANCELADA.
ALTER TYPE "ZoneChangeCancellationCause" ADD VALUE 'RETIRO_TRABAJADOR';

-- Confirmacion al trabajador de que retiro su solicitud.
ALTER TYPE "NotificationType" ADD VALUE 'SOLICITUD_ZONA_RETIRADA';
