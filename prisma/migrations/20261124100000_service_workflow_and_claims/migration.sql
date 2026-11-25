-- CreateEnum
CREATE TYPE "AdditionalBudgetStatus" AS ENUM ('PENDIENTE', 'ACEPTADO', 'RECHAZADO', 'SIN_EFECTO_POR_CANCELACION');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('ABIERTO', 'EN_REVISION', 'RESUELTO');

-- CreateTable
CREATE TABLE "order_visits" (
    "order_id" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visit_cost" DECIMAL(10,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_visits_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "additional_budgets" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "materials" VARCHAR(1000) NOT NULL,
    "status" "AdditionalBudgetStatus" NOT NULL DEFAULT 'PENDIENTE',
    "responded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "additional_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_executions" (
    "order_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "conformity_deadline" TIMESTAMPTZ(3),
    "conformed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_executions_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "no_show_reports" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "reported_by_id" UUID NOT NULL,
    "description" VARCHAR(1000),
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "no_show_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'ABIERTO',
    "decision" VARCHAR(2000),
    "justification" VARCHAR(2000),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_images" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
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

    CONSTRAINT "claim_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "additional_budgets_order_id_status_idx" ON "additional_budgets"("order_id", "status");

-- CreateIndex
CREATE INDEX "order_executions_conformity_deadline_idx" ON "order_executions"("conformity_deadline");

-- CreateIndex
CREATE UNIQUE INDEX "no_show_reports_order_id_key" ON "no_show_reports"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "claims_order_id_key" ON "claims"("order_id");

-- CreateIndex
CREATE INDEX "claims_status_created_at_idx" ON "claims"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "claim_images_storage_key_key" ON "claim_images"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "claim_images_thumbnail_key_key" ON "claim_images"("thumbnail_key");

-- CreateIndex
CREATE UNIQUE INDEX "claim_images_claim_id_position_key" ON "claim_images"("claim_id", "position");

-- AddForeignKey
ALTER TABLE "order_visits" ADD CONSTRAINT "order_visits_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_budgets" ADD CONSTRAINT "additional_budgets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_executions" ADD CONSTRAINT "order_executions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_images" ADD CONSTRAINT "claim_images_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Un solo presupuesto adicional PENDIENTE por pedido (RF-26): respaldo de BD
-- contra doble clic o reintentos concurrentes.
CREATE UNIQUE INDEX "additional_budgets_one_pending_per_order_key"
  ON "additional_budgets"("order_id") WHERE "status" = 'PENDIENTE';

-- Montos positivos (RF-26) y consistencia de la respuesta: solo ACEPTADO y
-- RECHAZADO tienen fecha de respuesta del cliente; PENDIENTE y
-- SIN_EFECTO_POR_CANCELACION no.
ALTER TABLE "additional_budgets" ADD CONSTRAINT "additional_budgets_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "additional_budgets" ADD CONSTRAINT "additional_budgets_response_consistent"
  CHECK (("status" IN ('ACEPTADO', 'RECHAZADO')) = ("responded_at" IS NOT NULL));

-- Un adicional que ya no esta PENDIENTE es terminal: no puede cambiar de
-- estado (por ejemplo, aceptarse despues de cancelar el pedido).
CREATE FUNCTION additional_budgets_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'El presupuesto adicional ya esta en estado final (%)', OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER additional_budgets_guard
  BEFORE UPDATE ON "additional_budgets"
  FOR EACH ROW EXECUTE FUNCTION additional_budgets_guard();

ALTER TABLE "order_visits" ADD CONSTRAINT "order_visits_cost_non_negative"
  CHECK ("visit_cost" IS NULL OR "visit_cost" >= 0);
ALTER TABLE "order_executions" ADD CONSTRAINT "order_executions_deadline_after_finish"
  CHECK ("conformity_deadline" IS NULL OR "finished_at" IS NOT NULL);
