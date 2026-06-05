import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { ClaudeReviewModel } from '@pierre-review/shared';

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

function floatFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Default the SQLite DB under apps/backend/data for local dev. The INSTALLED CLI
// instead points DATABASE_URL at a user-writable ~/.pierre-review path (see
// cli.ts) BEFORE config loads — so `pnpm dev` and a globally-installed `pierre`
// never share a database. Sharing one would be a trap: each process has its own
// in-memory "is-syncing" guard, so two of them double-sync every repo against the
// GitHub rate limit and contend on the SQLite write lock. DATABASE_URL / --db
// override this; a relative override resolves under apps/backend.
const rawDbUrl = process.env.DATABASE_URL ?? './data/pierre-review.sqlite';

export const config = {
  port: intFromEnv('PORT', 4000),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: isAbsolute(rawDbUrl) ? rawDbUrl : resolve(backendRoot, rawDbUrl),
  backfillDays: intFromEnv('BACKFILL_DAYS', 90),
  syncCron: process.env.SYNC_CRON ?? '*/5 * * * *',
  syncOverlapMinutes: intFromEnv('SYNC_OVERLAP_MINUTES', 20),
  stallThresholdDays: intFromEnv('STALL_THRESHOLD_DAYS', 3),
  // Disable the periodic scheduler (used by scripts/tests).
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',

  // ---- Claude Review (agentic PR review; opt-in) ----
  // OFF by default: the feature spends real money / Agent-SDK credits per run.
  // Enable with ENABLE_CLAUDE_REVIEW=true.
  claudeReviewEnabled: process.env.ENABLE_CLAUDE_REVIEW === 'true',
  // Partial clones + ephemeral worktrees live here (a user-writable home path,
  // never the read-only install dir). CLONE_DIR overrides.
  cloneDir: process.env.CLONE_DIR ?? resolve(homedir(), '.pierre-review', 'clones'),
  // Soft cap on the clone cache before LRU cleanup evicts idle repos (default 2 GiB).
  cloneCacheMaxBytes: intFromEnv('CLONE_CACHE_MAX_BYTES', 2 * 1024 * 1024 * 1024),
  // Default model for the picker; per-run model still overrides on the request.
  defaultReviewModel: (process.env.DEFAULT_REVIEW_MODEL as
    | ClaudeReviewModel
    | undefined) ?? 'claude-sonnet-4-6',
  // Per-run caps (cost/disk/time runaway guards).
  reviewMaxTurns: intFromEnv('REVIEW_MAX_TURNS', 40),
  reviewBudgetUsd: floatFromEnv('REVIEW_BUDGET_USD', 1.0),
  // At most one review per PR; this caps concurrent reviews across all PRs.
  reviewConcurrency: intFromEnv('REVIEW_CONCURRENCY', 1),
} as const;

export type Config = typeof config;
