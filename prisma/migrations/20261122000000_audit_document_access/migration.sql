-- Acciones de bitacora para el acceso administrativo a documentos de trabajadores (RF-56).
-- Solo agrega valores al enum: no modifica ni borra datos. Requiere PostgreSQL 12 o superior.
ALTER TYPE "AuditAction" ADD VALUE 'CONSULTA_DOCUMENTOS';
ALTER TYPE "AuditAction" ADD VALUE 'VISUALIZACION_DOCUMENTO';
ALTER TYPE "AuditAction" ADD VALUE 'DESCARGA_DOCUMENTO';
