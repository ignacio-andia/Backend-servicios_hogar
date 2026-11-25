-- RF-53: la bitacora administrativa registra tambien las decisiones sobre
-- reclamos y los cambios de estado de las cuentas. Solo agrega valores al
-- enum: no modifica tablas ni datos.
ALTER TYPE "AuditEntityType" ADD VALUE 'RECLAMO';
ALTER TYPE "AuditEntityType" ADD VALUE 'USUARIO';
