import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultDocsDir, migrateLegacyDataDir, resolveDataDir } from './data-dir.js';
import {
  SPRINT_PATHS_BUDGET_USD_DEFAULT,
  SPRINT_PATHS_DAILY_CAP_DEFAULT,
  SPRINT_PATHS_MAX_TURNS_DEFAULT,
} from '@pierre-review/shared';

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


// Local: move a pre-rename ~/.pierre-review to ~/.limn, once, BEFORE anything below resolves a path
// inside the data directory (data-dir.ts). Here, not in index.ts's start(): `pnpm dev` imports this
// module first, so a later call would move the directory out from under `dataDir`/`cloneDir`. The
// .env files are loaded by now, so a DATABASE_URL/CLONE_DIR pinned inside the old directory is seen.
// The CLI already ran it before choosing the DB path; a second call is a no-op. Never under test.
if (!process.env.VITEST) {
  migrateLegacyDataDir({
    log: (msg) => console.log(msg),
    resolvePath: (p) => (isAbsolute(p) ? p : resolve(backendRoot, p)),
  });
}

// Default the SQLite DB under apps/backend/data for local dev. The INSTALLED CLI
// instead points DATABASE_URL at a user-writable ~/.limn path (see
// cli.ts) BEFORE config loads — so `pnpm dev` and a globally-installed `pierre`
// never share a database. Sharing one would be a trap: each process has its own
// in-memory "is-syncing" guard, so two of them double-sync every repo against the
// GitHub rate limit and contend on the SQLite write lock. DATABASE_URL / --db
// override this; a relative override resolves under apps/backend.
const rawDbUrl = process.env.DATABASE_URL ?? './data/pierre-review.sqlite';
const dbPath = isAbsolute(rawDbUrl) ? rawDbUrl : resolve(backendRoot, rawDbUrl);

// ---- Phase 2 real-time sync: adaptive polling (see docs/REALTIME-SYNC.md) ----
// DEFAULT ON. This is the PRIMARY sync strategy: cadence by activity bucket, plus a
// conditional REST probe whose 304 costs no rate limit, so it's both fresher on active repos
// and cheaper on quiet ones than the fixed-clock re-walk.
// `SYNC_ADAPTIVE=false` restores the classic fixed-clock re-walk.
// Hoisted above `config` because the syncCron default below keys off it.
const syncAdaptive = process.env.SYNC_ADAPTIVE
  ? process.env.SYNC_ADAPTIVE === 'true'
  : true;

// ---- Does THIS process serve the built SPA? ----
//
// The single source of truth for a question two places need: app.ts, to decide whether to
// register the @fastify/static instance at `/app/`, and `appWebUrl` below, to decide whether a
// deep link handed to a person should point here at all.
//
// The SPA ships next to the compiled server (release/dist → release/public), so its presence on
// disk IS the answer: true for the packaged release, false under
// `pnpm dev`, where there is no sibling public/ dir and Vite serves the UI while proxying /api
// back to this process.
//
// ⚠ SPELLED ONCE, ON PURPOSE. app.ts used to compute this inline; two copies of an existsSync
// against a hand-written relative path is exactly the "TWO SPELLINGS MUST AGREE" hazard, and the
// failure mode if they ever drifted is silent — a deep link that 404s, or a static root that
// never registers.
// ---- Where git clones live ----
//
// The shared, LRU-evicted, credential-free clone cache (review/clone-manager.ts) lives under the
// user's home, so a clone survives a restart and a cold re-clone of a large repository (measured
// 3.6s to 13.7s) is paid once. CLONE_DIR overrides it.
function defaultCloneDir(): string {
  return join(resolveDataDir(), 'clones');
}

export const spaPublicDir = resolve(backendRoot, 'public');
export const serverServesSpa = existsSync(resolve(spaPublicDir, 'index.html'));

// The browser-facing base for deep links. See `appWebUrl` on the config object for the full
// contract; this is the resolution it names.
function resolveAppWebUrl(): string {
  const explicit = process.env.APP_WEB_URL?.trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const apiOrigin =
    process.env.APP_BASE_URL?.replace(/\/$/, '') ??
    `http://localhost:${intFromEnv('PORT', 4000)}`;
  if (serverServesSpa) return apiOrigin;
  // Nothing here serves the SPA, so a link to this origin would 404. The dev server does.
  // Its port is `server.port` in apps/frontend/vite.config.ts; FRONTEND_PORT covers the demo
  // stack (:5273) and anyone who moved it.
  return `http://localhost:${intFromEnv('FRONTEND_PORT', 5173)}`;
}

// Chronology's working hours need a time zone before anyone has set one for a workspace. The
// machine's own zone is the honest answer (it is the reader's). WORK_TIMEZONE overrides it. An unrecognised value falls back rather than throwing at boot.
function resolveDefaultWorkTimezone(): string {
  const valid = (tz: string | undefined): tz is string => {
    if (!tz) return false;
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  };
  const explicit = process.env.WORK_TIMEZONE?.trim();
  if (valid(explicit)) return explicit;
  const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return valid(machine) ? machine : 'UTC';
}

export const config = {
  // ---- Lean storage (both modes by default) ----
  // When false (the default), sync does NOT persist bulky user-authored text —
  // comment / review / PR bodies, review-comment diff hunks, commit messages, and
  // the per-job checkRuns JSON (the ci_status summary enum is kept). That text is
  // regenerable from GitHub, so it's the dominant storage cost; it's hydrated on
  // demand when a PR/thread is opened (sync/hydrate-detail.ts, via the gh-CLI token)
  // and cached in the browser. Not storing it also shrinks the DB and the
  // sync payload, speeding up an initial backfill. Set PERSIST_BODIES=true to store
  // full bodies instead — instant, fully-offline detail at the cost of a larger DB
  // (e.g. a local instance used without network).
  persistBodies: process.env.PERSIST_BODIES === 'true',
  port: intFromEnv('PORT', 4000),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath,
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
  // faster than the hot bucket (syncHotIntervalSec, 20s) or the due-check can never grant
  // it, so adaptive defaults the tick to every TEN SECONDS (node-cron's six-field form) and
  // lets isDue() decide what actually syncs. A tick that 304s costs no rate limit, and a tick
  // never starts while the previous one is still running (sync-manager.ts). Non-adaptive keeps
  // the classic fixed */5 re-walk. An explicit SYNC_CRON always wins.
  syncCron: process.env.SYNC_CRON ?? (syncAdaptive ? '*/10 * * * * *' : '*/5 * * * *'),
  syncOverlapMinutes: intFromEnv('SYNC_OVERLAP_MINUTES', 20),
  // The time zone Chronology counts working hours in for a workspace that never set one
  // (packages/shared/src/flow-settings.ts). See resolveDefaultWorkTimezone.
  defaultWorkTimezone: resolveDefaultWorkTimezone(),
  // Phase 0 real-time sync (see docs/REALTIME-SYNC.md). enqueuePrSync coalesces a burst
  // of change signals for the SAME PR — a push emits push + synchronize + check_run
  // within seconds — into ONE targeted syncOnePr fired this many ms after the burst
  // settles. WEBHOOK_DEBOUNCE_MS overrides (the name is historical).
  webhookDebounceMs: intFromEnv('WEBHOOK_DEBOUNCE_MS', 4000),

  // Resolved above (default ON). When on, the scheduler's per-repo pass
  // becomes adaptive: the tick runs every ten seconds but a repo only syncs when it's DUE for
  // its activity bucket, and — for incremental syncs — a cheap conditional REST probe runs
  // first, skipping the fat GraphQL walk when nothing changed (a 304 costs no rate limit).
  syncAdaptive,
  // Per-bucket minimum seconds between sync attempts (a free 304 probe unless something
  // changed). A repo is "hot" when a PR changed within the last hour, "warm" within 6h, else
  // "cold" (windows are constants in sync/adaptive.ts). Fresher where activity is.
  syncHotIntervalSec: intFromEnv('SYNC_HOT_INTERVAL_SEC', 20),
  syncWarmIntervalSec: intFromEnv('SYNC_WARM_INTERVAL_SEC', 60),
  syncColdIntervalSec: intFromEnv('SYNC_COLD_INTERVAL_SEC', 300),
  // THE WALK CAP: a probe's 200 marks a repo dirty, and the scheduler walks a dirty repo at most
  // once per this many seconds (as soon as the cap allows — the change is never lost). Manual
  // sync, the first-sync two-phase, backfills and the viewed-PR refresh are not capped.
  syncMinWalkIntervalSec: intFromEnv('SYNC_MIN_WALK_INTERVAL_SEC', 60),
  // THE INSURANCE WALK: force a full incremental walk at least this often even when the probe
  // says "unchanged" (default 3h). It uses the same `since` window, so it does NOT catch
  // updatedAt-silent changes — the settle sweep below does. SYNC_FLOOR_INTERVAL_SEC (the name is
  // historical; it was the 30-minute re-walk floor).
  syncFloorIntervalSec: intFromEnv('SYNC_FLOOR_INTERVAL_SEC', 3 * 60 * 60),
  // THE SETTLE SWEEP (sync/settle-sweep.ts): one aliased ~1-point-per-repo GraphQL read of every
  // open PR's head, CI rollup and unresolved-thread count, compared with the stored rows; only
  // PRs that differ are re-synced. Every SYNC_SETTLE_INTERVAL_SEC for hot and warm repos,
  // SYNC_SETTLE_COLD_INTERVAL_SEC for cold ones; at most SYNC_SETTLE_MAX_PR_SYNCS single-PR
  // syncs per sweep (the rest wait for the next one).
  syncSettleIntervalSec: intFromEnv('SYNC_SETTLE_INTERVAL_SEC', 5 * 60),
  syncSettleColdIntervalSec: intFromEnv('SYNC_SETTLE_COLD_INTERVAL_SEC', 15 * 60),
  syncSettleMaxPrSyncs: intFromEnv('SYNC_SETTLE_MAX_PR_SYNCS', 20),
  stallThresholdDays: intFromEnv('STALL_THRESHOLD_DAYS', 3),
  // ---- Retention / TTL ----
  // Per-account server data doesn't grow forever: a periodic sweep prunes PRs (and their
  // whole subtree) whose `updatedAt` is older than this many days. 0 disables it. The
  // effective cutoff is clamped to at least `backfillDays`, so a forced full sync (which
  // re-walks `now − backfillDays`) can never re-fetch (resurrect) a just-deleted PR.
  // RETENTION_DAYS overrides.
  retentionDays: intFromEnv('RETENTION_DAYS', 180),
  // When the retention sweep runs (node-cron). Daily at 03:00 by default; off-peak so a
  // large delete doesn't contend with the 5-minute sync. RETENTION_CRON overrides.
  retentionCron: process.env.RETENTION_CRON ?? '0 3 * * *',
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
  // Local dev points it at the sibling repo's port.
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
  // LOCAL SCORING (docs/ML-NODE-PORT.md): the same model, run in this process's own worker thread
  // by onnxruntime-node — no Python, no second process. On by default locally (it still needs its
  // first-use download, "Set up" in the app).
  // LIMN_ML_DISABLED=true turns it off. LIMN_ML_SCORER picks the scorer: `auto` (the default:
  // local when it is set up, else the HTTP service above when configured), `local` or `http`.
  mlLocalEnabled: process.env.LIMN_ML_DISABLED !== 'true',
  mlScorer: (['local', 'http'] as const).find((v) => v === process.env.LIMN_ML_SCORER) ?? ('auto' as const),
  // Extra headers for every severity-api call, as a JSON object string — e.g.
  // `SEVERITY_API_HEADERS='{"X-Severity-Token":"…"}'`. Empty by default (a loopback service
  // needs no credential). It
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

  // This server's own origin (no trailing slash). Locally http://localhost:<port>.
  appBaseUrl:
    process.env.APP_BASE_URL?.replace(/\/$/, '') ??
    `http://localhost:${intFromEnv('PORT', 4000)}`,

  // Where a HUMAN'S BROWSER reaches the SPA — the base for deep links we hand to a person
  // (today: the workspace + per-repo links in the Slack digest).
  //
  // ⚠ THIS IS NOT `appBaseUrl` AND THE TWO MUST NOT BE MERGED. They diverge under `pnpm dev`,
  // where this server runs on :4000 and NEVER serves the SPA (see `serverServesSpa` above),
  // while Vite serves it on :5173. A deep link built on `appBaseUrl` 404s there.
  //
  // Resolution, in order:
  //   1. APP_WEB_URL — an explicit override. Always wins.
  //   2. This server serves the SPA itself ⇒ `appBaseUrl` (the packaged release).
  //   3. Otherwise the Vite dev origin, `http://localhost:${FRONTEND_PORT ?? 5173}`.
  appWebUrl: resolveAppWebUrl(),
  // 32-byte (64-hex) key for AES-256-GCM sealing of stored secrets (the tracker and SonarCloud
  // tokens). Optional: without it those tokens are stored plain, like the machine's `gh` token.
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',

  // ---- The agentic features: Claude Review, review memory, AI Fix (CORE, free, LOCAL ONLY) ----
  // ONE switch, and it is NOT an opt-in: they are on and always visible (a missing Claude
  // credential replaces the Run button with one line; it never hides the feature).
  //
  // EVERY model call — agent runs and one-shot completions alike — takes ONE credential ladder
  // (ai/credentials.ts), read at call time:
  //   1. the user's own Claude Code login (default; a `claude` sign-in on disk or
  //      CLAUDE_CODE_OAUTH_TOKEN). Any ANTHROPIC_API_KEY is hidden from the run so the login pays;
  //   2. else ANTHROPIC_API_KEY from the environment.
  // LIMN_AI_USE_API_KEY=true — prefer ANTHROPIC_API_KEY over the login when both exist.
  // LIMN_AI_DISABLED=true is the kill switch for a team that forbids AI tooling — hides every
  // AI surface (`MeResponse.ai.enabled` false), registers no agentic route and refuses every
  // one-shot completion.
  aiEnabled: process.env.LIMN_AI_DISABLED !== 'true',
  // ---- Claude Review — infra knobs ----
  // The routing thresholds, concurrency + queue caps keep their historical PRO_REVIEW_* env names.
  // Partial clones + ephemeral worktrees live here (a user-writable home path,
  // never the read-only install dir). CLONE_DIR overrides.
  cloneDir: process.env.CLONE_DIR ?? defaultCloneDir(),
  // The local data directory: `~/.limn` (LIMN_DATA_DIR overrides). Holds the installed CLI's
  // database, the clone cache, config.json and the AI runtime downloaded on first use. An existing
  // `~/.pierre-review` (the pre-rename name) is moved here ONCE on first boot — data-dir.ts.
  dataDir: resolveDataDir(),
  // Soft cap on the clone cache before LRU cleanup evicts idle repos (2 GiB).
  cloneCacheMaxBytes: intFromEnv('CLONE_CACHE_MAX_BYTES', 2 * 1024 * 1024 * 1024),

  // ---- Merge conflict resolver ----
  // Bounds on ONE resolver session. Every one of these is a REFUSAL boundary, not a
  // truncation: past the cap the file is listed as unsupported with a reason, never
  // silently shortened. A shortened file would commit bytes nobody saw.
  conflictMaxFiles: intFromEnv('CONFLICT_MAX_FILES', 40),
  conflictMaxFileBytes: intFromEnv('CONFLICT_MAX_FILE_BYTES', 512 * 1024),
  // ⚠ Must stay < 127: `git merge-file` reports the conflict count in its EXIT STATUS,
  // which saturates there.
  conflictMaxRegions: intFromEnv('CONFLICT_MAX_REGIONS', 120),
  conflictMaxTotalBytes: intFromEnv('CONFLICT_MAX_TOTAL_BYTES', 8 * 1024 * 1024),
  // Myers diff `d` ceilings. Past these the diff degrades to a single whole-file conflict
  // region rather than running quadratically on a pathological pair.
  conflictDiffMaxD: intFromEnv('CONFLICT_DIFF_MAX_D', 4000),
  conflictWordDiffMaxD: intFromEnv('CONFLICT_WORD_DIFF_MAX_D', 2000),
  conflictWordTokenCap: intFromEnv('CONFLICT_WORD_TOKEN_CAP', 20_000),
  conflictPrefetchMaxBlobs: intFromEnv('CONFLICT_PREFETCH_MAX_BLOBS', 2000),
  conflictModelTimeoutMs: intFromEnv('CONFLICT_MODEL_TIMEOUT_MS', 45_000),
  conflictSessionTtlMs: intFromEnv('CONFLICT_SESSION_TTL_MIN', 30) * 60_000,
  conflictSuggestMaxChars: intFromEnv('CONFLICT_SUGGEST_MAX_CHARS', 4000),
  // A worktree with NO ledger row older than this is an ORPHAN — its run died without its
  // `finally`, or predates the ledger. The worktree sweep removes it, and the LRU may evict its repo
  // despite `.worktrees/` being non-empty. Without this one crashed run pins a repo permanently.
  worktreeTtlMs: intFromEnv('WORKTREE_TTL_HOURS', 6) * 3_600_000,
  cloneSweepMaxMs: intFromEnv('CLONE_SWEEP_MAX_MS', 30_000),
  // ---- The worktree sweep (review/worktree-gc.ts; docs/BACKEND.md § Worktree cleanup) ----
  // A ledgered checkout another live Limn process made is kept until idle this long; one whose
  // maker has exited, whose run ended or whose PR closed goes at the next sweep regardless.
  worktreeIdleMs: intFromEnv('WORKTREE_IDLE_DAYS', 3) * 86_400_000,
  // A checkout holding work the reader may still push is kept until pushed or discarded, or this long.
  worktreePinMaxMs: intFromEnv('WORKTREE_PIN_DAYS', 14) * 86_400_000,
  // A run making a worktree kicks a sweep at most this often; the boot always runs one.
  worktreeSweepMinGapMs: intFromEnv('WORKTREE_SWEEP_MIN_GAP_MIN', 10) * 60_000,
  // One sweep stops looking after this long (it runs in the background; the rest waits for the next).
  worktreeSweepMaxMs: intFromEnv('WORKTREE_SWEEP_MAX_MS', 120_000),
  // ---- The clone-cache janitor (conflict/janitor.ts, scheduled in sync/scheduler.ts) ----
  // The boot sweep runs ONCE; a long-lived process accumulates a session's two fetch refs per
  // resolver opened and never closed, and each ref pins objects the repack cannot drop. This is
  // the same work on a clock. Quarter-hourly is well inside the 30-minute session TTL, so a ref
  // is collected in the same order of time as the session that made it.
  conflictJanitorCron: process.env.CONFLICT_JANITOR_CRON ?? '*/15 * * * *',
  // Loose objects in one clone past which the janitor runs `git gc --prune=now`. Below it, gc
  // is a ~120ms spawn that repacks nothing. 5,000 is git's own `gc.auto` default.
  cloneGcLooseObjects: intFromEnv('CLONE_GC_LOOSE_OBJECTS', 5_000),
  // How long SIGTERM waits for in-flight resolver jobs before closing the server anyway.
  // Matched to the 120s timeout on a single git subprocess (review/clone-manager.ts), which is
  // the longest single step a job can be inside.
  shutdownGraceMs: intFromEnv('SHUTDOWN_GRACE_MS', 120_000),
  // Per-run caps (cost/disk/time runaway guards). The diff is inlined in full, so
  // reviews need far fewer turns than the old default; 30 is still generous.
  reviewMaxTurns: intFromEnv('REVIEW_MAX_TURNS', 30),
  // ⚠ A WORKTREE review has NO turn limit unless REVIEW_MAX_TURNS is set explicitly (then this cap
  // holds); the default 30 still bounds the docs-library diff-only walk (review/agent.ts).
  reviewMaxTurnsPinned: (process.env.REVIEW_MAX_TURNS ?? '') !== '',
  // Hard USD ceiling per run. When the SDK trips this it returns an
  // `error_max_budget_usd` result BEFORE the agent calls submit_review — so a run
  // that hits the cap is recorded FAILED and still bills (you pay for no review).
  // The cap must therefore sit ABOVE the cost of a normal completed review, not at
  // it; the effort (ai/effort.ts) is the real cost lever (a large diff at default-high
  // effort is what blew the old $1 cap). Lower REVIEW_BUDGET_USD only if you'd
  // rather a borderline review fail than complete. It is the WHOLE limit for one run,
  // deep-review specialists included (up to CLAUDE_REVIEW_MAX_SPECIALISTS, each on the review's
  // model) — there is no per-user override and no route that sets it.
  reviewBudgetUsd: floatFromEnv('REVIEW_BUDGET_USD', 6.75),
  // Turn cap for a diff-only run. These are TOOL-LESS (only submit_review), so they
  // should finish in ~2 turns; a tight cap is a cheap runaway guard.
  reviewDiffOnlyMaxTurns: intFromEnv('REVIEW_DIFF_ONLY_MAX_TURNS', 6),
  // ---- Claude Review chat (one answered question about a finished review) ----
  // Each answer is its own agent run over the whole review + diff, so it gets its OWN small spend
  // cap rather than the review's. Turn caps are low on purpose: a worktree answer may look up a
  // few files (Read/Glob/Grep), a diff-only answer has no tools and needs one reply.
  reviewChatBudgetUsd: floatFromEnv('REVIEW_CHAT_BUDGET_USD', 1),
  reviewChatMaxTurns: intFromEnv('REVIEW_CHAT_MAX_TURNS', 8),
  reviewChatDiffOnlyMaxTurns: intFromEnv('REVIEW_CHAT_DIFF_ONLY_MAX_TURNS', 2),
  // ---- Ticket review (one run per TICKET, across every PR on it — review/ticket-review/) ----
  // Its OWN spend cap, separate from REVIEW_BUDGET_USD: a ticket run reads several repositories but
  // has no specialists. Env only — no route sets it. The turn cap bounds the exploration across
  // every member's worktree.
  ticketReviewBudgetUsd: floatFromEnv('TICKET_REVIEW_BUDGET_USD', 4),
  ticketReviewMaxTurns: intFromEnv('TICKET_REVIEW_MAX_TURNS', 40),
  // The per-card spend cap of the ticket review's CARD PRE-PASS (Sonnet 5, diff-only, one tool —
  // review/ticket-review/prepass.ts). Its spend is added to the ticket run's cost. Env only.
  ticketCardBudgetUsd: floatFromEnv('TICKET_CARD_BUDGET_USD', 0.4),
  // AUTOMATIC ticket reviews (trigger 'auto' / 'cascade') per workspace per UTC day. Not shared with
  // the PR review's own auto cap. Manual runs never count. Default = shared TICKET_REVIEW_DAILY_CAP.
  ticketReviewDailyCap: intFromEnv('TICKET_REVIEW_DAILY_CAP', 20),
  // Automatic re-checks of ONE ticket that only follow pushes, per UTC day (review/ticket-review/sweep.ts).
  // A PR joining, leaving or merging, or the story changing, is not limited by it.
  ticketReviewPushRechecksPerDay: intFromEnv('TICKET_REVIEW_PUSH_RECHECKS_PER_DAY', 3),
  // ---- CI review (one run per (PR, head, failing-check set) — review/ci-review/) ----
  // Its OWN spend cap and turn cap: a CI run reads log excerpts and the files they point at, nothing
  // more. Env only — no route sets it.
  ciReviewBudgetUsd: floatFromEnv('CI_REVIEW_BUDGET_USD', 2),
  ciReviewMaxTurns: intFromEnv('CI_REVIEW_MAX_TURNS', 25),
  // AUTOMATIC CI reviews per workspace per UTC day. Not shared with the PR or ticket review caps.
  // Manual runs never count. Default = shared CI_REVIEW_DAILY_CAP.
  ciReviewDailyCap: intFromEnv('CI_REVIEW_DAILY_CAP', 20),
  // ---- Check threads (a light, threads-only pass — review/claude-review/thread-check.ts) ----
  // Its OWN spend and turn caps (Sonnet 5, read-only). Env only — no route sets them.
  threadCheckBudgetUsd: floatFromEnv('THREAD_CHECK_BUDGET_USD', 1),
  threadCheckMaxTurns: intFromEnv('THREAD_CHECK_MAX_TURNS', 20),
  // AUTOMATIC checks per workspace per UTC day. Not shared with any review's cap; clicks never count.
  threadCheckDailyCap: intFromEnv('THREAD_CHECK_DAILY_CAP', 30),
  // ---- Sequence diagrams (one Sonnet 5 run per PR head / per ticket's member set —
  // review/diagrams/, docs/CLAUDE-REVIEW.md § Design diagrams) ----
  // Its OWN spend and turn caps. Env only — no route sets them.
  sequenceDiagramBudgetUsd: floatFromEnv('SEQUENCE_DIAGRAM_BUDGET_USD', 1.5),
  sequenceDiagramMaxTurns: intFromEnv('SEQUENCE_DIAGRAM_MAX_TURNS', 30),
  // Diagrams STARTED BY A FINISHED REVIEW per account per UTC day (PR + story together). A Redraw
  // click never counts. Not shared with any review's cap.
  sequenceDiagramDailyCap: intFromEnv('SEQUENCE_DIAGRAM_DAILY_CAP', 30),
  // ---- Reference docs (the per-workspace library — reference-docs/, docs/REFERENCE-DOCS.md) ----
  // Where the markdown tree lives: `<docsDir>/<accountId>/<workspaceId>/library/` (+ `sources/`).
  // LIMN_DOCS_DIR overrides. Default: ONE ROOT PER DATABASE (data-dir.ts `defaultDocsDir`) —
  // `<dataDir>/docs` for the data directory's own DB, `<dataDir>/docs/db-<hash>` for any other.
  docsDir: process.env.LIMN_DOCS_DIR?.trim() || defaultDocsDir(dbPath, resolveDataDir()),
  // The root every database shared before the split: a DB with another root moves its own
  // workspace folders out of it ONCE (reference-docs/owner.ts `migrateLegacyDocs`). Never when
  // LIMN_DOCS_DIR is set — the user chose where the library lives.
  legacyDocsDir: process.env.LIMN_DOCS_DIR?.trim() ? null : join(resolveDataDir(), 'docs'),
  // One Sonnet 5 build per document: its OWN spend and turn caps (a long PDF is read in 20-page
  // slices and written out section by section). Env only — no route sets them.
  docsBuildBudgetUsd: floatFromEnv('DOCS_BUILD_BUDGET_USD', 6),
  docsBuildMaxTurns: intFromEnv('DOCS_BUILD_MAX_TURNS', 250),
  // A PDF longer than this is refused before any model runs (when its page count can be read).
  docsPdfMaxPages: intFromEnv('DOCS_PDF_MAX_PAGES', 300),
  // One docs-chat answer (Sonnet 5, read-only over the library).
  docsChatBudgetUsd: floatFromEnv('DOCS_CHAT_BUDGET_USD', 1),
  docsChatMaxTurns: intFromEnv('DOCS_CHAT_MAX_TURNS', 30),
  // "Check against docs" on a story (review/story-docs/, docs/REFERENCE-DOCS.md § Check a story
  // against the docs): a Haiku shortlist, then ONE Sonnet 5 read of only those documents. Every run is
  // a click, so every run counts toward the daily cap (per account, per UTC day). Env only.
  storyDocsDailyCap: intFromEnv('STORY_DOCS_ALIGNMENT_DAILY_CAP', 30),
  storyDocsBudgetUsd: floatFromEnv('STORY_DOCS_ALIGNMENT_BUDGET_USD', 1.5),
  storyDocsMaxTurns: intFromEnv('STORY_DOCS_ALIGNMENT_MAX_TURNS', 16),
  // ---- Story labels (the label run — review/story-labels/) ----
  // The per-RUN spending cap (US$). Default = shared STORY_LABEL_BUDGET_USD_DEFAULT (1). Env only.
  storyLabelBudgetUsd: floatFromEnv('STORY_LABEL_BUDGET_USD', 1),
  // ---- Sprint briefs (Activity → This Sprint, the graph — review/sprint-briefs/) ----
  // The per-PASS spending cap (US$) of the Haiku brief pass after each sprint read. Env only.
  sprintBriefBudgetUsd: floatFromEnv('SPRINT_BRIEF_BUDGET_USD', 1),
  // ---- The sprint builder (Activity → This Sprint, critical paths — review/sprint-paths/) ----
  // One agentic Sonnet 5 pass after the theme pass. Its OWN spend and turn caps, and the passes per
  // workspace per UTC day (a pass runs only when its input hash moved; this bounds a flapping one).
  // Env only — no route sets them.
  sprintPathsBudgetUsd: floatFromEnv('SPRINT_PATHS_BUDGET_USD', SPRINT_PATHS_BUDGET_USD_DEFAULT),
  sprintPathsMaxTurns: intFromEnv('SPRINT_PATHS_MAX_TURNS', SPRINT_PATHS_MAX_TURNS_DEFAULT),
  sprintPathsDailyCap: intFromEnv('SPRINT_PATHS_DAILY_CAP', SPRINT_PATHS_DAILY_CAP_DEFAULT),

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
  // Agent `effort` — the dominant cost knob — is NOT read here: REVIEW_EFFORT (the level; it wins over
  // Settings → AI → Effort) and REVIEW_DIFF_ONLY_EFFORT (every diff-only review) are read at run time by
  // ai/effort.ts, the one resolver. Both reach only the review, AI Fix and Plan first.
  // (Review concurrency + queue caps + the routing thresholds moved to the plugin's
  // PRO_REVIEW_* env — the plugin owns the queue/manager + the mode-routing decision.)

  // ---- AI Fix (Pro: agentic code fixer) — core infra knobs ----
  // The write-capable fixer (packages/pro/ai-fix) reuses the review clone/agent
  // machinery. A runaway fixer is pricier than a review (it edits + re-reads files),
  // so the caps are a touch higher on turns but the USD ceiling is the real guard.
  // Concurrency is 1: the fixer relies on ambient Claude auth WITHOUT mutating
  // process.env (which would race the review manager), so only one fix runs at once.
  aiFixMaxTurns: intFromEnv('AI_FIX_MAX_TURNS', 40),
  aiFixBudgetUsd: floatFromEnv('AI_FIX_BUDGET_USD', 5),
  aiFixConcurrency: intFromEnv('AI_FIX_CONCURRENCY', 1),
  // Refuse a fix whose captured patch exceeds this (a runaway diff shouldn't bloat a
  // DB row). ~1 MiB of unified diff is already a very large change.
  aiFixPatchMaxBytes: intFromEnv('AI_FIX_PATCH_MAX_BYTES', 1024 * 1024),
  // AI Fix "Run tests" (coding/checks/; docs/SECURITY.md § Sandboxed checks). A check runs ONLY inside
  // an OS sandbox (macOS sandbox-exec, Linux bubblewrap); with neither, tests are refused unless the
  // reader sets LIMN_CHECKS_ALLOW_UNSANDBOXED=true — then they run without one, and the run says so.
  checksAllowUnsandboxed: process.env.LIMN_CHECKS_ALLOW_UNSANDBOXED === 'true',
  // The longest one check may run (the agent's and Limn's own run alike).
  aiFixCheckTimeoutMs: intFromEnv('AI_FIX_CHECK_TIMEOUT_MS', 10 * 60_000),
  // Cap the continue/skip loop of CORE "Update branch from trunk"'s rebase
  // (coding/merge.ts): a stop with no conflicted file (a commit that became empty) is
  // continued or skipped up to this many times, then the rebase is aborted rather than
  // looping forever on a pathological history. Any real conflict aborts at once. The
  // AI_FIX_ name is historical — it once also bounded AI Fix's (removed) resolver.
  aiFixRebaseMaxSteps: intFromEnv('AI_FIX_REBASE_MAX_STEPS', 10),
} as const;

export type Config = typeof config;
