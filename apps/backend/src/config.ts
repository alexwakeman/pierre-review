import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

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

// Exported so the Fastify factory (app.ts) can read its own numeric knobs
// (bodyLimit / requestTimeout) with the same "unset or unparseable ⇒ fallback"
// semantics as everything in `config`, without a second copy of the parser.
export function intFromEnv(key: string, fallback: number): number {
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

// The Claude Agent SDK `effort` levels (guides thinking depth + overall token
// spend). Lower effort → fewer/cheaper thinking tokens + terser output. NOTE:
// `effort` is rejected by Haiku 4.5 — only models that accept it get it (see
// review/agent.ts EFFORT_CAPABLE_MODELS).
const REVIEW_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];
function effortFromEnv(key: string, fallback: ReviewEffort): ReviewEffort {
  const raw = process.env[key];
  return (REVIEW_EFFORTS as readonly string[]).includes(raw ?? '')
    ? (raw as ReviewEffort)
    : fallback;
}

// ---- Deployment mode (the master switch) ----
// `local` (default): SQLite via better-sqlite3, `gh auth token` auth, one
// implicit account, no landing page — the unchanged zero-config experience.
// `cloud`: Postgres, GitHub sign-in (OAuth App and/or GitHub App), many accounts, landing page.
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

// ---- Phase 2 real-time sync: adaptive polling (see docs/REALTIME-SYNC.md) ----
// DEFAULT ON IN BOTH MODES. This is the PRIMARY sync strategy everywhere, because it's the
// only one that needs no cooperation from the repo's owner: webhooks require the GitHub App
// to be INSTALLED on each repo, and most watched repos are third-party public ones nobody
// here can install on. Adaptive works on all of them — cadence by activity bucket, plus a
// conditional REST probe whose 304 costs no rate limit, so it's both fresher on active repos
// and cheaper on quiet ones than the fixed-clock re-walk.
//
// Webhooks stay strictly ADDITIVE on top (cloud, installed repos only): a delivery fires a
// targeted syncOnePr in seconds, and adaptive keeps reconciling everything else. The two
// compose — nothing double-syncs, since both funnel into the idempotent persistPr.
// `SYNC_ADAPTIVE=false` restores the classic fixed-clock re-walk in either mode.
// Hoisted above `config` because the syncCron default below keys off it.
const syncAdaptive = process.env.SYNC_ADAPTIVE
  ? process.env.SYNC_ADAPTIVE === 'true'
  : true;

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
  // After a repo's first full sync (and any forced deep re-sync), backfill CI HISTORY so the
  // Activity tab's CI charts aren't blank on a fresh repo: trunk commits back to the 90-day
  // trend window, plus per-PR CI transition events synthesized from GitHub's retained check
  // rollups (sync/backfill-ci-history.ts). One-time, bounded GraphQL spend per repo;
  // CI_HISTORY_BACKFILL=false disables it.
  ciHistoryBackfill: process.env.CI_HISTORY_BACKFILL
    ? process.env.CI_HISTORY_BACKFILL === 'true'
    : true,
  // How many commit-file REST fetches to keep in flight at once (one pool per
  // page). These draw from the REST quota (disjoint from the GraphQL points
  // pool), so a modest pool safely cuts the dominant sync stage.
  commitFileConcurrency: intFromEnv('COMMIT_FILE_CONCURRENCY', 10),
  // The scheduler TICK, not the per-repo cadence. Under adaptive polling the tick must be
  // faster than the hot bucket (syncHotIntervalSec, 120s) or the due-check can never grant
  // it — a */5 tick would pin every repo to 5 min and throw away the freshness half of
  // Phase 2 — so adaptive defaults the tick to every minute and lets isDue() decide what
  // actually syncs. Non-adaptive keeps the classic fixed */5 re-walk. SYNC_CRON overrides.
  syncCron: process.env.SYNC_CRON ?? (syncAdaptive ? '*/1 * * * *' : '*/5 * * * *'),
  syncOverlapMinutes: intFromEnv('SYNC_OVERLAP_MINUTES', 20),
  // Phase 0 real-time sync (see docs/REALTIME-SYNC.md). enqueuePrSync coalesces a burst
  // of change signals for the SAME PR — a push emits push + synchronize + check_run
  // within seconds — into ONE targeted syncOnePr fired this many ms after the burst
  // settles. Fed by webhooks (cloud) / the adaptive scheduler (local); unused until
  // those land. WEBHOOK_DEBOUNCE_MS overrides.
  webhookDebounceMs: intFromEnv('WEBHOOK_DEBOUNCE_MS', 4000),

  // Resolved above (default ON in BOTH modes). When on, the scheduler's per-repo pass
  // becomes adaptive: the tick runs every minute but a repo only syncs when it's DUE for
  // its activity bucket, and — for incremental syncs — a cheap conditional REST probe runs
  // first, skipping the fat GraphQL walk when nothing changed (a 304 costs no rate limit).
  // In cloud it composes with the activity-gate (idle tenants are skipped first) and with
  // webhooks (which bypass the cadence entirely for installed repos).
  syncAdaptive,
  // Per-bucket minimum seconds between sync attempts. A repo is "hot" when a PR changed
  // within the last hour, "warm" within 6h, else "cold" (windows are constants in
  // sync/adaptive.ts). Fresher where activity is; backs off when quiet.
  syncHotIntervalSec: intFromEnv('SYNC_HOT_INTERVAL_SEC', 120),
  syncWarmIntervalSec: intFromEnv('SYNC_WARM_INTERVAL_SEC', 300),
  syncColdIntervalSec: intFromEnv('SYNC_COLD_INTERVAL_SEC', 900),
  // The conditional probe can't see CI-finish / thread-resolve (they don't bump a PR's
  // updatedAt), so force a full re-walk at least this often even when the probe says
  // "unchanged" — the floor that keeps those signals fresh. SYNC_FLOOR_INTERVAL_SEC.
  syncFloorIntervalSec: intFromEnv('SYNC_FLOOR_INTERVAL_SEC', 1800),
  // CLOUD ONLY: the scheduled sync skips any account whose loaded frontend hasn't
  // been seen within this many minutes (accounts.lastActiveAt), so a tenant with no
  // open tab is not re-synced every 5 min. Comfortably exceeds the cron period so a
  // user active a few minutes ago isn't dropped between ticks. Local mode ignores
  // this entirely (one always-on account). SYNC_ACTIVE_WINDOW_MINUTES overrides.
  syncActiveWindowMinutes: intFromEnv('SYNC_ACTIVE_WINDOW_MINUTES', 15),
  stallThresholdDays: intFromEnv('STALL_THRESHOLD_DAYS', 3),
  // ---- Retention / TTL ----
  // Per-account server data doesn't grow forever: a periodic sweep prunes PRs (and their
  // whole subtree) whose `updatedAt` is older than this many days. 0 disables it. The
  // effective cutoff is clamped to at least `backfillDays`, so a forced full sync (which
  // re-walks `now − backfillDays`) can never re-fetch (resurrect) a just-deleted PR.
  // Runs in BOTH modes (local + cloud). RETENTION_DAYS overrides.
  retentionDays: intFromEnv('RETENTION_DAYS', 180),
  // When the retention sweep runs (node-cron). Daily at 03:00 by default; off-peak so a
  // large delete doesn't contend with the 5-minute sync. RETENTION_CRON overrides.
  retentionCron: process.env.RETENTION_CRON ?? '0 3 * * *',
  // Cross-org benchmark rollup (CLOUD-ONLY; inert unless an account has opted in). Weekly,
  // Monday 04:00 UTC — after a fresh ISO week starts, off-peak. BENCHMARK_ROLLUP_CRON overrides.
  benchmarkRollupCron: process.env.BENCHMARK_ROLLUP_CRON ?? '0 4 * * 1',
  // Disable the periodic scheduler (used by scripts/tests).
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',

  // ---- ML severity/category enrichment of bot comments (CORE, free tier) ----
  // Classifies BOT-authored review comments, PR comments and review bodies against the
  // `severity-api` microservice from the `packages/ml` submodule (a fine-tuned ModernBERT-ONNX
  // severity model + a deterministic category parser). No LLM, nothing billed. Full contract +
  // the local run recipe: docs/ML-SEVERITY.md.
  //
  // THE GATE IS THE URL. `SEVERITY_API_URL` unset ⇒ the whole feature is inert: no worker, no
  // routes registered, `/api/me` reports mlSeverity:false and the SPA issues zero ML queries.
  // That is deliberately the same switch that makes the feature UNAVAILABLE under
  // `npx pierre-review` — the published package ships no model and config.ts's .env search
  // paths resolve against the INSTALL directory, so an npx user has nowhere to put the var.
  // Cloud sets it to the Railway private-DNS name; local dev to the sibling repo's port.
  // ML_SEVERITY_DISABLED=true is the kill switch for a deployment that has the URL set.
  //
  // SEVERITY_API_DEFAULT_URL is a DEV-LOOP FALLBACK, never a deployment knob: `pnpm dev`
  // (scripts/dev.mjs) exports it only after confirming it can actually start the sibling repo's
  // service, so the backend points at a service that exists without anyone editing `.env`. It is
  // deliberately a SECOND variable rather than a default assigned to SEVERITY_API_URL, because
  // `process.loadEnvFile` does NOT overwrite an already-set variable — a command-line
  // SEVERITY_API_URL would therefore have BEATEN the developer's own `.env`, inverting the
  // precedence a default is supposed to have. Nothing but the dev script ever sets it.
  severityApiUrl:
    process.env.ML_SEVERITY_DISABLED === 'true'
      ? ''
      : (process.env.SEVERITY_API_URL ?? process.env.SEVERITY_API_DEFAULT_URL ?? '').replace(
          /\/$/,
          '',
        ),
  // Extra headers for every severity-api call, as a JSON object string — e.g.
  // `SEVERITY_API_HEADERS='{"X-Severity-Token":"…"}'`. Empty in both shipped deployments, which
  // reach the service over private DNS (cloud) or loopback (local) and need no credential. It
  // exists so a RENTED endpoint can be used without a code change — draining a large backlog on
  // hired CPUs is far faster than a dev box, and that endpoint must not be open to the internet.
  // Parsing is deliberately forgiving; see `extraHeaders()` in ml/severity-client.ts for why a
  // malformed value must not throw.
  severityApiHeaders: process.env.SEVERITY_API_HEADERS ?? '',
  // The enrichment worker's own cron — a TICK, not a cadence: each tick drains as much of the
  // unlabelled backlog as its wall-clock budget allows, newest-first. Separate from the sync
  // cron on purpose (the two are independent, and enrichment must never delay a sync).
  mlEnrichmentCron: process.env.ML_ENRICHMENT_CRON ?? '*/2 * * * *',
  // Wall-clock ceiling for one tick. Sized under the cron period so ticks never overlap in
  // practice (a re-entrancy guard covers the case where they would anyway).
  mlTickBudgetMs: intFromEnv('ML_TICK_BUDGET_MS', 90_000),
  // Batch shape. The service caps a request at 256 items (422 beyond), but ITEM COUNT is the
  // wrong budget: inference cost tracks TOTAL TEXT, and a batch pads to its longest member, so
  // one 8k-char walkthrough in a batch of 128 makes every slot cost like the walkthrough.
  // Measured on an Intel i9: 32 short bodies 2.7s vs 32 long bodies 28.4s. The worker therefore
  // sorts candidates by length and fills batches to a CHARACTER budget, capping the count too.
  mlBatchMaxItems: intFromEnv('ML_BATCH_MAX_ITEMS', 128),
  mlBatchMaxChars: intFromEnv('ML_BATCH_MAX_CHARS', 24_000),
  // How many batch requests are in flight at once. The deployed service runs 2 uvicorn workers,
  // so 2 saturates it; more just queues.
  mlConcurrency: intFromEnv('ML_CONCURRENCY', 2),
  // Per-request timeout. A cold start loads a ~150 MB model, and a long batch is legitimately
  // slow on CPU, so this is generous by design.
  mlRequestTimeoutMs: intFromEnv('ML_REQUEST_TIMEOUT_MS', 120_000),
  // The model truncates at 512 tokens, so anything past ~2.5k chars is discarded server-side.
  // Trimming client-side bounds the request payload without changing what the model sees.
  mlBodyMaxChars: intFromEnv('ML_BODY_MAX_CHARS', 6_000),

  // ---- Cloud (Railway) — GitHub sign-in + sessions + token encryption ----
  // Public base URL of the deployment (no trailing slash); used to build the
  // OAuth redirect_uri and absolute links. Locally http://localhost:<port>.
  appBaseUrl:
    process.env.APP_BASE_URL?.replace(/\/$/, '') ??
    `http://localhost:${intFromEnv('PORT', 4000)}`,
  // Cloud supports TWO sign-in providers side by side; a deployment configures either or both
  // and the SignInGate offers whatever's set. They are SEPARATE GitHub registrations (distinct
  // client id/secret) but share the same authorize/token endpoints — the flow only differs in
  // which credential it uses and whether it requests `oauthScope` (see api/routes/auth.ts).
  //
  //  • OAuth App  — user-scoped token, NO installation. `public_repo` reads public repos incl.
  //    CI checks/statuses (what an unscoped token can't) + enables the interactive PR actions.
  //  • GitHub App — user-to-server token; for PRIVATE repos the App must be INSTALLED where they
  //    live (public repos work without install, but reading CI Checks/Actions needs install).
  githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? '',
  githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
  // Scopes requested by the OAuth App at authorize time. Default = public repos only (widen to
  // `repo read:org` for private-repo access via OAuth).
  oauthScope: process.env.GITHUB_OAUTH_SCOPE ?? 'public_repo read:org',
  githubAppClientId: process.env.GITHUB_APP_CLIENT_ID ?? '',
  githubAppClientSecret: process.env.GITHUB_APP_CLIENT_SECRET ?? '',
  // The GitHub App's URL slug — builds the private-repo install link
  // (github.com/apps/<slug>/installations/new), shown on the sign-in gate.
  githubAppSlug: process.env.GITHUB_APP_SLUG ?? '',
  // GitHub App webhook shared secret (real-time sync Phase 1 — see docs/REALTIME-SYNC.md).
  // The App POSTs events to /api/webhooks/github; we verify X-Hub-Signature-256
  // (HMAC-SHA256 over the raw body) against this. Empty = the route replies 501
  // (unconfigured), so webhook-driven sync is INERT until it's set — a deployment opts
  // in additively without weakening the periodic poll. Optional (NOT required by
  // assertCloudConfig). GITHUB_APP_WEBHOOK_SECRET.
  githubAppWebhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? '',
  // Derived: is each provider fully configured? (Both are optional; assertCloudConfig requires
  // at least one.) The auth routes + SignInGate gate on these.
  oauthProviderEnabled: !!(
    process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET
  ),
  appProviderEnabled: !!(
    process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET
  ),
  // Seals the session cookie ({accountId}). Rotate to invalidate all sessions.
  sessionSecret: process.env.SESSION_SECRET ?? '',
  // 32-byte (64-hex) key for AES-256-GCM encryption of stored access tokens.
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  // HSTS max-age (seconds) for the cloud public origin. Sent only in cloud mode
  // and honored only over HTTPS (Railway terminates TLS). Default 1 year. Set
  // HSTS_MAX_AGE=0 as a kill switch. `preload` is intentionally NOT sent — it is
  // hard to undo; opt in manually once the domain is proven.
  hstsMaxAge: intFromEnv('HSTS_MAX_AGE', 31536000),

  // ---- Stripe billing (optional; NOT required by assertCloudConfig) ----
  // Payment Link URL for the Pro plan — GET /api/billing/checkout 302s to it with
  // client_reference_id=<accountId> appended. Empty = checkout unavailable.
  stripePaymentLinkUrl: process.env.STRIPE_PAYMENT_LINK_URL ?? '',
  // Webhook signing secret (whsec_…) for POST /api/billing/webhook. Empty = the
  // webhook replies 501 and no billing state ever changes.
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',

  // Pro plugin master gate. bind.ts skips the dynamic import entirely when false.
  // PRO_DISABLED=true forces pure-OSS mode even when the submodule is checked out (used to
  // exercise/capture the free tier). Local defaults ON. In CLOUD it stays OFF unless
  // PRO_CLOUD_ENABLED=true (the paid summary-AI tier — set on the Railway image), so the
  // public Dockerfile / OSS npm path is byte-identical to before. Even when true in cloud,
  // per-account entitlement (plan !== 'free') + the /api/pro/* 402 gate decide who actually
  // gets Pro; agentic AI stays independently gated by PRO_ADVANCED_AI_ENABLED (unset → off).
  proEnabled:
    process.env.PRO_DISABLED !== 'true' &&
    (!isCloud || process.env.PRO_CLOUD_ENABLED === 'true'),
  // Per-repo digest (Pro, Workstream 2) config — consumed by @pierre/pro, kept in
  // core so the model id / budgets live in one place and aren't hardcoded at call
  // sites. Inert until the plugin is present AND digestEnabled.
  pro: {
    digestModel: process.env.PRO_DIGEST_MODEL ?? 'claude-haiku-4-5',
    // The period-report narration's default model (plan P4.1 — a forwarded sprint retro is worth
    // more prose care than a per-repo digest, at ~2 generations/month/workspace). Reaches the
    // plugin the same way digestModel does — the env var itself (@pierre/pro reads
    // PRO_REPORT_MODEL in llm/seam.ts's DEFAULT_REPORT_MODEL); this entry keeps the model ids in
    // the one place they are all documented. The plugin validates the value against its
    // REPORT_MODELS allowlist — an unpriceable id here silently falls back to the plugin's
    // default rather than reaching a meter. Per-account override: pro_settings.report_model;
    // per-run override: the generate call's `model` body field. The model id is folded into the
    // narration's payload hash, so changing this regenerates each report deliberately, once.
    reportModel: process.env.PRO_REPORT_MODEL ?? 'claude-sonnet-5',
    digestEnabled: process.env.PRO_DIGEST_ENABLED === 'true',
    digestMaxUsdPerRefresh: floatFromEnv('PRO_DIGEST_MAX_USD', 0.5),
    digestMaxReposPerRefresh: intFromEnv('PRO_DIGEST_MAX_REPOS', 30),
    digestMinIntervalSec: intFromEnv('PRO_DIGEST_MIN_INTERVAL_SEC', 60),
  },

  // ---- Claude Review — CORE infra knobs (the product moved to @pierre/pro) ----
  // The SDK-run / diff-prep infra behind the ctx.review seam reads these. The old
  // `claudeReviewEnabled` env flag was removed — Claude Review is now the Pro
  // `claudeReview` capability (PRO_CLAUDE_REVIEW_ENABLED); the routing thresholds,
  // concurrency + queue caps, and the default-model picker moved to PRO_REVIEW_* env.
  // Partial clones + ephemeral worktrees live here (a user-writable home path,
  // never the read-only install dir). CLONE_DIR overrides.
  cloneDir: process.env.CLONE_DIR ?? resolve(homedir(), '.pierre-review', 'clones'),
  // Soft cap on the clone cache before LRU cleanup evicts idle repos (default 2 GiB).
  cloneCacheMaxBytes: intFromEnv('CLONE_CACHE_MAX_BYTES', 2 * 1024 * 1024 * 1024),
  // Per-run caps (cost/disk/time runaway guards). The diff is inlined in full, so
  // reviews need far fewer turns than the old default; 30 is still generous.
  reviewMaxTurns: intFromEnv('REVIEW_MAX_TURNS', 30),
  // Hard USD ceiling per run. When the SDK trips this it returns an
  // `error_max_budget_usd` result BEFORE the agent calls submit_review — so a run
  // that hits the cap is recorded FAILED and still bills (you pay for no review).
  // The cap must therefore sit ABOVE the cost of a normal completed review, not at
  // it; `reviewEffort` below is the real cost lever (a large diff at default-high
  // effort is what blew the old $1 cap). Lower REVIEW_BUDGET_USD only if you'd
  // rather a borderline review fail than complete. Users can override this per
  // review in the Claude Review tab (local settings), up to a $5 hard ceiling.
  reviewBudgetUsd: floatFromEnv('REVIEW_BUDGET_USD', 3),
  // Turn cap for a diff-only run. These are TOOL-LESS (only submit_review), so they
  // should finish in ~2 turns; a tight cap is a cheap runaway guard.
  reviewDiffOnlyMaxTurns: intFromEnv('REVIEW_DIFF_ONLY_MAX_TURNS', 6),
  // Haiku reaches a conclusion in MORE steps than Sonnet/Opus (smaller model, more
  // tool round-trips), so it routinely tripped the turn cap mid-review and failed.
  // Give it proportionally more turns in both modes. Its low per-token price means
  // the extra turns are cheap, and maxBudgetUsd is still the real spend guard.
  reviewHaikuTurnMultiplier: floatFromEnv('REVIEW_HAIKU_TURN_MULTIPLIER', 2),

  // ---- Diff-size cap ----
  // A very large inlined diff is the dominant cost on a big PR (it's the cached
  // prefix re-read every turn). The diff shown IN THE PROMPT is truncated at a
  // whole-file boundary to this many characters; routing + line anchoring still use
  // the FULL diff, and the changed-file LIST stays complete (so a worktree run can
  // Read the omitted files). ON by default — it proved its worth on a large PR that
  // failed without it. ~60k chars ≈ ~15k tokens, so only outlier PRs are truncated
  // and a normal review is unaffected; each run records diffCapped + the full diff
  // size, so you can still A/B by setting REVIEW_DIFF_CAP_ENABLED=false for a
  // baseline run and comparing the recorded cost.
  reviewDiffCapEnabled: process.env.REVIEW_DIFF_CAP_ENABLED !== 'false',
  reviewDiffCapChars: intFromEnv('REVIEW_DIFF_CAP_CHARS', 60000),
  // Agent `effort` per mode — the dominant cost knob (unset ⇒ the SDK default
  // `high`, which over-thinks bounded reviews). A diff-only run just hunts bugs in a
  // small inlined diff, so `low` is plenty; a worktree run reasons across files, so
  // `medium` keeps that while trimming the over-exploration that ran up the bill.
  // Applied only to effort-capable models (Sonnet/Opus); Haiku ignores it.
  reviewEffort: effortFromEnv('REVIEW_EFFORT', 'medium'),
  reviewDiffOnlyEffort: effortFromEnv('REVIEW_DIFF_ONLY_EFFORT', 'low'),
  // (Review concurrency + queue caps + the routing thresholds moved to the plugin's
  // PRO_REVIEW_* env — the plugin owns the queue/manager + the mode-routing decision.)

  // ---- AI Fix (Pro: agentic code fixer) — core infra knobs ----
  // The write-capable fixer (packages/pro/ai-fix) reuses the review clone/agent
  // machinery. A runaway fixer is pricier than a review (it edits + re-reads files),
  // so the caps are a touch higher on turns but the USD ceiling is the real guard.
  // Concurrency is 1: the fixer relies on ambient Claude auth WITHOUT mutating
  // process.env (which would race the review manager), so only one fix runs at once.
  aiFixMaxTurns: intFromEnv('AI_FIX_MAX_TURNS', 40),
  aiFixBudgetUsd: floatFromEnv('AI_FIX_BUDGET_USD', 3),
  aiFixConcurrency: intFromEnv('AI_FIX_CONCURRENCY', 1),
  // Refuse a fix whose captured patch exceeds this (a runaway diff shouldn't bloat a
  // DB row). ~1 MiB of unified diff is already a very large change.
  aiFixPatchMaxBytes: intFromEnv('AI_FIX_PATCH_MAX_BYTES', 1024 * 1024),
  // Cap the per-commit conflict-resolution loop during a rebase onto the trunk: each
  // rebased commit that conflicts gets one resolver pass, up to this many steps, then
  // we abort the rebase rather than loop forever on a pathological history.
  aiFixRebaseMaxSteps: intFromEnv('AI_FIX_REBASE_MAX_STEPS', 10),
} as const;

export type Config = typeof config;

// Fail loud at startup if a required cloud var is missing — mirrors the
// gh-auth loud failure. Called from index.ts only when deploymentMode==='cloud'.
export function assertCloudConfig(): void {
  const required: Array<[string, string]> = [
    ['DATABASE_URL', config.databaseUrl],
    ['APP_BASE_URL', process.env.APP_BASE_URL ?? ''],
    ['SESSION_SECRET', config.sessionSecret],
    ['ENCRYPTION_KEY', config.encryptionKey],
  ];
  // At least ONE sign-in provider must be fully configured; a deployment may enable either or
  // both. A GitHub App with no OAuth App (or vice-versa) is fine.
  if (!config.oauthProviderEnabled && !config.appProviderEnabled) {
    throw new Error(
      'Cloud mode needs at least one GitHub sign-in method configured: set ' +
        'GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET (OAuth App, public repos) and/or ' +
        'GITHUB_APP_CLIENT_ID + GITHUB_APP_CLIENT_SECRET (GitHub App, adds private org repos via ' +
        'install). See docs/GITHUB-AUTH-SETUP.md.',
    );
  }
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
  // SESSION_SECRET needs the SAME rigour as ENCRYPTION_KEY, and previously got none — it was
  // only checked for being non-empty. It is not a "secret" in the guessable-password sense:
  // api/plugins/auth.ts derives the sealing key as sha256(SESSION_SECRET) and hands that to
  // @fastify/secure-session as a raw `key`, which BYPASSES that library's own 32-byte
  // minimum and its deliberately-slow crypto_pwhash KDF. A single SHA-256 per candidate makes
  // a short secret brute-forceable offline, and whoever recovers it can mint a valid
  // `pierre_session` cookie for accountId = 1..N — i.e. read and write every tenant's data
  // and spend every tenant's stored GitHub token. That makes it the single highest-value
  // secret in the deployment, so a weak one must fail the boot, not merely be discouraged.
  if (Buffer.byteLength(config.sessionSecret, 'utf8') < 32) {
    throw new Error(
      'SESSION_SECRET must be at least 32 bytes. It is stretched with a single SHA-256 into ' +
        'the session sealing key, so a short or guessable value is brute-forceable offline ' +
        'and lets an attacker forge a session for ANY account. Generate one with ' +
        '`openssl rand -hex 32`.',
    );
  }
  // Reject the obvious placeholders outright — length alone would pass 'changeme-changeme-…'.
  const weakSecrets = ['changeme', 'change-me', 'secret', 'password', 'pierre', 'test'];
  const lowered = config.sessionSecret.toLowerCase();
  if (weakSecrets.some((w) => lowered.startsWith(w) || lowered === w.repeat(4))) {
    throw new Error(
      'SESSION_SECRET looks like a placeholder. Generate a real one: `openssl rand -hex 32`.',
    );
  }
  // A cookie marked `secure` is only sent over HTTPS, and that flag is derived from
  // APP_BASE_URL's scheme (api/plugins/auth.ts). An https deployment configured with an
  // http:// base URL therefore ships its session cookie in the clear over the public
  // internet — a silent, total session-hijack exposure from a one-character typo. Refuse to
  // boot a non-localhost cloud deployment on plain http.
  if (!config.appBaseUrl.startsWith('https://')) {
    const host = (() => {
      try {
        return new URL(config.appBaseUrl).hostname;
      } catch {
        return '';
      }
    })();
    const isLocalTest = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLocalTest) {
      throw new Error(
        `APP_BASE_URL must be https:// in cloud mode (got "${config.appBaseUrl}"). The ` +
          'session cookie\'s `secure` flag is derived from this scheme, so an http:// value ' +
          'would send the session cookie unencrypted. Use http:// only for localhost testing.',
      );
    }
  }
  // When Pro is cloud-enabled the SUMMARY seam needs its OWN metered credential: there is no
  // ambient logged-in `claude` session on Railway, so without SUMMARY_ANTHROPIC_API_KEY every
  // summary completion has no credential and silently fails. Fail loud instead.
  if (config.proEnabled && !process.env.SUMMARY_ANTHROPIC_API_KEY) {
    throw new Error(
      'Cloud Pro (PRO_CLOUD_ENABLED=true) requires SUMMARY_ANTHROPIC_API_KEY — the metered ' +
        'Anthropic key the summary seam spends against (no ambient Claude session exists in cloud). ' +
        'Set it or unset PRO_CLOUD_ENABLED. See docs/DEPLOY-RAILWAY.md.',
    );
  }
}
