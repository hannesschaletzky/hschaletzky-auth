import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { APP_ROLE, runMigrations } from '../../src/db/migrate.js';

const root = path.resolve(import.meta.dirname, '../..');

/** Reads the Postgres image from compose.yml so tests and local dev always use the same version. */
function postgresImage(): string {
  const compose = readFileSync(path.join(root, 'compose.yml'), 'utf8');
  const match = /image:\s*(postgres:\S+)/.exec(compose);
  if (!match?.[1]) throw new Error('No postgres image found in compose.yml');
  return match[1];
}

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** Owner role — runs migrations, like in production. */
  ownerUrl: string;
  /** Least-privilege role the app connects with. */
  appUrl: string;
}

/** Starts Postgres and runs the same migration step as production (schema + app role). */
export async function startTestDatabase(): Promise<TestDatabase> {
  const appPassword = 'test-app-password-0123456789';
  const container = await new PostgreSqlContainer(postgresImage())
    .withDatabase('auth')
    .withUsername('auth')
    .withPassword('test-owner-password')
    .start();

  const ownerUrl = container.getConnectionUri();
  const appUrl = new URL(ownerUrl);
  appUrl.username = APP_ROLE;
  appUrl.password = appPassword;

  await runMigrations({ ownerUrl, appPassword });
  return { container, ownerUrl, appUrl: appUrl.toString() };
}
