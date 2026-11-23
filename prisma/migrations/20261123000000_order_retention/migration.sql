-- T5.4: limpieza de pedidos vencidos o cancelados y escalamiento de la cola de
-- borrado. Solo agrega columnas nulas y un valor de enum: no modifica ni borra
-- datos. Requiere PostgreSQL 12 o superior.

-- Cuando se anonimizo el pedido (sin direccion, sin fotos y con la descripcion
-- reemplazada). Tambien hace idempotente la anonimizacion.
ALTER TABLE "orders" ADD COLUMN "anonymized_at" TIMESTAMPTZ(3);

-- Cuando se aviso a los administradores de un fallo persistente de borrado.
-- La fila nunca se borra por eso: se sigue reintentando.
ALTER TABLE "pending_file_deletions" ADD COLUMN "escalated_at" TIMESTAMPTZ(3);

-- Aviso interno a los administradores de un borrado que sigue fallando.
ALTER TYPE "NotificationType" ADD VALUE 'BORRADO_ARCHIVO_ESCALADO';
