// Background ML enrichment of BOT-authored text (CORE, free tier, no LLM, no GitHub quota).
//
// WHY THIS IS A WORKER AND NOT A SYNC STEP — the load-time answer, measured rather than
// assumed. The severity model is int8 ModernBERT on CPU and its cost tracks TOTAL TEXT, not
// item count: on an Intel i9, 32 short bot comments classify in 2.7s while 32 long ones take
// 28.4s (a batch pads to its longest member, and the model truncates at 512 tokens). A real
// account's bot corpus here is ~17.5k items ≈ 7M chars — over an hour of inference locally,
// perhaps 15–25 min on the deployed service. Anything on that scale inside `persistPr`'s
// transaction would hold the single better-sqlite3 write lock open across network latency
// (db/client.ts's runTransaction states that invariant explicitly), and anything inside the
// per-PR sync loop would serialise the whole walk behind it. So: sync writes GitHub data at
// full speed, and this drains the backlog behind it.
//
// IT IS A PULL, NOT A PUSH. Nothing enqueues; each tick re-derives "bot-authored text with no
// label yet" from the database. Three consequences worth having:
//   • webhook-delivered and just-posted comments need no hook of their own — they are simply
//     the newest unlabelled rows, picked up within a tick,
//   • a bot classified LATER (workspace_reviewers rows are written lazily, on a read of the
//     Bots tab — never by sync) brings its whole backlog with it on the next tick,
//   • a restart loses nothing: there is no in-memory queue to drop.
/** The subset of a logger this worker uses — pino (app.log) and sync-repo's minimal
 * Logger both satisfy it structurally, so any sync path can kick a tick. */
export interface MlLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}
import { createHash } from 'node:crypto';
import { gte } from 'drizzle-orm';
import type { MlCategory, MlSeverity } from '@pierre-review/shared';
import { config } from '../config.js';
import { db, schema } from '../db/client.js';
import {
  listMlCandidates,
  upsertMlLabels,
  type MlCandidate,
  type MlLabelWrite,
} from '../db/ml-labels.js';
import {
  classificationKindForUser,
  listWorkspaces,
  type BotScope,
} from '../db/queries.js';
import {
  isSeverityApiConfigured,
  scoreComments,
  severityApiAnswered,
  severityHealth,
  type SeverityRequestItem,
  type SeverityResult,
} from '../ml/severity-client.js';

const { accounts } = schema;

export const ML_ENRICHMENT_CRON_FALLBACK = '*/2 * * * *';

// Re-entrancy guard. A tick has a wall-clock budget below its cron period, so overlap should
// not happen — but a slow cold start (the service loads a ~150 MB model on first request) can
// blow through one period, and two ticks racing would send the same batch twice.
let running = false;

// Consecutive whole-tick failures before the worker backs off. The service being down is the
// expected failure (local dev without the sibling repo running), and retrying it every two
// minutes forever just fills the log.
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_MS = 10 * 60_000;
let consecutiveFailures = 0;
let backoffUntil = 0;

// Where the next tick starts in the account list — see the rotation note in the tick.
let rotationCursor = 0;

// Logged once per process so a marker-fallback deployment is visible in the boot log rather
// than only in the `backend` string on rows nobody reads.
let healthLogged = false;

// ---- Live run state: what the sync UI polls (GET /api/ml-status) ----
//
// WHY THIS EXISTS. The enrichment pass used to be structurally invisible to every sync
// surface. `runSyncForRepo`'s `finally` cleared the repo's progress and THEN kicked a tick, so
// the UI was told "sync complete" at the exact instant the model calls began — an indicator
// downstream of "done" can never represent them. Two things fix that: sync-manager now kicks
// the tick BEFORE it clears progress (the guards below run synchronously, so `running` is true
// by the time that function returns), and these fields let the client keep showing the scoring
// phase until the labels the board renders actually exist.
//
// All process-local, like the sync manager's own progress map: a restart loses only a readout.
let runStartedAt: number | null = null;
let runLabelled = 0;
let runBatches = 0;
let runFailures = 0;
let lastFinishedAt: number | null = null;
let lastError: string | null = null;
// null until a /health probe has answered at all; false = it did not answer (the normal state
// of a dev machine without the sibling repo running), true = it did. The UI must NOT claim a
// scoring phase is in progress against a service that is not there.
let serviceHealthy: boolean | null = null;
// True when the last answered probe reported the MARKER FALLBACK rather than the ONNX model.
let markerFallback = false;

/** Live state of the worker. Mirrors the tick's counters as they increment, not on completion. */
export interface MlEnrichmentState {
  running: boolean;
  startedAt: number | null;
  labelled: number;
  batches: number;
  failures: number;
  finishedAt: number | null;
  lastError: string | null;
  /** Epoch ms until which the worker is backed off after repeated failures, else null. */
  pausedUntil: number | null;
  serviceHealthy: boolean | null;
  markerFallback: boolean;
}

export function getMlEnrichmentState(): MlEnrichmentState {
  return {
    running,
    startedAt: runStartedAt,
    labelled: runLabelled,
    batches: runBatches,
    failures: runFailures,
    finishedAt: lastFinishedAt,
    lastError,
    pausedUntil: backoffUntil > Date.now() ? backoffUntil : null,
    serviceHealthy,
    markerFallback,
  };
}

/**
 * Publish the in-flight tick's counters so a poll mid-tick sees progress rather than a step
 * function at the end. Called from inside the concurrency workers, which is safe: assigning two
 * numbers cannot throw, and the landmine those workers guard against is a THROW escaping into
 * the shared `Promise.all`.
 */
function publishProgress(stats: TickStats): void {
  runLabelled = stats.labelled;
  runBatches = stats.batches;
  runFailures = stats.failures;
}

/** Only the 16 real vendor names are a useful hint to the service's marker parser. */
function vendorHint(kind: string | null | undefined): string | null {
  if (!kind) return null;
  if (kind === 'in_house' || kind === 'pierre' || kind === 'vendor') return null;
  return kind;
}

function hashBody(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const SEVERITY_WORD_TO_WIRE: Record<string, MlSeverity> = {
  NIT: 'nit',
  MINOR: 'minor',
  MAJOR: 'major',
  CRITICAL: 'critical',
};

/**
 * Pack candidates into batches bounded by BOTH a character budget and an item count.
 *
 * The character budget is the one that matters. Inference pads every item in a batch out to
 * the longest one, so a single 6k-char walkthrough dropped into a batch of 128 short comments
 * makes all 128 cost like the walkthrough. Callers therefore hand this a LENGTH-SORTED list,
 * which keeps each batch internally uniform and turns the padding waste into near-nothing.
 */
export function packBatches(
  items: MlCandidate[],
  maxItems: number,
  maxChars: number,
): MlCandidate[][] {
  const batches: MlCandidate[][] = [];
  let current: MlCandidate[] = [];
  let chars = 0;
  for (const item of items) {
    // Budget by what is actually SENT — body + diff hunk + path — or diff-carrying batches
    // would blow past maxChars while looking body-thin.
    const len = item.body.length + (item.diffHunk?.length ?? 0) + (item.path?.length ?? 0);
    // A single item longer than the whole budget still has to go somewhere: give it its own
    // batch rather than silently dropping it (the service truncates at 512 tokens anyway).
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Truncate to `max` UTF-16 code units WITHOUT splitting a surrogate pair.
 *
 * `String.prototype.slice` counts code units, so cutting a string mid-astral-character leaves
 * the orphaned first half behind — a lone surrogate, which is the one thing UTF-8 cannot
 * encode. `JSON.stringify` happily emits it as a bare `\ud83d` escape, so it travels fine on
 * the wire and detonates at the far end: the severity-api's tokenizer raised `TypeError` and
 * returned 500 for the WHOLE batch, and since the candidate query is "rows with no label yet",
 * the same comment came back every tick forever. One 10k-char comment whose 6000th code unit
 * landed inside a 💡 pinned an entire workspace's backlog indefinitely.
 *
 * The service now sanitises its own input, so this is no longer load-bearing — but emitting
 * text we know to be malformed is still wrong: the orphan is silently dropped over there, so
 * the model reads one character less than we believe we sent.
 *
 * Only surrogate PAIRS are protected. Splitting a grapheme cluster (a combining accent, a ZWJ
 * emoji sequence) still happens and is fine: the result is well-formed UTF-8, which is the
 * property that matters. Chasing grapheme boundaries would need `Intl.Segmenter` per item for
 * a cosmetic gain the model never sees — it truncates at 512 tokens regardless.
 */
export function truncateOnCodePoint(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  // A HIGH surrogate at the last kept position means its partner is the first dropped one —
  // step back and take neither. A LOW surrogate there is the tail of a complete pair, so the
  // cut is already clean.
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

const SEVERITY_BY_ORD: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];

function toWrite(
  accountId: number,
  candidate: MlCandidate,
  result: SeverityResult,
  modelVersion: string,
  sentBody: string,
): MlLabelWrite {
  // A word outside the service's documented four would be a contract break, but DROPPING the
  // row is the one thing we must not do: an unwritten target is re-selected on every tick
  // forever, so a single bad word turns into the same batch being re-POSTed every two minutes
  // for the life of the deployment. Fall back to the numeric ordinal (clamped), which always
  // yields a storable value and terminates.
  const severity =
    SEVERITY_WORD_TO_WIRE[result.severity] ??
    SEVERITY_BY_ORD[Math.min(3, Math.max(0, Math.trunc(result.severityOrd)))] ??
    'nit';
  return {
    accountId,
    repoId: candidate.repoId,
    prId: candidate.prId,
    targetKind: candidate.targetKind,
    targetId: candidate.targetId,
    authorUserId: candidate.authorUserId,
    severity,
    severityOrd: result.severityOrd,
    severityProb: result.severityProb,
    // Carried through UNCHANGED and never consulted above: the vendor's own claim is stored to
    // be shown BESIDE our severity, not to influence it (it is the less accurate of the two —
    // 0.474 exact / 0.697 ordinal MAE vs our 0.700 / 0.303 on `gold_v2_sample`). Already
    // validated against the severity/confidence unions by the client, which nulls anything it
    // does not recognise — including the whole field on a service too old to send it.
    vendorSeverity: result.vendorSeverity,
    vendorSeverityConfidence: result.vendorSeverityConfidence,
    categories: result.category as MlCategory[],
    categoryProbs: result.categoryProbs,
    isSummary: result.isSummary,
    backend: result.backend,
    modelVersion,
    // Hash what we ACTUALLY SENT (trimmed + capped), not the stored body — otherwise the hash
    // answers a question ("would this text score the same?") that the stored value can't.
    bodyHash: hashBody(sentBody),
    targetCreatedAt: candidate.targetCreatedAt,
  };
}

/** Which accounts are worth working on this tick. Mirrors the sync loop's activity gate. */
async function activeAccountIds(): Promise<number[]> {
  const rows = config.isCloud
    ? await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          gte(
            accounts.lastActiveAt,
            new Date(Date.now() - config.syncActiveWindowMinutes * 60_000),
          ),
        )
        .execute()
    : await db.select({ id: accounts.id }).from(accounts).execute();
  return rows.map((r) => r.id);
}

interface TickStats {
  labelled: number;
  batches: number;
  failures: number;
}

/**
 * One enrichment pass. Never throws — a failure here must not be able to take down the cron.
 *
 * Bounded by `config.mlTickBudgetMs` of wall clock, checked between batches, so a tick cannot
 * run into the next one no matter how large the backlog or how slow the service.
 */
export async function runMlEnrichmentTick(log: MlLog): Promise<TickStats> {
  const stats: TickStats = { labelled: 0, batches: 0, failures: 0 };
  // ⚠ These three guards and the `running = true` below MUST stay before the first `await`.
  // sync-manager kicks a tick from `runSyncForRepo`'s `finally` and relies on `running` being
  // true by the time `void runMlEnrichmentTick(log)` returns, so that there is no instant where
  // a client can observe every repo idle AND no scoring in flight. Introducing an await above
  // this line reopens the gap the sync indicator exists to close.
  if (!isSeverityApiConfigured()) return stats;
  if (running) return stats;
  if (Date.now() < backoffUntil) return stats;
  running = true;
  runStartedAt = Date.now();
  runLabelled = 0;
  runBatches = 0;
  runFailures = 0;
  lastError = null;
  const deadline = Date.now() + config.mlTickBudgetMs;

  try {
    if (!healthLogged) {
      const health = await severityHealth();
      // Only CONSUME the once-per-process flag when the service actually answered. Setting it
      // before the await meant a service that was merely slow to start (a ~150 MB model loads on
      // first request) burned the single probe on a failure, and a marker-fallback deployment
      // that came up a minute later was never reported.
      healthLogged = health !== null;
      // Recorded for the status readout as well as the log: a client must not be shown a
      // "scoring bot comments…" phase against a service that never answered.
      serviceHealthy = health !== null;
      markerFallback = health !== null && !health.taxonomyLoaded;
      if (!health) {
        log.warn(
          `ml enrichment: severity-api at ${config.severityApiUrl} did not answer /health; will retry`,
        );
      } else if (!health.taxonomyLoaded) {
        log.warn(
          'ml enrichment: severity-api is serving the MARKER FALLBACK, not the ONNX model ' +
            '(models_loaded.taxonomy=false) — labels will be lower quality. See docs/ML-SEVERITY.md.',
        );
      } else {
        log.info(`ml enrichment: severity-api ready at ${config.severityApiUrl}`);
      }
    }

    // ROTATE THE STARTING POINT. A tick has a wall-clock budget and each workspace can consume
    // a whole pool of it, so a fixed account order means account 1's workspaces are always
    // served first and a busy tenant at the front starves everyone behind it INDEFINITELY —
    // not just this tick, every tick. The cursor is process-local (a restart resets it, which
    // is harmless) and mirrors the auto-merge runner's least-recently-checked rotation.
    const accountIds = await activeAccountIds();
    if (accountIds.length > 0) rotationCursor %= accountIds.length;
    const rotated = [
      ...accountIds.slice(rotationCursor),
      ...accountIds.slice(0, rotationCursor),
    ];
    rotationCursor = accountIds.length > 0 ? (rotationCursor + 1) % accountIds.length : 0;

    for (const accountId of rotated) {
      if (Date.now() >= deadline) break;
      // Every workspace, because a repo lives in exactly one and the bot verdict is per
      // workspace: the same login can be a bot in one and a person in another.
      for (const workspace of await listWorkspaces(accountId)) {
        if (Date.now() >= deadline) break;
        const scope: BotScope = {
          workspaceId: workspace.id,
          repoIds: workspace.repoIds,
        };
        if (scope.repoIds.length === 0) continue;

        const done = await enrichWorkspace(accountId, scope, deadline, log, stats);
        // `done` false means the pool was full — there is more backlog in this workspace, but
        // the budget decides when to come back to it, not a loop here.
        if (!done && Date.now() >= deadline) break;
      }
    }

    if (stats.failures === 0) consecutiveFailures = 0;
    if (stats.labelled > 0) {
      log.info(
        `ml enrichment: labelled ${stats.labelled} bot comments in ${stats.batches} batch(es)`,
      );
    }
  } catch (err) {
    // A tick failing is expected when the service is down; it must never be fatal.
    stats.failures += 1;
    lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    log.warn(`ml enrichment tick failed: ${lastError}`);
  } finally {
    running = false;
    runStartedAt = null;
    lastFinishedAt = Date.now();
    publishProgress(stats);
    if (stats.failures > 0) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        backoffUntil = Date.now() + BACKOFF_MS;
        consecutiveFailures = 0;
        log.warn(
          `ml enrichment: ${MAX_CONSECUTIVE_FAILURES} consecutive failures; pausing for ${
            BACKOFF_MS / 60_000
          } min`,
        );
      }
    }
  }
  return stats;
}

/** @returns true when this workspace's backlog was fully drained within the budget. */
async function enrichWorkspace(
  accountId: number,
  scope: BotScope,
  deadline: number,
  log: MlLog,
  stats: TickStats,
): Promise<boolean> {
  // The pool is sized so one tick's worth of batches can be selected in a single query. It is
  // NOT the batch size: the pool is re-sorted by body length before packing.
  const poolSize = Math.max(config.mlBatchMaxItems, 512);
  const pool = await listMlCandidates(accountId, scope, poolSize);
  if (pool.length === 0) return true;

  const kindMap = await classificationKindForUser(accountId, scope.workspaceId);

  // Cap what we send: the model truncates at 512 tokens (~2.5k chars), so anything past the cap
  // is discarded server-side regardless. Trimming bounds the request payload without changing
  // a single label.
  const trimmed = pool.map((c) => ({
    candidate: c,
    body: truncateOnCodePoint(c.body, config.mlBodyMaxChars),
  }));
  // LENGTH-SORTED so each batch is internally uniform — see packBatches.
  trimmed.sort((a, b) => a.body.length - b.body.length);

  const batches = packBatches(
    trimmed.map((t) => ({ ...t.candidate, body: t.body })),
    config.mlBatchMaxItems,
    config.mlBatchMaxChars,
  );

  const concurrency = Math.max(1, config.mlConcurrency);
  let next = 0;
  let hardFailure = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline || hardFailure) return;
      const index = next++;
      const batch = batches[index];
      if (!batch) return;

      const items: SeverityRequestItem[] = batch.map((c) => ({
        body: c.body,
        vendor: vendorHint(kindMap.get(c.authorUserId)),
        // The v2 model reads `path [SEP] body [SEP] diff`; both are optional and the
        // service degrades gracefully without them. Hunks are capped like bodies — same
        // surrogate-safe cut, since a diff carries emoji as readily as a comment does.
        diffHunk: c.diffHunk ? truncateOnCodePoint(c.diffHunk, config.mlBodyMaxChars) : null,
        path: c.path,
      }));

      let response;
      try {
        response = await scoreComments(items);
        // Direct evidence, and cheaper + fresher than re-probing /health: the once-per-process
        // probe cannot notice a service that dies later, and this readout gates whether the sync
        // UI is allowed to claim a scoring phase at all.
        serviceHealthy = true;
      } catch (err) {
        // A 500 on ONE batch does not mean the service is down — four comments in this repo's
        // own dev database reliably produce one — so only a failure that proves unreachability
        // clears the flag. Whether the tick is making progress is a separate question, answered
        // by `failures`/`labelled` rather than by this.
        serviceHealthy = severityApiAnswered(err);
        stats.failures += 1;
        // One failed batch does not condemn the rest of the tick, but a service that is down
        // fails every batch — so stop this workspace and let the failure counter decide.
        hardFailure = true;
        log.warn(
          `ml enrichment: batch of ${batch.length} failed: ${
            err instanceof Error ? err.message.slice(0, 200) : String(err)
          }`,
        );
        return;
      }

      const writes: MlLabelWrite[] = [];
      for (let i = 0; i < batch.length; i += 1) {
        const candidate = batch[i]!;
        const result = response.results[i]!;
        writes.push(
          toWrite(accountId, candidate, result, response.modelVersion, candidate.body),
        );
      }
      stats.batches += 1;
      publishProgress(stats);
      // ⚠ NOTHING IN THIS LOOP MAY THROW. Two of these run under one `Promise.all`, so a throw
      // rejects the whole thing, propagates past the caller's `finally` (which clears the
      // re-entrancy flag) and leaves the SIBLING worker running detached — still POSTing and
      // still writing, while the next tick believes it is alone.
      try {
        stats.labelled += await upsertMlLabels(writes);
        publishProgress(stats);
      } catch (err) {
        stats.failures += 1;
        hardFailure = true;
        log.warn(
          `ml enrichment: writing ${writes.length} label(s) failed: ${
            err instanceof Error ? err.message.slice(0, 200) : String(err)
          }`,
        );
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return !hardFailure && next >= batches.length && pool.length < poolSize;
}

/** Test seam: reset the process-local backoff/health state between cases. */
export function __resetMlEnrichmentState(): void {
  running = false;
  consecutiveFailures = 0;
  backoffUntil = 0;
  healthLogged = false;
  rotationCursor = 0;
  runStartedAt = null;
  runLabelled = 0;
  runBatches = 0;
  runFailures = 0;
  lastFinishedAt = null;
  lastError = null;
  serviceHealthy = null;
  markerFallback = false;
}
