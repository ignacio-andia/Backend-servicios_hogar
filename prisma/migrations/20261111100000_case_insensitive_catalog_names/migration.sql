-- Unicidad de nombres de catálogos sin distinguir mayúsculas, garantizada por PostgreSQL.
-- citext compara con lower(): "Electricidad", "ELECTRICIDAD" y "electricidad" son el
-- mismo valor para el índice único, también entre solicitudes simultáneas y frente
-- a registros inactivos. Es una extensión "trusted": la crea el dueño de la base.
CREATE EXTENSION IF NOT EXISTS citext;

-- Conversión en el lugar (Prisma propondría DROP/ADD COLUMN y se perderían los datos).
-- Los índices únicos existentes se reconstruyen con la nueva comparación; si ya hubiera
-- nombres que solo difieren en mayúsculas, esta sentencia falla y no cambia nada.
ALTER TABLE "service_categories" ALTER COLUMN "name" SET DATA TYPE CITEXT USING "name"::CITEXT;
ALTER TABLE "zones" ALTER COLUMN "name" SET DATA TYPE CITEXT USING "name"::CITEXT;

-- citext no tiene longitud máxima: se conserva el límite de 100 caracteres de la API.
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 100);
ALTER TABLE "zones" ADD CONSTRAINT "zones_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 100);
