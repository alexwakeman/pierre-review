import { defineConfig } from 'drizzle-kit';

const dbUrl = process.env.DATABASE_URL ?? './data/gh-team-monitor.sqlite';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: dbUrl,
  },
  strict: true,
  verbose: true,
});
