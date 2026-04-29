import { defineConfig } from 'drizzle-kit';

// drizzle-kit loads this config outside tsx, so it can't resolve our
// workspace TS imports (e.g. `./src/config.js`). Read DATABASE_URL
// straight from the environment — populated by `--env-file=` in the
// db:push / db:seed scripts (apps/api/package.json) or by Railway in
// deployed envs.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required for drizzle-kit. Run via `pnpm --filter @familyhub/api db:push` (loads .env.local) or set it explicitly.',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL,
  },
});
