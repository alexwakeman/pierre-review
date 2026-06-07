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

// ---- Deployment mode (the master switch) ----
// `local` (default): SQLite via better-sqlite3, `gh auth token` auth, one
// implicit account, no landing page — the unchanged zero-config experience.
// `cloud`: Postgres, GitHub App OAuth, many accounts, public landing page.
// Everything dialect/tenancy-specific branches off `deploymentMode`.
const deploymentMode: 'local' | 'cloud' =
  process.env.DEPLOYMENT_MODE === 'cloud' ? 'cloud' : 'local';
const isCloud = deploymentMode === 'cloud';

// Default the SQLite DB under apps/backend/data for local dev. The INSTALLED CLI
// instead points DATABASE_URL at a user-writable ~/.pierre-review path (see
// cli.ts) BEFORE config loads — so `pnpm dev` and a globally-installed `pierre`
// never share a database. Sharing one would be a trap: each process has its own
// in-memory "is-syncing" guard, so two of them double-sync every repo against the
// GitHub rate limit and contend on the SQLite write lock. DATABASE_URL / --db
// override this; a relative override resolves under apps/backend.
//
// In cloud mode DATABASE_URL is a `postgres://…` connection string (not a path),
// so dbPath is irrelevant there and left as the connection string verbatim.
const rawDbUrl =
  process.env.DATABASE_URL ?? (isCloud ? '' : './data/pierre-review.sqlite');

export const config = {
  deploymentMode,
  isCloud,
  // Drives the DB driver + schema selection in client.ts.
  dbDialect: (isCloud ? 'postgres' : 'sqlite') as 'sqlite' | 'postgres',

  // ---- Lean storage (both modes by default) ----
  // When false (the default), sync does NOT persist bulky user-authored text —
  // comment / review / PR bodies, review-comment diff hunks, commit messages, and
  // the per-job checkRuns JSON (the ci_status summary enum is kept). That text is
  // regenerable from GitHub (and duplicated per tenant in cloud), so it's the
  // dominant storage cost; it's hydrated on demand when a PR/thread is opened
  // (sync/hydrate-detail.ts, via the gh-CLI token locally or the OAuth token in
  // cloud) and cached in the browser. Not storing it also shrinks the DB and the
  // sync payload, speeding up an initial backfill. Set PERSIST_BODIES=true to store
  // full bodies instead — instant, fully-offline detail at the cost of a larger DB
  // (e.g. a local instance used without network).
  persistBodies: process.env.PERSIST_BODIES === 'true',
  // Postgres connection string (cloud only). Empty in local mode.
  databaseUrl: process.env.DATABASE_URL ?? '',

  port: intFromEnv('PORT', 4000),
  host: process.env.HOST ?? (isCloud ? '0.0.0.0' : '127.0.0.1'),
  dbPath:
    isCloud || isAbsolute(rawDbUrl) ? rawDbUrl : resolve(backendRoot, rawDbUrl),
  backfillDays: intFromEnv('BACKFILL_DAYS', 90),
  // First sync runs in two phases: a fast "foreground" window (matching the
  // default timeline range) so the board is usable in seconds, then the rest of
  // backfillDays is fetched in the background. Two-phase only kicks in when
  // backfillDays exceeds this.
  foregroundSyncDays: intFromEnv('FOREGROUND_SYNC_DAYS', 14),
  // How many commit-file REST fetches to keep in flight at once (one pool per
  // page). These draw from the REST quota (disjoint from the GraphQL points
  // pool), so a modest pool safely cuts the dominant sync stage.
  commitFileConcurrency: intFromEnv('COMMIT_FILE_CONCURRENCY', 10),
  syncCron: process.env.SYNC_CRON ?? '*/5 * * * *',
  syncOverlapMinutes: intFromEnv('SYNC_OVERLAP_MINUTES', 20),
  stallThresholdDays: intFromEnv('STALL_THRESHOLD_DAYS', 3),
  // Disable the periodic scheduler (used by scripts/tests).
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',

  // ---- Cloud (Railway) — GitHub App OAuth + sessions + token encryption ----
  // Public base URL of the deployment (no trailing slash); used to build the
  // OAuth redirect_uri and absolute links. Locally http://localhost:<port>.
  appBaseUrl:
    process.env.APP_BASE_URL?.replace(/\/$/, '') ??
    `http://localhost:${intFromEnv('PORT', 4000)}`,
  githubAppClientId: process.env.GITHUB_APP_CLIENT_ID ?? '',
  githubAppClientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? '',
  githubAppSlug: process.env.GITHUB_APP_SLUG ?? '',
  // Seals the session cookie ({accountId}). Rotate to invalidate all sessions.
  sessionSecret: process.env.SESSION_SECRET ?? '',
  // 32-byte (64-hex) key for AES-256-GCM encryption of stored access tokens.
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',

  // ---- Claude Review (agentic PR review; opt-in, LOCAL-ONLY) ----
  // OFF by default: the feature spends real money / Agent-SDK credits per run.
  // Enable with ENABLE_CLAUDE_REVIEW=true. FORCE-DISABLED in cloud mode (it
  // shells out to a local gh + writable clone dir that don't exist on Railway).
  claudeReviewEnabled:
    !isCloud && process.env.ENABLE_CLAUDE_REVIEW === 'true',
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

// Fail loud at startup if a required cloud var is missing — mirrors the
// gh-auth loud failure. Called from index.ts only when deploymentMode==='cloud'.
export function assertCloudConfig(): void {
  const required: Array<[string, string]> = [
    ['DATABASE_URL', config.databaseUrl],
    ['APP_BASE_URL', process.env.APP_BASE_URL ?? ''],
    ['GITHUB_APP_CLIENT_ID', config.githubAppClientId],
    ['GITHUB_APP_CLIENT_SECRET', config.githubAppClientSecret],
    ['GITHUB_APP_SLUG', config.githubAppSlug],
    ['SESSION_SECRET', config.sessionSecret],
    ['ENCRYPTION_KEY', config.encryptionKey],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Cloud mode (DEPLOYMENT_MODE=cloud) requires these env vars: ${missing.join(
        ', ',
      )}. See .env.cloud.example and docs/DEPLOY-RAILWAY.md.`,
    );
  }
  if (Buffer.from(config.encryptionKey, 'hex').length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY must be 32 bytes as 64 hex chars (generate with `openssl rand -hex 32`).',
    );
  }
}
