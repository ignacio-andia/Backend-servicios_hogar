-- T4.4: aviso al trabajador RECHAZADO cuando un administrador reasigna su zona
-- porque la anterior fue desactivada. Solo agrega un valor de enum: no
-- modifica ni borra datos. Requiere PostgreSQL 12 o superior.
-- El historial y la auditoria de la reasignacion usan la bitacora existente
-- (admin_audit_logs, accion EDICION sobre PERFIL_TRABAJADOR): no necesitan
-- tablas ni columnas nuevas.
ALTER TYPE "NotificationType" ADD VALUE 'ZONA_REASIGNADA';
