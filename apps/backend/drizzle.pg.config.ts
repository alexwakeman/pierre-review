import { defineConfig } from 'drizzle-kit';

// Postgres (cloud mode) config. Generates into a SEPARATE out dir so the sqlite
// and pg journals never collide. Default URL matches docker-compose's Postgres.
//   pnpm db:generate:pg   → diff schema.pg.ts → migrations-pg/NNNN_*.sql
//   pnpm db:migrate:pg    → apply (run-migrations picks this folder in cloud mode)
const dbUrl =
  process.env.DATABASE_URL ?? 'postgres://pierre:pierre@localhost:5432/pierre_review';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.pg.ts',
  out: './src/db/migrations-pg',
  dbCredentials: {
    url: dbUrl,
  },
  strict: true,
  verbose: true,
});
