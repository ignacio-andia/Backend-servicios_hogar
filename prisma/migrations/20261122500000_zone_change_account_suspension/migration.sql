-- T4-F3: al suspender una cuenta de usuario se cancelan sus solicitudes de
-- cambio de zona pendientes, con una causa distinta de la suspension del perfil.
-- Solo agrega un valor de enum: no modifica ni borra datos. Requiere
-- PostgreSQL 12 o superior. Los CHECK existentes siguen valiendo (decided_by_id
-- es el administrador que suspendio la cuenta; la causa solo en CANCELADA).
ALTER TYPE "ZoneChangeCancellationCause" ADD VALUE 'SUSPENSION_CUENTA';
