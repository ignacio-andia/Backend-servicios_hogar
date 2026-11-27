--=========================================================
-- NUEVO: 20261127000000_order_cancellation_summaries/migration.sql
-- Fase B3 (cancelacion): tabla order_cancellation_summaries, la fotografia
-- economica de un pedido en el instante en que se cancela.
-- Necesaria porque las tablas actuales cambian (adicionales) o son genericas
-- (historial de estados).
-- Reglas:
--   total actualizado = monto acordado + adicionales aceptados
--   saldo pendiente   = total actualizado - anticipos confirmados
--   la visita se guarda aparte; lo declarado sin confirmar no reduce el saldo;
--   sin acuerdo los importes son NULL (nunca 0).
-- La plataforma no procesa dinero: solo registra.
-- Solo CREA objetos nuevos: no modifica ni borra datos, tablas ni migraciones
-- anteriores.
--=========================================================

-- CreateTable
CREATE TABLE "order_cancellation_summaries" (
    "order_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "accepted_offer_id" UUID,
    "agreed_at" TIMESTAMPTZ(3),
    "agreed_amount" DECIMAL(10,2),
    "accepted_additional_total" DECIMAL(12,2),
    "updated_total" DECIMAL(12,2),
    "confirmed_advance_total" DECIMAL(10,2),
    "unconfirmed_advance_amount" DECIMAL(10,2),
    "pending_balance" DECIMAL(12,2),
    "visit_cost" DECIMAL(10,2),
    "details" JSONB NOT NULL,
    "schema_version" SMALLINT NOT NULL DEFAULT 1,

    CONSTRAINT "order_cancellation_summaries_pkey" PRIMARY KEY ("order_id")
);

-- AddForeignKey
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (compuesta: la oferta aceptada es de ESTE pedido; usa el
-- indice unico offers_id_order_id_key)
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_offer_order_fkey" FOREIGN KEY ("accepted_offer_id", "order_id") REFERENCES "offers"("id", "order_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Reglas que Prisma no modela (no generan diferencias con schema.prisma).
-- ---------------------------------------------------------------------------

-- Con acuerdo estan todos los importes del acuerdo; sin acuerdo, ninguno
-- (tampoco la fecha, la visita ni lo declarado sin confirmar).
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_agreement_check" CHECK (
    (
        "accepted_offer_id" IS NULL
        AND "agreed_at" IS NULL
        AND num_nonnulls(
            "agreed_amount", "accepted_additional_total", "updated_total",
            "confirmed_advance_total", "unconfirmed_advance_amount",
            "pending_balance", "visit_cost"
        ) = 0
    )
    OR (
        "accepted_offer_id" IS NOT NULL
        AND num_nulls(
            "agreed_amount", "accepted_additional_total", "updated_total",
            "confirmed_advance_total", "pending_balance"
        ) = 0
    )
);

-- Formulas aprobadas (sin acuerdo ambos lados son NULL y la regla anterior
-- decide).
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_total_check"
    CHECK ("updated_total" = "agreed_amount" + "accepted_additional_total");
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_balance_check"
    CHECK ("pending_balance" = "updated_total" - "confirmed_advance_total");

-- Importes de entrada validos (los mismos limites que sus tablas de origen).
-- El saldo no tiene control de signo propio: sale de la formula y un dato
-- anomalo no debe impedir cancelar.
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_amounts_check" CHECK (
    "agreed_amount" > 0
    AND "accepted_additional_total" >= 0
    AND "confirmed_advance_total" >= 0
    AND "unconfirmed_advance_amount" > 0
    AND "visit_cost" >= 0
);

-- Hay un solo anticipo por pedido: o esta confirmado o esta sin confirmar.
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_advance_check"
    CHECK ("unconfirmed_advance_amount" IS NULL OR "confirmed_advance_total" = 0);

ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_details_check"
    CHECK (jsonb_typeof("details") = 'object');
ALTER TABLE "order_cancellation_summaries" ADD CONSTRAINT "order_cancellation_summaries_version_check"
    CHECK ("schema_version" >= 1);

-- Fotografia de solo insercion: misma funcion generica que el historial de
-- estados del pedido (append_only_guard ya existe).
CREATE TRIGGER "order_cancellation_summaries_no_update_delete"
    BEFORE UPDATE OR DELETE ON "order_cancellation_summaries"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
CREATE TRIGGER "order_cancellation_summaries_no_truncate"
    BEFORE TRUNCATE ON "order_cancellation_summaries"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();
