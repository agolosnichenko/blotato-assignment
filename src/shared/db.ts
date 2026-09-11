import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { Config } from '#src/app/config.ts';

export interface Database {
  readonly drizzle: NodePgDatabase;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(config: Config): Database {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const db = drizzle(pool);
  return {
    drizzle: db,
    async ping() {
      await db.execute(sql`select 1`);
    },
    async close() {
      await pool.end();
    },
  };
}
