
-- CreateEnum
CREATE TYPE "WorkerProfileStatus" AS ENUM ('BORRADOR', 'PENDIENTE', 'OBSERVADO', 'APROBADO', 'RECHAZADO', 'SUSPENDIDO');

-- CreateEnum
CREATE TYPE "WeekDay" AS ENUM ('LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO');

-- CreateEnum
CREATE TYPE "WorkerDocumentType" AS ENUM ('IDENTIDAD', 'ANTECEDENTES', 'CERTIFICADO', 'REFERENCIA');

-- CreateEnum
CREATE TYPE "ZoneChangeRequestStatus" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'CAMBIO_ESTADO';
ALTER TYPE "AuditAction" ADD VALUE 'APROBACION';
ALTER TYPE "AuditAction" ADD VALUE 'RECHAZO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntityType" ADD VALUE 'PERFIL_TRABAJADOR';
ALTER TYPE "AuditEntityType" ADD VALUE 'SOLICITUD_CAMBIO_ZONA';

-- CreateTable
CREATE TABLE "worker_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "years_of_experience" SMALLINT NOT NULL,
    "description" VARCHAR(1000),
    "zone_id" UUID NOT NULL,
    "status" "WorkerProfileStatus" NOT NULL DEFAULT 'BORRADOR',
    "submitted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_specialties" (
    "profile_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_specialties_pkey" PRIMARY KEY ("profile_id","category_id")
);

-- CreateTable
CREATE TABLE "worker_schedules" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "day_of_week" "WeekDay" NOT NULL,
    "start_minutes" SMALLINT NOT NULL,
    "end_minutes" SMALLINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worker_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_documents" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "type" "WorkerDocumentType" NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replaced_at" TIMESTAMPTZ(3),
    "replaced_by_id" UUID,

    CONSTRAINT "worker_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_profile_status_history" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "from_status" "WorkerProfileStatus",
    "to_status" "WorkerProfileStatus" NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_profile_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zone_change_requests" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "from_zone_id" UUID NOT NULL,
    "to_zone_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" "ZoneChangeRequestStatus" NOT NULL DEFAULT 'PENDIENTE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "decision_comment" VARCHAR(500),

    CONSTRAINT "zone_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "worker_profiles_user_id_key" ON "worker_profiles"("user_id");

-- CreateIndex
CREATE INDEX "worker_profiles_status_zone_id_idx" ON "worker_profiles"("status", "zone_id");

-- CreateIndex
CREATE INDEX "worker_profiles_zone_id_idx" ON "worker_profiles"("zone_id");

-- CreateIndex
CREATE INDEX "worker_specialties_category_id_idx" ON "worker_specialties"("category_id");

-- CreateIndex
CREATE INDEX "worker_schedules_profile_id_day_of_week_idx" ON "worker_schedules"("profile_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "worker_documents_storage_key_key" ON "worker_documents"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "worker_documents_replaced_by_id_key" ON "worker_documents"("replaced_by_id");

-- CreateIndex
CREATE INDEX "worker_documents_profile_id_type_idx" ON "worker_documents"("profile_id", "type");

-- CreateIndex
CREATE INDEX "worker_profile_status_history_profile_id_created_at_idx" ON "worker_profile_status_history"("profile_id", "created_at");

-- CreateIndex
CREATE INDEX "zone_change_requests_profile_id_created_at_idx" ON "zone_change_requests"("profile_id", "created_at");

-- CreateIndex
CREATE INDEX "zone_change_requests_status_idx" ON "zone_change_requests"("status");

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_specialties" ADD CONSTRAINT "worker_specialties_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_specialties" ADD CONSTRAINT "worker_specialties_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_schedules" ADD CONSTRAINT "worker_schedules_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "worker_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_profile_status_history" ADD CONSTRAINT "worker_profile_status_history_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_profile_status_history" ADD CONSTRAINT "worker_profile_status_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_change_requests" ADD CONSTRAINT "zone_change_requests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_change_requests" ADD CONSTRAINT "zone_change_requests_from_zone_id_fkey" FOREIGN KEY ("from_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_change_requests" ADD CONSTRAINT "zone_change_requests_to_zone_id_fkey" FOREIGN KEY ("to_zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_change_requests" ADD CONSTRAINT "zone_change_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reglas que Prisma no modela; se agregan a mano (Prisma no las detecta como
-- diferencias, así que no hay que regenerarlas).
-- ---------------------------------------------------------------------------

-- Datos coherentes aunque se escriba fuera de la API.
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_years_of_experience_check"
    CHECK ("years_of_experience" BETWEEN 0 AND 70);
ALTER TABLE "worker_schedules" ADD CONSTRAINT "worker_schedules_interval_check"
    CHECK ("start_minutes" >= 0 AND "end_minutes" <= 1440 AND "start_minutes" < "end_minutes");
ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_size_check"
    CHECK ("size_bytes" > 0);
ALTER TABLE "zone_change_requests" ADD CONSTRAINT "zone_change_requests_different_zone_check"
    CHECK ("from_zone_id" <> "to_zone_id");

-- RF-13: como máximo una solicitud de cambio de zona PENDIENTE por perfil,
-- también ante solicitudes simultáneas.
CREATE UNIQUE INDEX "zone_change_requests_one_pending_per_profile"
    ON "zone_change_requests" ("profile_id") WHERE "status" = 'PENDIENTE';

-- RF-08: el historial de estados es de solo inserción (mismo criterio que la
-- bitácora). Mantenimiento excepcional: SELECT set_config('app.audit_maintenance', 'on', true)
-- dentro de una transacción. La aplicación nunca activa ese ajuste.
CREATE FUNCTION "append_only_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.audit_maintenance', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'La tabla % es de solo inserción (% no permitido)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "worker_profile_status_history_no_update_delete"
    BEFORE UPDATE OR DELETE ON "worker_profile_status_history"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "worker_profile_status_history_no_truncate"
    BEFORE TRUNCATE ON "worker_profile_status_history"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
