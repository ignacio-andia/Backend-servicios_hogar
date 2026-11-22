import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

export interface IsolatedSchema {
  schema: string;
  /** Cliente que lee y escribe SOLO en el esquema temporal. */
  prisma: PrismaClient;
  drop(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve('prisma/migrations');

/**
 * Crea un esquema temporal vacio en la base de datos de .env, le aplica todas
 * las migraciones del proyecto y devuelve un PrismaClient apuntado a el. Asi
 * las pruebas que necesitan una base sin datos (por ejemplo, sin
 * administradores) no tocan los datos existentes del esquema public.
 * Prisma califica las tablas con el esquema, por eso se usa la opcion
 * `schema` del adaptador y no solo search_path.
 */
export async function createIsolatedSchema(
  prefix: string,
): Promise<IsolatedSchema> {
  if (!process.env.DATABASE_URL) {
    process.loadEnvFile('.env');
  }
  const url = process.env.DATABASE_URL!;
  const schema = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  const dropSchema = async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  };

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    // public queda en el search_path para las extensiones (citext).
    await client.query(`SET search_path TO "${schema}", public`);
    const folders = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const folder of folders) {
      await client.query(
        await readFile(
          path.join(MIGRATIONS_DIR, folder, 'migration.sql'),
          'utf8',
        ),
      );
    }
  } catch (error) {
    await client.end();
    await dropSchema();
    throw error;
  }
  await client.end();

  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: url, options: '-c TimeZone=UTC' },
      { schema },
    ),
  });
  await prisma.$connect();
  return {
    schema,
    prisma,
    drop: async () => {
      await prisma.$disconnect();
      await dropSchema();
    },
  };
}
