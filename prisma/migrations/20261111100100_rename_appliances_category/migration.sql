-- La categoría inicial se llama "Electrodomésticos", como en el Anexo B (Decisiones
-- confirmadas) del documento de requerimientos. Se renombra el registro existente,
-- así conserva su id y sus relaciones. No se toca si un administrador ya la renombró
-- o si ya existe una categoría "Electrodomésticos".
UPDATE "service_categories"
SET "name" = 'Electrodomésticos', "updated_at" = CURRENT_TIMESTAMP
WHERE "name" = 'Técnicos en electrodomésticos'
  AND NOT EXISTS (SELECT 1 FROM "service_categories" WHERE "name" = 'Electrodomésticos');
