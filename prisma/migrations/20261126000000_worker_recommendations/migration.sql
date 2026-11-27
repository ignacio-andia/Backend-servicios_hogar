-- Recomendacion de trabajadores por reputacion, servicios completados y
-- disponibilidad. Solo crea tablas, indices, restricciones, triggers, un valor
-- de enum nuevo y la configuracion inicial (version 1): no modifica ni borra
-- datos existentes ni migraciones anteriores.

-- AlterEnum
-- Bitacora (RF-53): los cambios de criterios los registra el administrador.
ALTER TYPE "AuditEntityType" ADD VALUE 'CONFIGURACION_RECOMENDACION';

-- CreateTable
CREATE TABLE "recommendation_settings" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "reputation_weight" SMALLINT NOT NULL,
    "completed_services_weight" SMALLINT NOT NULL,
    "availability_weight" SMALLINT NOT NULL,
    "reviews_for_confidence" SMALLINT NOT NULL,
    "completed_services_target" SMALLINT NOT NULL,
    "availability_hours_target" SMALLINT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_recommendations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "settings_id" UUID NOT NULL,
    "candidates_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_recommendation_items" (
    "id" UUID NOT NULL,
    "recommendation_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "rank" SMALLINT NOT NULL,
    "total_score" DECIMAL(5,2) NOT NULL,
    "reviews_count" INTEGER NOT NULL,
    "average_rating" DECIMAL(3,2),
    "adjusted_rating" DECIMAL(3,2) NOT NULL,
    "reputation_score" DECIMAL(5,2) NOT NULL,
    "completed_services" INTEGER NOT NULL,
    "completed_services_score" DECIMAL(5,2) NOT NULL,
    "weekly_schedule_minutes" INTEGER NOT NULL,
    "booked_minutes" INTEGER NOT NULL,
    "free_minutes" INTEGER NOT NULL,
    "availability_score" DECIMAL(5,2) NOT NULL,
    "open_offer_id" UUID,

    CONSTRAINT "worker_recommendation_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_settings_version_key" ON "recommendation_settings"("version");

-- CreateIndex
CREATE INDEX "worker_recommendations_order_id_created_at_idx" ON "worker_recommendations"("order_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "worker_recommendations_settings_id_idx" ON "worker_recommendations"("settings_id");

-- CreateIndex
CREATE INDEX "worker_recommendation_items_worker_id_idx" ON "worker_recommendation_items"("worker_id");

-- CreateIndex
CREATE INDEX "worker_recommendation_items_open_offer_id_idx" ON "worker_recommendation_items"("open_offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_recommendation_items_recommendation_id_rank_key" ON "worker_recommendation_items"("recommendation_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "worker_recommendation_items_recommendation_id_worker_id_key" ON "worker_recommendation_items"("recommendation_id", "worker_id");

-- AddForeignKey
ALTER TABLE "recommendation_settings" ADD CONSTRAINT "recommendation_settings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_recommendations" ADD CONSTRAINT "worker_recommendations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_recommendations" ADD CONSTRAINT "worker_recommendations_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_recommendations" ADD CONSTRAINT "worker_recommendations_settings_id_fkey" FOREIGN KEY ("settings_id") REFERENCES "recommendation_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_recommendation_items" ADD CONSTRAINT "worker_recommendation_items_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "worker_recommendations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_recommendation_items" ADD CONSTRAINT "worker_recommendation_items_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_recommendation_items" ADD CONSTRAINT "worker_recommendation_items_open_offer_id_fkey" FOREIGN KEY ("open_offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reglas de negocio respaldadas por la BD (Prisma no genera CHECK).
-- Pesos: porcentajes enteros que suman exactamente 100.
ALTER TABLE "recommendation_settings" ADD CONSTRAINT "recommendation_settings_weights_check" CHECK (
  "reputation_weight" BETWEEN 0 AND 100
  AND "completed_services_weight" BETWEEN 0 AND 100
  AND "availability_weight" BETWEEN 0 AND 100
  AND "reputation_weight" + "completed_services_weight" + "availability_weight" = 100
);
ALTER TABLE "recommendation_settings" ADD CONSTRAINT "recommendation_settings_parameters_check" CHECK (
  "version" >= 1
  AND "reviews_for_confidence" BETWEEN 0 AND 50
  AND "completed_services_target" BETWEEN 1 AND 1000
  AND "availability_hours_target" BETWEEN 1 AND 168
);
-- Solo la version inicial (la crea esta migracion) no tiene autor.
ALTER TABLE "recommendation_settings" ADD CONSTRAINT "recommendation_settings_author_check" CHECK (
  "created_by_id" IS NOT NULL OR "version" = 1
);
ALTER TABLE "worker_recommendations" ADD CONSTRAINT "worker_recommendations_candidates_check" CHECK (
  "candidates_count" >= 0
);
ALTER TABLE "worker_recommendation_items" ADD CONSTRAINT "worker_recommendation_items_values_check" CHECK (
  "rank" >= 1
  AND "total_score" BETWEEN 0 AND 100
  AND "reputation_score" BETWEEN 0 AND 100
  AND "completed_services_score" BETWEEN 0 AND 100
  AND "availability_score" BETWEEN 0 AND 100
  AND "reviews_count" >= 0
  AND ("average_rating" IS NULL OR "average_rating" BETWEEN 1 AND 5)
  AND ("average_rating" IS NULL) = ("reviews_count" = 0)
  AND "adjusted_rating" BETWEEN 1 AND 5
  AND "completed_services" >= 0
  AND "weekly_schedule_minutes" >= 0
  AND "booked_minutes" >= 0
  AND "free_minutes" BETWEEN 0 AND "weekly_schedule_minutes"
);

-- Historial: los criterios versionados y las recomendaciones generadas no se
-- modifican ni se borran (solo insercion).
CREATE FUNCTION recommendations_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es de solo insercion: el historial de recomendaciones no se modifica ni se borra', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER recommendation_settings_append_only
  BEFORE UPDATE OR DELETE ON "recommendation_settings"
  FOR EACH ROW EXECUTE FUNCTION recommendations_append_only();
CREATE TRIGGER worker_recommendations_append_only
  BEFORE UPDATE OR DELETE ON "worker_recommendations"
  FOR EACH ROW EXECUTE FUNCTION recommendations_append_only();
CREATE TRIGGER worker_recommendation_items_append_only
  BEFORE UPDATE OR DELETE ON "worker_recommendation_items"
  FOR EACH ROW EXECUTE FUNCTION recommendations_append_only();

-- Configuracion inicial (version 1): reputacion 50 %, servicios completados
-- 30 % y disponibilidad 20 %; 3 calificaciones neutras; 10 servicios y 20 horas
-- libres para llegar al 100 % de cada criterio.
INSERT INTO "recommendation_settings" (
  "id", "version", "reputation_weight", "completed_services_weight",
  "availability_weight", "reviews_for_confidence", "completed_services_target",
  "availability_hours_target", "created_by_id"
) VALUES (gen_random_uuid(), 1, 50, 30, 20, 3, 10, 20, NULL);
