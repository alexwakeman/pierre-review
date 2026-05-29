import { resolve } from 'node:path';

// apps/backend as the base for relative paths regardless of cwd.
const backendRoot = resolve(import.meta.dirname, '..');

// Load .env from the repo root and (optionally) apps/backend before reading
// any config. Node's loader no-ops politely if a file is missing.
for (const envPath of [
  resolve(backendRoot, '../../.env'),
  resolve(backendRoot, '.env'),
]) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* no .env at this location */
  }
}

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const rawDbUrl = process.env.DATABASE_URL ?? './data/gh-team-monitor.sqlite';

export const config = {
  port: intFromEnv('PORT', 4000),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: rawDbUrl.startsWith('/') ? rawDbUrl : resolve(backendRoot, rawDbUrl),
  backfillDays: intFromEnv('BACKFILL_DAYS', 90),
  syncCron: process.env.SYNC_CRON ?? '*/5 * * * *',
  syncOverlapMinutes: intFromEnv('SYNC_OVERLAP_MINUTES', 20),
  stallThresholdDays: intFromEnv('STALL_THRESHOLD_DAYS', 3),
  // Disable the periodic scheduler (used by scripts/tests).
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',
} as const;

export type Config = typeof config;
