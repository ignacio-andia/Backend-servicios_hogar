-- Priorizacion de reclamos: prioridad, responsable y fecha limite.
CREATE TYPE "ClaimPriority" AS ENUM ('URGENTE', 'ALTA', 'MEDIA', 'BAJA');

ALTER TABLE "claims"
  ADD COLUMN "priority" "ClaimPriority" NOT NULL DEFAULT 'MEDIA',
  ADD COLUMN "assigned_to_id" UUID,
  ADD COLUMN "assigned_at" TIMESTAMPTZ(3),
  ADD COLUMN "due_at" TIMESTAMPTZ(3);

-- Reclamos existentes: plazo de prioridad MEDIA (72 h) desde su creacion.
UPDATE "claims" SET "due_at" = "created_at" + INTERVAL '72 hours';

ALTER TABLE "claims" ALTER COLUMN "due_at" SET NOT NULL;

ALTER TABLE "claims"
  ADD CONSTRAINT "claims_assigned_to_id_fkey"
  FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "claims_status_due_at_idx" ON "claims"("status", "due_at");
CREATE INDEX "claims_assigned_to_id_idx" ON "claims"("assigned_to_id");