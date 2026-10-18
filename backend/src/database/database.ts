import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgTransaction } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
import type { AppConfig } from '../config.js';

export type Schema = typeof schema;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, Schema>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = PgTransaction<any, Schema, any>;
/** Koneksi biasa atau transaksi — service menerima keduanya. */
export type DbOrTx = Db | Tx;

export const DB = Symbol('DB');

export interface DatabaseHandle {
  db: Db;
  close: () => Promise<void>;
  driver: 'pg' | 'pglite';
}

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function createDatabase(config: AppConfig): Promise<DatabaseHandle> {
  if (config.databaseUrl) {
    const { Pool } = (await import('pg')).default;
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
    const db = drizzle(pool, { schema }) as unknown as Db;
    await migrate(drizzle(pool), { migrationsFolder });
    await applyDatabaseGuards(db);
    return { db, close: () => pool.end(), driver: 'pg' };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let client;
  if (config.pgliteDir === 'memory') {
    client = new PGlite();
  } else {
    mkdirSync(config.pgliteDir, { recursive: true });
    client = new PGlite(config.pgliteDir);
  }
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder });
  await applyDatabaseGuards(db);
  return { db, close: () => client.close(), driver: 'pglite' };
}

/**
 * Proteksi di level database yang tidak bisa diekspresikan oleh migrasi Drizzle:
 * audit_events append-only — UPDATE/DELETE ditolak oleh trigger.
 */
async function applyDatabaseGuards(db: Db) {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_events bersifat append-only';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS audit_events_no_mutation ON audit_events`);
  await db.execute(sql`
    CREATE TRIGGER audit_events_no_mutation
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
  `);
}
