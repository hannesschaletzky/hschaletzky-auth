import { readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Secrets can be passed directly (`X=value`, convenient for local `.env` files) or as a file path
 * (`X_FILE=/run/secrets/x`, used in production with Docker Compose secrets, so values never show
 * up in `docker inspect` or the process environment).
 */

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const commaList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

const appSchema = z.object({
  /** Public origin of this server; also the token issuer, e.g. https://auth.example.com */
  PUBLIC_BASE_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: postgresUrl,
  DATABASE_PASSWORD: z.string().min(1).optional(),
  /** Signs cookies and the OAuth query handed to the login page. */
  BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  /** Numeric GitHub user ids (stable, unlike login names) that may sign in. */
  ALLOWED_GITHUB_USER_IDS: commaList.pipe(z.array(z.string().regex(/^\d+$/).transform(Number))),
  /** Protected resources (RFC 8707) tokens can be issued for, e.g. https://mcp.example.com/mcp */
  RESOURCES: commaList.pipe(z.array(z.url({ protocol: /^https?$/ }))),
  /** Redirect URIs dynamically registered clients may use. Default: claude.ai's callback. */
  OAUTH_REDIRECT_URIS: commaList.optional(),
});

const migrationSchema = z.object({
  /** Owner role: applies migrations and manages the app role. */
  MIGRATION_DATABASE_URL: postgresUrl,
  MIGRATION_DATABASE_PASSWORD: z.string().min(1).optional(),
  /** Password the migration step sets for the least-privilege app role. */
  APP_DB_PASSWORD: z.string().min(16, 'must be at least 16 characters'),
});

/** claude.ai's OAuth callback; Anthropic announced it may move to claude.com. */
export const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

/** Values that may be passed as files. The GitHub client id is not secret, but travels with its secret. */
const SECRET_NAMES = [
  'DATABASE_PASSWORD',
  'MIGRATION_DATABASE_PASSWORD',
  'APP_DB_PASSWORD',
  'BETTER_AUTH_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
];

export interface AppConfig {
  publicBaseUrl: string;
  port: number;
  databaseUrl: string;
  secret: string;
  github: { clientId: string; clientSecret: string };
  allowedGithubUserIds: number[];
  resources: string[];
  allowedRedirectUris: string[];
}

export interface MigrationConfig {
  ownerUrl: string;
  appPassword: string;
}

type Env = Record<string, string | undefined>;

/** Replaces `X_FILE` entries with the file content as `X`. Fails if both are set. */
export function resolveFileSecrets(env: Env, names: readonly string[] = SECRET_NAMES): Env {
  const resolved = { ...env };
  for (const name of names) {
    const file = env[`${name}_FILE`];
    if (file === undefined) continue;
    if (env[name] !== undefined) {
      throw new Error(`Set either ${name} or ${name}_FILE, not both`);
    }
    try {
      resolved[name] = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error(`Cannot read ${name}_FILE (${file})`);
    }
  }
  return resolved;
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(resolveFileSecrets(env));
  if (!result.success) {
    // Only report variable names and issue types, never values: they may contain credentials.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

/** Puts a separately supplied password into a connection URL. */
function withPassword(url: string, password: string | undefined): string {
  if (password === undefined) return url;
  const parsed = new URL(url);
  parsed.password = password;
  return parsed.toString();
}

export function loadAppConfig(env: Env = process.env): AppConfig {
  const config = parse(appSchema, env);
  return {
    // Canonical origin without a trailing slash: it becomes the token issuer.
    publicBaseUrl: new URL(config.PUBLIC_BASE_URL).origin,
    port: config.PORT,
    databaseUrl: withPassword(config.DATABASE_URL, config.DATABASE_PASSWORD),
    secret: config.BETTER_AUTH_SECRET,
    github: { clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET },
    allowedGithubUserIds: config.ALLOWED_GITHUB_USER_IDS,
    resources: config.RESOURCES,
    allowedRedirectUris: config.OAUTH_REDIRECT_URIS ?? DEFAULT_REDIRECT_URIS,
  };
}

export function loadMigrationConfig(env: Env = process.env): MigrationConfig {
  const config = parse(migrationSchema, env);
  return {
    ownerUrl: withPassword(config.MIGRATION_DATABASE_URL, config.MIGRATION_DATABASE_PASSWORD),
    appPassword: config.APP_DB_PASSWORD,
  };
}
