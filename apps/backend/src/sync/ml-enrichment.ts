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
  if (!isSeverityApiConfigured()) return stats;
  if (running) return stats;
  if (Date.now() < backoffUntil) return stats;
  running = true;
  const deadline = Date.now() + config.mlTickBudgetMs;

  try {
    if (!healthLogged) {
      const health = await severityHealth();
      // Only CONSUME the once-per-process flag when the service actually answered. Setting it
      // before the await meant a service that was merely slow to start (a ~150 MB model loads on
      // first request) burned the single probe on a failure, and a marker-fallback deployment
      // that came up a minute later was never reported.
      healthLogged = health !== null;
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
    log.warn(
      `ml enrichment tick failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
    );
  } finally {
    running = false;
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
    body: c.body.length > config.mlBodyMaxChars ? c.body.slice(0, config.mlBodyMaxChars) : c.body,
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
        // service degrades gracefully without them. Hunks are capped like bodies —
        // the model truncates at 512 tokens regardless.
        diffHunk: c.diffHunk ? c.diffHunk.slice(0, config.mlBodyMaxChars) : null,
        path: c.path,
      }));

      let response;
      try {
        response = await scoreComments(items);
      } catch (err) {
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
      // ⚠ NOTHING IN THIS LOOP MAY THROW. Two of these run under one `Promise.all`, so a throw
      // rejects the whole thing, propagates past the caller's `finally` (which clears the
      // re-entrancy flag) and leaves the SIBLING worker running detached — still POSTing and
      // still writing, while the next tick believes it is alone.
      try {
        stats.labelled += await upsertMlLabels(writes);
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
}
