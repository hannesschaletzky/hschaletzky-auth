// Used only to (re)generate src/db/schema.ts with the Better Auth CLI after upgrading Better Auth:
//   npx auth generate --config scripts/better-auth-schema.ts --output src/db/schema.ts --yes
//   npm run format && npm run db:generate
// The plugin list must match src/auth/better-auth.ts; values here are placeholders.
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins';

export const auth = betterAuth({
  baseURL: 'http://localhost:4000',
  secret: 'schema-generation-only-not-a-secret-000',
  database: drizzleAdapter({}, { provider: 'pg' }),
  plugins: [
    jwt(),
    oauthProvider({ loginPage: '/login', consentPage: '/consent' }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
  ],
});
