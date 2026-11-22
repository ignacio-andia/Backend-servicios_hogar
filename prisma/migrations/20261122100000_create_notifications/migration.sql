-- Notificaciones internas (T3.2). Solo crea tipos, tabla e indices: no modifica ni
-- borra datos existentes. Se conservan todas las notificaciones (sin borrado automatico).
-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PERFIL_APROBADO', 'PERFIL_OBSERVADO', 'PERFIL_RECHAZADO', 'PERFIL_SUSPENDIDO', 'PERFIL_REACTIVADO', 'VERIFICACION_SOLICITADA', 'VERIFICACION_REENVIADA_OBSERVACION', 'VERIFICACION_REENVIADA_RECHAZO');

-- CreateEnum
CREATE TYPE "NotificationResourceType" AS ENUM ('PERFIL_TRABAJADOR');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "resource_type" "NotificationResourceType",
    "resource_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- El recurso relacionado es opcional, pero si se indica debe tener tipo e id.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_resource_check" CHECK (("resource_type" IS NULL) = ("resource_id" IS NULL));
