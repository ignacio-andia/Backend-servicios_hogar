
-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PUBLICADO', 'EN_NEGOCIACION', 'ACORDADO', 'ANTICIPO_REGISTRADO', 'VISITA_REALIZADA', 'PRESUPUESTO_ADICIONAL_PENDIENTE', 'EN_EJECUCION', 'TERMINADO', 'EN_RECLAMO', 'CERRADO', 'SIN_ACUERDO', 'VENCIDO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "OrderActorType" AS ENUM ('USUARIO', 'SISTEMA');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "budget_amount" DECIMAL(10,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PUBLICADO',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_edited_at" TIMESTAMPTZ(3),
    "assigned_worker_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_addresses" (
    "order_id" UUID NOT NULL,
    "address_line" VARCHAR(255) NOT NULL,
    "reference" VARCHAR(255),

    CONSTRAINT "order_addresses_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "order_images" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "thumbnail_key" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(50) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "thumbnail_size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "actor_type" "OrderActorType" NOT NULL,
    "changed_by_id" UUID,
    "actor_role" "RoleName",
    "system_process" VARCHAR(50),
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_file_deletions" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "reason" VARCHAR(50) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_file_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_zone_id_category_id_status_expires_at_idx" ON "orders"("zone_id", "category_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "orders_client_id_created_at_idx" ON "orders"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_expires_at_idx" ON "orders"("status", "expires_at");

-- CreateIndex
CREATE INDEX "orders_client_id_category_id_status_idx" ON "orders"("client_id", "category_id", "status");

-- CreateIndex
CREATE INDEX "orders_assigned_worker_id_status_idx" ON "orders"("assigned_worker_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "order_images_storage_key_key" ON "order_images"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "order_images_thumbnail_key_key" ON "order_images"("thumbnail_key");

-- CreateIndex
CREATE UNIQUE INDEX "order_images_order_id_position_key" ON "order_images"("order_id", "position");

-- CreateIndex
CREATE INDEX "order_status_history_order_id_created_at_idx" ON "order_status_history"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pending_file_deletions_storage_key_key" ON "pending_file_deletions"("storage_key");

-- CreateIndex
CREATE INDEX "pending_file_deletions_next_attempt_at_idx" ON "pending_file_deletions"("next_attempt_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_worker_id_fkey" FOREIGN KEY ("assigned_worker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_addresses" ADD CONSTRAINT "order_addresses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_images" ADD CONSTRAINT "order_images_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reglas que Prisma no modela (no generan diferencias con schema.prisma).
-- ---------------------------------------------------------------------------

-- El monto que el cliente puede pagar es positivo (sin máximo de negocio).
ALTER TABLE "orders" ADD CONSTRAINT "orders_budget_amount_check" CHECK ("budget_amount" > 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_revision_check" CHECK ("revision" >= 1);

ALTER TABLE "order_images" ADD CONSTRAINT "order_images_position_check" CHECK ("position" >= 1);
ALTER TABLE "order_images" ADD CONSTRAINT "order_images_size_check"
    CHECK ("size_bytes" > 0 AND "thumbnail_size_bytes" > 0 AND "width" > 0 AND "height" > 0);

ALTER TABLE "pending_file_deletions" ADD CONSTRAINT "pending_file_deletions_attempts_check" CHECK ("attempts" >= 0);

-- Actor del historial: un usuario (con el rol con que actuó) o un proceso del sistema.
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actor_check" CHECK (
    ("actor_type" = 'USUARIO' AND "changed_by_id" IS NOT NULL AND "actor_role" IS NOT NULL AND "system_process" IS NULL)
    OR ("actor_type" = 'SISTEMA' AND "changed_by_id" IS NULL AND "actor_role" IS NULL AND "system_process" IS NOT NULL)
);

-- El historial de estados es de solo inserción (misma función genérica que el
-- historial del perfil del trabajador).
CREATE TRIGGER "order_status_history_no_update_delete"
    BEFORE UPDATE OR DELETE ON "order_status_history"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "order_status_history_no_truncate"
    BEFORE TRUNCATE ON "order_status_history"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
