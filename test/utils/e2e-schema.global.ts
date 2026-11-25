import { createIsolatedSchema } from './isolated-schema.js';

/**
 * Modo opcional E2E_ISOLATED_SCHEMA=true: crea UN esquema temporal con todas
 * las migraciones para toda la corrida e2e y lo elimina al terminar, asi las
 * suites que arrancan AppModule no leen ni escriben el esquema public. Sin la
 * variable no hace nada (se usa la base de .env, que debe estar migrada).
 */
export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.E2E_ISOLATED_SCHEMA !== 'true') {
    return;
  }
  const isolated = await createIsolatedSchema('e2e_all');
  process.env.E2E_SCHEMA = isolated.schema;
  return () => isolated.drop();
}
