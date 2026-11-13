import path from 'node:path';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { loadMigrationConfig } from '../config.js';
import { log } from '../log.js';
import { createDatabase, type Database } from './client.js';

/** Role the application connects with. It may read and write data, nothing else. */
export const APP_ROLE = 'auth_app';

/**
 * Brings the database to the current schema and (re)configures the app role.
 * Runs as the owner role and is idempotent, so it is safe on every deploy:
 * changing the app password only requires running it again.
 */
export async function runMigrations({
  ownerUrl,
  appPassword,
}: {
  ownerUrl: string;
  appPassword: string;
}): Promise<void> {
  const { db, close } = createDatabase(ownerUrl);
  try {
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });
    await configureAppRole(db, appPassword);
  } finally {
    await close();
  }
}

/**
 * Creates the app role if missing, sets its password and grants data access (DML) only.
 * Grants are re-applied after every migration, so new tables are covered automatically.
 */
async function configureAppRole(db: Database, password: string): Promise<void> {
  await db.transaction(async (tx) => {
    // DO blocks cannot take bind parameters: pass the password as a transaction-local setting,
    // and let format(%L) quote it inside Postgres.
    await tx.execute(sql`select set_config('auth.app_password', ${password}, true)`);
    await tx.execute(
      sql.raw(`
        do $$
        declare
          app_role constant text := '${APP_ROLE}';
        begin
          if not exists (select from pg_roles where rolname = app_role) then
            execute format('create role %I', app_role);
          end if;
          execute format('alter role %I with login password %L',
                         app_role, current_setting('auth.app_password'));

          execute format('revoke all on database %I from public', current_database());
          execute format('grant connect on database %I to %I', current_database(), app_role);
          revoke create on schema public from public;
          execute format('grant usage on schema public to %I', app_role);
          execute format('grant select, insert, update, delete on all tables in schema public to %I', app_role);
          execute format('grant usage, select on all sequences in schema public to %I', app_role);
        end $$`),
    );
  });
}

if (import.meta.main) {
  await runMigrations(loadMigrationConfig());
  log.info('migrations applied');
}
