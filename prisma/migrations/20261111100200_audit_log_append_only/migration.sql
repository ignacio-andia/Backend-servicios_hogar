-- La bitácora de administración (RF-53) es de solo inserción: no se edita ni se elimina.
-- La protección vive en la base de datos, así que también cubre errores de la aplicación
-- y consultas manuales. Prisma no gestiona triggers, por lo que no generan diferencias.
--
-- Mantenimiento excepcional (por ejemplo, limpiar datos de pruebas automatizadas):
-- dentro de una transacción, ejecutar SELECT set_config('app.audit_maintenance', 'on', true).
-- La aplicación nunca activa este ajuste.
CREATE FUNCTION "admin_audit_logs_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.audit_maintenance', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'La bitácora de administración es de solo inserción (% no permitido)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "admin_audit_logs_no_update_delete"
    BEFORE UPDATE OR DELETE ON "admin_audit_logs"
    FOR EACH ROW EXECUTE FUNCTION "admin_audit_logs_append_only"();

CREATE TRIGGER "admin_audit_logs_no_truncate"
    BEFORE TRUNCATE ON "admin_audit_logs"
    FOR EACH STATEMENT EXECUTE FUNCTION "admin_audit_logs_append_only"();
