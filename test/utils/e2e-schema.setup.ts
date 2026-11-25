import { vi } from 'vitest';

/**
 * Complemento de e2e-schema.global.ts: con E2E_SCHEMA definido, todo PrismaPg
 * creado SIN esquema explicito (el PrismaService de la app) apunta al esquema
 * temporal, tambien para el SQL crudo (search_path). Las suites que pasan su
 * propio esquema no cambian. Sin E2E_SCHEMA el adaptador queda intacto.
 */
vi.mock('@prisma/adapter-pg', async (importOriginal) => {
  const original = await importOriginal<typeof import('@prisma/adapter-pg')>();
  const schema = process.env.E2E_SCHEMA;
  if (!schema) {
    return original;
  }
  type Config = ConstructorParameters<typeof original.PrismaPg>[0];
  type Options = ConstructorParameters<typeof original.PrismaPg>[1];
  class SchemaScopedPrismaPg extends original.PrismaPg {
    constructor(config: Config, options?: Options) {
      super(
        options?.schema
          ? config
          : ({
              ...(config as object),
              options: `-c TimeZone=UTC -c search_path=${schema},public`,
            } as Config),
        options?.schema ? options : { ...options, schema },
      );
    }
  }
  return { ...original, PrismaPg: SchemaScopedPrismaPg };
});
