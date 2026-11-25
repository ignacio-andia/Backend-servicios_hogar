-- Aviso de oferta vencida (RF-23: "al vencer una oferta, el sistema la marca como
-- vencida y notifica"). Solo agrega un valor de enum: no modifica datos.
ALTER TYPE "NotificationType" ADD VALUE 'OFERTA_VENCIDA';
