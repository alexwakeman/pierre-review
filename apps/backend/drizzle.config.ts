import { defineConfig } from 'drizzle-kit';

// SQLite (local mode) config. The Postgres config lives in drizzle.pg.config.ts.
const dbUrl = process.env.DATABASE_URL ?? './data/pierre-review.sqlite';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.sqlite.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: dbUrl,
  },
  strict: true,
  verbose: true,
});
