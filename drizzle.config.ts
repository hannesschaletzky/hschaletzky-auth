import { defineConfig } from 'drizzle-kit';

// Only `generate` runs through drizzle-kit (no database needed).
// Migrations are applied by src/db/migrate.ts so production does not need dev tooling.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
