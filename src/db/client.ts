import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** A database handle or an open transaction; nested `transaction()` calls become savepoints. */
export type DbOrTx = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(connectionString: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
