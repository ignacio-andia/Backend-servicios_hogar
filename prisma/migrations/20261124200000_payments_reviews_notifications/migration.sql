-- Pagos, constancias, calificaciones y avisos de eventos (Persona B).
-- Solo crea tipos, tablas, indices, restricciones y valores de enum nuevos: no
-- modifica ni borra datos existentes ni migraciones anteriores.
-- La plataforma no procesa dinero (RN-01, RF-43): estas tablas guardan
-- DECLARACIONES de las partes.

-- CreateEnum
CREATE TYPE "PaymentConcept" AS ENUM ('VISITA', 'ANTICIPO', 'SALDO');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('EFECTIVO', 'QR');

-- CreateEnum
CREATE TYPE "PaymentDeclarer" AS ENUM ('CLIENTE', 'TRABAJADOR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'OFERTA_RECIBIDA';
ALTER TYPE "NotificationType" ADD VALUE 'CONTRAOFERTA_RECIBIDA';
ALTER TYPE "NotificationType" ADD VALUE 'OFERTA_ACEPTADA';
ALTER TYPE "NotificationType" ADD VALUE 'OFERTA_RECHAZADA';
ALTER TYPE "NotificationType" ADD VALUE 'OFERTA_RETIRADA';
ALTER TYPE "NotificationType" ADD VALUE 'PEDIDO_CANCELADO';
ALTER TYPE "NotificationType" ADD VALUE 'PEDIDO_VENCIDO';
ALTER TYPE "NotificationType" ADD VALUE 'VISITA_REGISTRADA';
ALTER TYPE "NotificationType" ADD VALUE 'TRABAJO_INICIADO';
ALTER TYPE "NotificationType" ADD VALUE 'PRESUPUESTO_ADICIONAL_PROPUESTO';
ALTER TYPE "NotificationType" ADD VALUE 'PRESUPUESTO_ADICIONAL_ACEPTADO';
ALTER TYPE "NotificationType" ADD VALUE 'TRABAJO_TERMINADO';
ALTER TYPE "NotificationType" ADD VALUE 'CONFORMIDAD_CONFIRMADA';
ALTER TYPE "NotificationType" ADD VALUE 'PEDIDO_CERRADO_POR_PLAZO';
ALTER TYPE "NotificationType" ADD VALUE 'INASISTENCIA_REPORTADA';
ALTER TYPE "NotificationType" ADD VALUE 'RECLAMO_PRESENTADO';
ALTER TYPE "NotificationType" ADD VALUE 'RECLAMO_EN_REVISION';
ALTER TYPE "NotificationType" ADD VALUE 'RECLAMO_RESUELTO';
ALTER TYPE "NotificationType" ADD VALUE 'PAGO_DECLARADO';
ALTER TYPE "NotificationType" ADD VALUE 'PAGO_CON_DIFERENCIA';
ALTER TYPE "NotificationType" ADD VALUE 'CALIFICACION_RECIBIDA';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationResourceType" ADD VALUE 'PEDIDO';
ALTER TYPE "NotificationResourceType" ADD VALUE 'OFERTA';
ALTER TYPE "NotificationResourceType" ADD VALUE 'RECLAMO';
ALTER TYPE "NotificationResourceType" ADD VALUE 'PAGO';

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "concept" "PaymentConcept" NOT NULL,
    "expected_amount" DECIMAL(10,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_declarations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "declared_by" "PaymentDeclarer" NOT NULL,
    "user_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "reference_file_key" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_receipts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "agreed_amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "author_role" "RoleName" NOT NULL,
    "rating" SMALLINT NOT NULL,
    "comment" VARCHAR(1000),
    "hidden_at" TIMESTAMPTZ(3),
    "hidden_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_order_id_concept_key" ON "payments"("order_id", "concept");

-- CreateIndex
CREATE INDEX "payment_declarations_user_id_idx" ON "payment_declarations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_declarations_payment_id_declared_by_key" ON "payment_declarations"("payment_id", "declared_by");

-- CreateIndex
CREATE UNIQUE INDEX "service_receipts_order_id_key" ON "service_receipts"("order_id");

-- CreateIndex
CREATE INDEX "reviews_target_id_created_at_idx" ON "reviews"("target_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reviews_order_id_author_id_key" ON "reviews"("order_id", "author_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_declarations" ADD CONSTRAINT "payment_declarations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_declarations" ADD CONSTRAINT "payment_declarations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_receipts" ADD CONSTRAINT "service_receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_receipts" ADD CONSTRAINT "service_receipts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_receipts" ADD CONSTRAINT "service_receipts_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_hidden_by_id_fkey" FOREIGN KEY ("hidden_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Montos y puntajes validos.
ALTER TABLE "payments" ADD CONSTRAINT "payments_expected_amount_check"
    CHECK ("expected_amount" IS NULL OR "expected_amount" > 0);
ALTER TABLE "payment_declarations" ADD CONSTRAINT "payment_declarations_amount_check"
    CHECK ("amount" > 0);
ALTER TABLE "service_receipts" ADD CONSTRAINT "service_receipts_amount_check"
    CHECK ("agreed_amount" > 0);
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_check"
    CHECK ("rating" BETWEEN 1 AND 5);
-- Sin autocalificacion (RN-14).
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_no_self_review_check"
    CHECK ("author_id" <> "target_id");
-- hidden_by_id y hidden_at van juntos.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_hidden_check"
    CHECK (("hidden_at" IS NULL) = ("hidden_by_id" IS NULL));

-- Constancias de solo insercion (RF-41: no se editan ni se borran). Misma
-- funcion generica que el historial de estados del pedido.
CREATE TRIGGER "payments_no_update_delete"
    BEFORE UPDATE OR DELETE ON "payments"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
CREATE TRIGGER "payments_no_truncate"
    BEFORE TRUNCATE ON "payments"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "payment_declarations_no_update_delete"
    BEFORE UPDATE OR DELETE ON "payment_declarations"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
CREATE TRIGGER "payment_declarations_no_truncate"
    BEFORE TRUNCATE ON "payment_declarations"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();

CREATE TRIGGER "service_receipts_no_update_delete"
    BEFORE UPDATE OR DELETE ON "service_receipts"
    FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();
CREATE TRIGGER "service_receipts_no_truncate"
    BEFORE TRUNCATE ON "service_receipts"
    FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"();

-- Una calificacion solo puede ocultarse (RF-46 A1): nunca se borra, no se
-- reabre y no cambia ninguno de sus datos.
CREATE FUNCTION "reviews_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.audit_maintenance', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Las calificaciones no se borran (se ocultan)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."hidden_at" IS NOT NULL
       OR NEW."id" <> OLD."id"
       OR NEW."order_id" <> OLD."order_id"
       OR NEW."author_id" <> OLD."author_id"
       OR NEW."target_id" <> OLD."target_id"
       OR NEW."author_role" <> OLD."author_role"
       OR NEW."rating" <> OLD."rating"
       OR NEW."comment" IS DISTINCT FROM OLD."comment"
       OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION 'Una calificacion solo puede ocultarse'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "reviews_guard"
    BEFORE UPDATE OR DELETE ON "reviews"
    FOR EACH ROW EXECUTE FUNCTION "reviews_guard"();
