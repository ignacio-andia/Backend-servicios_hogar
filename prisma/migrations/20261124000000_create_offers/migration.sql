-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('VIGENTE', 'ACEPTADA', 'RECHAZADA', 'RETIRADA', 'VENCIDA', 'SIN_EFECTO');

-- CreateEnum
CREATE TYPE "OfferParty" AS ENUM ('CLIENTE', 'TRABAJADOR');

-- CreateEnum
CREATE TYPE "OfferEventType" AS ENUM ('PROPUESTA', 'CONTRAOFERTA', 'ACEPTADA', 'RECHAZADA', 'RETIRADA', 'VENCIDA', 'SIN_EFECTO');

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'VIGENTE',
    "round" SMALLINT NOT NULL DEFAULT 1,
    "amount" DECIMAL(10,2) NOT NULL,
    "turn" "OfferParty" NOT NULL DEFAULT 'CLIENTE',
    "requires_visit" BOOLEAN NOT NULL,
    "visit_cost" DECIMAL(10,2),
    "materials_included" BOOLEAN NOT NULL,
    "proposed_start_at" TIMESTAMPTZ(3) NOT NULL,
    "estimated_duration_minutes" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_events" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" "OfferEventType" NOT NULL,
    "round" SMALLINT NOT NULL,
    "amount" DECIMAL(10,2),
    "actor_type" "OrderActorType" NOT NULL,
    "changed_by_id" UUID,
    "actor_role" "RoleName",
    "system_process" VARCHAR(50),
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offers_order_id_status_idx" ON "offers"("order_id", "status");

-- CreateIndex
CREATE INDEX "offers_worker_id_status_idx" ON "offers"("worker_id", "status");

-- CreateIndex
CREATE INDEX "offers_status_expires_at_idx" ON "offers"("status", "expires_at");

-- CreateIndex
CREATE INDEX "offer_events_offer_id_created_at_idx" ON "offer_events"("offer_id", "created_at");

-- CreateIndex
CREATE INDEX "offer_events_order_id_created_at_idx" ON "offer_events"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integridad que Prisma no modela (T6.1)
-- ---------------------------------------------------------------------------

-- Una sola oferta VIGENTE por trabajador y pedido. Que no se vuelva a ofertar
-- despues de retirarla lo controla OffersService (T6.2) con el pedido
-- bloqueado.
CREATE UNIQUE INDEX "offers_order_worker_open_key" ON "offers"("order_id", "worker_id")
    WHERE "status" = 'VIGENTE';

-- A lo sumo una oferta ACEPTADA por pedido: segunda barrera, despues del
-- bloqueo del pedido, contra dos acuerdos en el mismo pedido.
CREATE UNIQUE INDEX "offers_one_accepted_per_order_key" ON "offers"("order_id")
    WHERE "status" = 'ACEPTADA';

-- Destino de la FK compuesta de offer_events: el evento pertenece al mismo
-- pedido que su oferta.
CREATE UNIQUE INDEX "offers_id_order_id_key" ON "offers"("id", "order_id");

ALTER TABLE "offers" ADD CONSTRAINT "offers_amount_check" CHECK ("amount" > 0);
ALTER TABLE "offers" ADD CONSTRAINT "offers_round_check" CHECK ("round" BETWEEN 1 AND 3);
ALTER TABLE "offers" ADD CONSTRAINT "offers_visit_cost_check" CHECK (
    ("requires_visit" AND "visit_cost" IS NOT NULL AND "visit_cost" >= 0)
    OR (NOT "requires_visit" AND "visit_cost" IS NULL)
);
ALTER TABLE "offers" ADD CONSTRAINT "offers_duration_check" CHECK ("estimated_duration_minutes" > 0);
-- Solo una oferta cerrada tiene fecha de cierre.
ALTER TABLE "offers" ADD CONSTRAINT "offers_closed_at_check" CHECK (
    ("status" = 'VIGENTE') = ("closed_at" IS NULL)
);

ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_offer_order_fkey"
    FOREIGN KEY ("offer_id", "order_id") REFERENCES "offers"("id", "order_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_round_check" CHECK ("round" BETWEEN 1 AND 3);
-- Monto solo en las rondas (PROPUESTA en la 1, CONTRAOFERTA en la 2 y 3).
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_amount_check" CHECK (
    ("type" = 'PROPUESTA' AND "round" = 1 AND "amount" > 0)
    OR ("type" = 'CONTRAOFERTA' AND "round" > 1 AND "amount" > 0)
    OR ("type" NOT IN ('PROPUESTA', 'CONTRAOFERTA') AND "amount" IS NULL)
);
-- Actor: un usuario (con el rol con que actuo) o un proceso del sistema.
ALTER TABLE "offer_events" ADD CONSTRAINT "offer_events_actor_check" CHECK (
    ("actor_type" = 'USUARIO' AND "changed_by_id" IS NOT NULL AND "actor_role" IS NOT NULL AND "system_process" IS NULL)
    OR ("actor_type" = 'SISTEMA' AND "changed_by_id" IS NULL AND "actor_role" IS NULL AND "system_process" IS NOT NULL)
);

-- Una propuesta o contraoferta por ronda y un solo cierre por oferta:
-- respaldo contra solicitudes duplicadas.
CREATE UNIQUE INDEX "offer_events_offer_round_key" ON "offer_events"("offer_id", "round")
    WHERE "type" IN ('PROPUESTA', 'CONTRAOFERTA');
CREATE UNIQUE INDEX "offer_events_offer_closing_key" ON "offer_events"("offer_id")
    WHERE "type" NOT IN ('PROPUESTA', 'CONTRAOFERTA');

-- RF-21: historial de solo insercion (append_only_guard ya existe).
CREATE TRIGGER "offer_events_no_update_delete"
    BEFORE UPDATE OR DELETE ON "offer_events"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "offer_events_no_truncate"
    BEFORE TRUNCATE ON "offer_events"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();

-- Una oferta no se borra; sus condiciones, su pedido y su trabajador no
-- cambian; una oferta cerrada no se reabre ni se modifica; la ronda no
-- retrocede. Mismo ajuste de mantenimiento que append_only_guard.
CREATE FUNCTION "offers_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.audit_maintenance', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF OLD."status" <> 'VIGENTE' THEN
        RAISE EXCEPTION 'La oferta % está cerrada (%) y no se modifica', OLD."id", OLD."status"
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."order_id" <> OLD."order_id"
        OR NEW."worker_id" <> OLD."worker_id"
        OR NEW."requires_visit" <> OLD."requires_visit"
        OR NEW."visit_cost" IS DISTINCT FROM OLD."visit_cost"
        OR NEW."materials_included" <> OLD."materials_included"
        OR NEW."proposed_start_at" <> OLD."proposed_start_at"
        OR NEW."estimated_duration_minutes" <> OLD."estimated_duration_minutes"
        OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION 'Las condiciones de la oferta % no se modifican', OLD."id"
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."round" < OLD."round" THEN
        RAISE EXCEPTION 'La ronda de la oferta % no retrocede', OLD."id"
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "offers_guard_update"
    BEFORE UPDATE ON "offers"
    FOR EACH ROW EXECUTE FUNCTION "offers_guard"();

CREATE TRIGGER "offers_no_delete"
    BEFORE DELETE ON "offers"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "offers_no_truncate"
    BEFORE TRUNCATE ON "offers"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
