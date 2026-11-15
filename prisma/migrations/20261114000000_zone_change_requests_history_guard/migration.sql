-- RF-13: el historial de solicitudes de cambio de zona no se borra ni se reescribe.
-- Prisma no gestiona CHECK ni triggers, así que no generan diferencias con schema.prisma.

-- Una solicitud PENDIENTE no tiene datos de resolución; una resuelta siempre
-- registra cuándo y qué administrador la resolvió (el comentario es opcional).
ALTER TABLE "zone_change_requests" ADD CONSTRAINT "zone_change_requests_resolution_check" CHECK (
    ("status" = 'PENDIENTE' AND "decided_at" IS NULL AND "decided_by_id" IS NULL AND "decision_comment" IS NULL)
    OR ("status" <> 'PENDIENTE' AND "decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL)
);

-- Solo se permite UPDATE para resolver una solicitud PENDIENTE, sin cambiar sus
-- datos originales (perfil, zonas, motivo, fecha). Nunca se permite DELETE.
-- Mantenimiento excepcional (limpieza de pruebas): SELECT set_config('app.audit_maintenance', 'on', true)
-- dentro de una transacción. La aplicación nunca activa ese ajuste.
CREATE FUNCTION "zone_change_requests_history_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.audit_maintenance', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Las solicitudes de cambio de zona no se pueden eliminar'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."status" <> 'PENDIENTE' THEN
        RAISE EXCEPTION 'Una solicitud de cambio de zona ya resuelta no se puede modificar'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."profile_id" IS DISTINCT FROM OLD."profile_id"
        OR NEW."from_zone_id" IS DISTINCT FROM OLD."from_zone_id"
        OR NEW."to_zone_id" IS DISTINCT FROM OLD."to_zone_id"
        OR NEW."reason" IS DISTINCT FROM OLD."reason"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'Los datos originales de una solicitud de cambio de zona no se pueden modificar'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "zone_change_requests_history_guard"
    BEFORE UPDATE OR DELETE ON "zone_change_requests"
    FOR EACH ROW EXECUTE FUNCTION "zone_change_requests_history_guard"();

-- Reutiliza la función genérica de solo inserción para impedir TRUNCATE.
CREATE TRIGGER "zone_change_requests_no_truncate"
    BEFORE TRUNCATE ON "zone_change_requests"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
