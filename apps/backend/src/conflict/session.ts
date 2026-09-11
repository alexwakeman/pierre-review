import { randomUUID } from 'node:crypto';
import type {
  ConflictCommitPhase,
  ConflictCommitResult,
  ConflictCommitState,
  ConflictLandErrorCode,
  ConflictOpenErrorCode,
  ConflictPreparePhase,
  ConflictSession,
  ConflictSessionEvent,
  ConflictSessionStatus,
} from '@pierre-review/shared';
import { config } from '../config.js';
import type { StoredSuggestion } from './land.js';
import type { ConflictModel } from './model-types.js';
import { conflictFileEntries } from './model.js';

/**
 * THE RESOLVER SESSION — a module-level `Map`, and deliberately NOTHING ELSE.
 *
 * ⚠ THERE IS NO TABLE, AND THERE MUST NOT BE ONE. The reflex in this repo is to add one; here
 * it is wrong for three reasons that do not weaken over time:
 *
 *   1. THE MODEL IS SOURCE CODE. Every region is the text of somebody's file, three ways over.
 *      Persisting it would put working-tree contents into the same database the timeline lives
 *      in, with a retention story, an export story and an erasure story, for a thing whose whole
 *      lifetime is one overlay being open.
 *   2. IT IS PINNED TO `(headSha, baseSha)` AND WORTHLESS THE INSTANT EITHER MOVES. A row that
 *      survives a restart survives into a world where the push it describes would be wrong —
 *      and the fold that lands is the fold that was reviewed, or it is nothing.
 *   3. REBUILDING IS THE HONEST ANSWER. After a restart the reader reopens, the model is built
 *      against the shas as they are NOW, and their decisions are still in the SPA's own store
 *      under the pinned key. Nothing is lost that was still true.
 *
 * So: no migration, no `accountScopedTables()` entry, no cleanup cron. The tenth `pnpm dev`
 * restart is when someone will want to fix this. It is not broken.
 *
 * ⚠ THE SESSION IS NOT AUTHORISATION. `sessionId` is a CONCURRENCY token: every route re-checks
 * ownership through `getPrWriteContext` (→ 404) and write permission (→ 403), and a commit whose
 * id no longer matches the live session is `SessionExpired`. That is what stops a second tab, a
 * server restart or a re-open from landing decisions taken against a model that no longer exists
 * — it is not what stops another tenant reading this one.
 */

/** The suggestion store's handle. Opaque to the client; valid only inside its own session. */
export type SuggestionId = string;

export interface ConflictSessionRecord {
  sessionId: string;
  accountId: number;
  prId: number;
  status: ConflictSessionStatus;
  phase: ConflictPreparePhase | null;
  error: { code: ConflictOpenErrorCode; message: string } | null;
  /** The open's `autoApply`, which decides every region's `defaultDecision` on route 4.
   *  ⚠ NOT in the model hash — it changes which decision a region STARTS on, not what the
   *  region is (see `hash.ts`). */
  autoApply: boolean;
  /** null until the build finishes. `status: 'preparing'` is exactly this being null. */
  model: ConflictModel | null;
  modelHash: string;
  commit: ConflictCommitState | null;
  /**
   * Pro per-hunk suggestions the host has already validated. The plugin never returns text to
   * the client and the client never sends text back, so this map is the ONLY place a model's
   * lines exist between the two — which is what makes "no free typing" a property of the
   * protocol rather than a UI convention.
   */
  suggestions: Map<SuggestionId, StoredSuggestion>;
  /** Wall-clock expiry, pushed out on every touch. */
  expiresAt: number;
  /** A build is running for this PR. One at a time, per PR. */
  openRunning: boolean;
  /** A commit is running for this PR. One at a time, per PR — a second POST is a second push. */
  commitRunning: boolean;
  /** Cancels the running commit at its four checkpoints. Null once the push has happened:
   *  once GitHub holds the ref, cancelling is not a thing that can happen. */
  commitAbort: AbortController | null;
  subscribers: Set<(e: ConflictSessionEvent) => void>;
}

/** At most one live session per `(accountId, prId)`. */
const sessions = new Map<string, ConflictSessionRecord>();

const keyOf = (accountId: number, prId: number): string => `${accountId}:${prId}`;

/**
 * Drop everything past its TTL, on every map operation.
 *
 * A lazy sweep rather than an interval: the map holds at most a handful of entries, and an
 * unref-less timer in a module every route file imports is a process that will not exit.
 */
function sweep(now: number): void {
  for (const [key, rec] of sessions) {
    if (rec.expiresAt > now) continue;
    // A job still running owns its record — reaping it would leave the job writing into a
    // record nobody can read, and the SSE stream on the other end waiting forever.
    if (rec.openRunning || rec.commitRunning) continue;
    endStream(rec);
    sessions.delete(key);
  }
}

/** Push the expiry out. Called on every successful lookup: an open resolver in use is not idle. */
function touch(rec: ConflictSessionRecord, now: number): void {
  rec.expiresAt = now + config.conflictSessionTtlMs;
}

/**
 * How many git jobs are running across the whole process.
 *
 * ⚠ A GLOBAL CAP, not a per-account one. This is the LOCAL mode's single account; the thing
 * being protected is the machine — each job is a clone, two fetches and a merge-tree.
 */
const MAX_CONCURRENT_JOBS = 2;

function runningJobs(): number {
  let n = 0;
  for (const rec of sessions.values()) if (rec.openRunning || rec.commitRunning) n += 1;
  return n;
}

export type ClaimResult =
  /** A fresh session; the caller must run the build and settle it. */
  | { kind: 'created'; session: ConflictSessionRecord }
  /** The live session for this PR, untouched — re-attach, do not build again. */
  | { kind: 'reused'; session: ConflictSessionRecord }
  /** A job already holds this PR (or the machine). Nothing was claimed. */
  | { kind: 'busy'; session: ConflictSessionRecord | null; reason: 'pr' | 'capacity' };

/**
 * Claim the open slot for one PR.
 *
 * ⚠ SYNCHRONOUS, START TO FINISH, and it must stay that way. The whole point is that two POSTs
 * arriving in the same tick cannot both start a clone; an `await` anywhere between the lookup
 * and the `openRunning = true` write re-opens exactly that gap (the `synthesis/routes.ts`
 * in-flight-slot pattern).
 *
 * `restart` discards a settled session and builds against the CURRENT shas. It cannot discard a
 * RUNNING one — there is nothing to cancel a build with, and abandoning it would leave a clone
 * and two fetches running for a record nobody will read.
 */
export function claimSession(
  accountId: number,
  prId: number,
  opts: { restart: boolean; autoApply: boolean },
  now: number = Date.now(),
): ClaimResult {
  sweep(now);
  const key = keyOf(accountId, prId);
  const live = sessions.get(key) ?? null;

  if (live && (live.openRunning || live.commitRunning)) {
    // Re-attaching to a build already in flight is the right answer for a second tab; a
    // restart on top of one is not, and neither is a second commit.
    if (!opts.restart && live.openRunning) {
      touch(live, now);
      return { kind: 'reused', session: live };
    }
    return { kind: 'busy', session: live, reason: 'pr' };
  }
  if (live && !opts.restart) {
    touch(live, now);
    return { kind: 'reused', session: live };
  }
  if (live) {
    endStream(live);
    sessions.delete(key);
  }
  if (runningJobs() >= MAX_CONCURRENT_JOBS) {
    return { kind: 'busy', session: null, reason: 'capacity' };
  }

  const rec: ConflictSessionRecord = {
    sessionId: randomUUID(),
    accountId,
    prId,
    status: 'preparing',
    phase: null,
    error: null,
    autoApply: opts.autoApply,
    model: null,
    modelHash: '',
    commit: null,
    suggestions: new Map(),
    expiresAt: now + config.conflictSessionTtlMs,
    openRunning: true,
    commitRunning: false,
    commitAbort: null,
    subscribers: new Set(),
  };
  sessions.set(key, rec);
  return { kind: 'created', session: rec };
}

/** The live session for this PR, whatever its id. Used by the routes that carry `?session=`
 *  only to tell "expired" apart from "superseded" — both refuse, with different sentences. */
export function peekSession(
  accountId: number,
  prId: number,
  now: number = Date.now(),
): ConflictSessionRecord | null {
  sweep(now);
  return sessions.get(keyOf(accountId, prId)) ?? null;
}

/** The session the caller named, or null — expired, superseded and never-existed are one
 *  answer here on purpose: all three mean "take your decisions again". */
export function getSession(
  accountId: number,
  prId: number,
  sessionId: string,
  now: number = Date.now(),
): ConflictSessionRecord | null {
  sweep(now);
  const rec = sessions.get(keyOf(accountId, prId));
  if (!rec || rec.sessionId !== sessionId) return null;
  touch(rec, now);
  return rec;
}

/**
 * Drop a session by id. Returns false when it was already gone or already superseded — the
 * DELETE route answers 204 either way, because "it is not there" is what the caller asked for.
 *
 * A session with a job in flight is NOT dropped: the reader closing the overlay must not leave
 * a push writing into a record nobody holds. It expires on its own.
 */
export function dropSession(
  accountId: number,
  prId: number,
  sessionId: string,
  now: number = Date.now(),
): boolean {
  sweep(now);
  const key = keyOf(accountId, prId);
  const rec = sessions.get(key);
  if (!rec || rec.sessionId !== sessionId) return false;
  if (rec.openRunning || rec.commitRunning) return false;
  endStream(rec);
  sessions.delete(key);
  return true;
}

/**
 * Claim the commit slot. SYNCHRONOUS for the same reason `claimSession` is: two clicks on
 * "Commit" a tick apart must not become two pushes.
 */
export function claimCommitSlot(
  rec: ConflictSessionRecord,
  now: number = Date.now(),
): { ok: true; signal: AbortSignal } | { ok: false; reason: 'pr' | 'capacity' } {
  if (rec.openRunning || rec.commitRunning) return { ok: false, reason: 'pr' };
  if (runningJobs() >= MAX_CONCURRENT_JOBS) return { ok: false, reason: 'capacity' };
  const ac = new AbortController();
  rec.commitRunning = true;
  rec.commitAbort = ac;
  rec.commit = { status: 'running', phase: 'preparing', result: null, error: null };
  touch(rec, now);
  return { ok: true, signal: ac.signal };
}

/* ═════════════════════════════ settling a session ═════════════════════════════ */

/** Prepare progress. Silently ignored once the session has settled, so a late phase callback
 *  from an abandoned build cannot walk a `ready` session backwards. */
export function setPreparePhase(rec: ConflictSessionRecord, phase: ConflictPreparePhase): void {
  if (rec.status !== 'preparing') return;
  rec.phase = phase;
  emit(rec, { type: 'progress', session: sessionView(rec) });
}

export function settleReady(
  rec: ConflictSessionRecord,
  model: ConflictModel,
  modelHash: string,
  clean: boolean,
): void {
  rec.model = model;
  rec.modelHash = modelHash;
  rec.status = clean ? 'clean' : 'ready';
  rec.phase = null;
  rec.openRunning = false;
  touch(rec, Date.now());
  emit(rec, { type: 'ready', session: sessionView(rec) });
}

export function settleFailed(
  rec: ConflictSessionRecord,
  code: ConflictOpenErrorCode,
  message: string,
): void {
  rec.status = 'failed';
  rec.phase = null;
  rec.error = { code, message };
  rec.openRunning = false;
  touch(rec, Date.now());
  emit(rec, { type: 'failed', session: sessionView(rec) });
}

export function setCommitPhase(rec: ConflictSessionRecord, phase: ConflictCommitPhase): void {
  if (rec.commit?.status !== 'running') return;
  rec.commit = { ...rec.commit, phase };
  touch(rec, Date.now());
  emit(rec, { type: 'commit_progress', session: sessionView(rec) });
}

export function settleCommitDone(
  rec: ConflictSessionRecord,
  result: ConflictCommitResult,
): void {
  rec.commit = { status: 'done', phase: null, result, error: null };
  rec.commitRunning = false;
  rec.commitAbort = null;
  touch(rec, Date.now());
  emit(rec, { type: 'commit_done', session: sessionView(rec), result });
}

export function settleCommitFailed(
  rec: ConflictSessionRecord,
  code: ConflictLandErrorCode,
  message: string,
): void {
  const error = { code, message };
  rec.commit = { status: 'failed', phase: null, result: null, error };
  rec.commitRunning = false;
  rec.commitAbort = null;
  touch(rec, Date.now());
  emit(rec, { type: 'commit_failed', session: sessionView(rec), error });
}

/* ═════════════════════════════ the stream ═════════════════════════════ */

export function subscribe(
  rec: ConflictSessionRecord,
  cb: (e: ConflictSessionEvent) => void,
): () => void {
  rec.subscribers.add(cb);
  return () => {
    rec.subscribers.delete(cb);
  };
}

/** ⚠ A subscriber that throws must not take the job down with it: the emitter is the build,
 *  and a broken socket is not a reason to abandon a push. */
function emit(rec: ConflictSessionRecord, e: ConflictSessionEvent): void {
  for (const cb of [...rec.subscribers]) {
    try {
      cb(e);
    } catch {
      /* a dead socket — the stream's own close handler unsubscribes it */
    }
  }
}

/** Tell every live stream this session is gone, so the client stops waiting on a record that
 *  no longer exists. */
function endStream(rec: ConflictSessionRecord): void {
  emit(rec, { type: 'done' });
  rec.subscribers.clear();
}

/* ═════════════════════════════ Pro suggestions ═════════════════════════════ */

/**
 * Store one validated suggestion and mint its handle.
 *
 * The HOST owns this, not the plugin: the plugin validates and hands back lines, and the id it
 * would otherwise mint would be an id into a store the commit path cannot read. Valid for this
 * session only — a new model is a new session, and a suggestion against the old bytes is
 * `UnknownSuggestion` rather than a splice of text nobody looked at.
 */
export function storeSuggestion(
  rec: ConflictSessionRecord,
  suggestion: StoredSuggestion,
): SuggestionId {
  const id = randomUUID();
  rec.suggestions.set(id, suggestion);
  touch(rec, Date.now());
  return id;
}

/* ═════════════════════════════ the wire projection ═════════════════════════════ */

/**
 * The manifest. ⚠ NO REGIONS — a thirty-file conflict carrying them inline is a multi-megabyte
 * payload on every progress frame; the SPA fetches one file's regions on selection (route 4).
 *
 * While `preparing` there is no model yet, so the pins are empty strings. The SPA reads them
 * only once `status === 'ready'` (they are the key its decision store is filed under), and the
 * `clean` sentence reads `baseRef`, which a clean build DOES carry a model for.
 */
export function sessionView(rec: ConflictSessionRecord): ConflictSession {
  const model = rec.model;
  const files = model ? conflictFileEntries(model) : [];
  return {
    sessionId: rec.sessionId,
    prId: rec.prId,
    status: rec.status,
    phase: rec.phase,
    error: rec.error,
    headSha: model?.headSha ?? '',
    baseSha: model?.baseSha ?? '',
    modelHash: rec.modelHash,
    mergeBaseSha: model?.mergeBaseSha ?? null,
    mergeBaseIsVirtual: model?.mergeBaseIsVirtual ?? false,
    baseRef: model?.baseRef ?? '',
    headRef: model?.headRef ?? '',
    files,
    unsupportedIndexes: files.filter((f) => f.unsupported !== null).map((f) => f.index),
    // Every conflicted path merge-tree named is resolvable here: none refused, and the caps
    // stopped us reaching none of them. `truncated` is the second half — a file we never
    // extracted is a file the commit leaves conflicted just as surely as a binary one.
    fullyResolvable:
      model !== null && !model.truncated && files.every((f) => f.unsupported === null),
    autoApplied: rec.autoApply,
    renameDetection: model?.renameDetection ?? 'on',
    truncated: model?.truncated ?? false,
    totalConflictedPaths: model?.totalConflictedPaths ?? 0,
    strategies: model?.strategies ?? [],
    rebaseUnavailableReason: model?.rebaseUnavailableReason ?? null,
    // ⚠ `true` while there is no model, for the same reason the model itself defaults true: an
    // absent fact is not a refusal, and the land route is what actually decides.
    prBranchPushable: model?.prBranchPushable ?? true,
    prBranchUnavailableReason: model?.prBranchUnavailableReason ?? null,
    reservedBranchNames: model?.reservedBranchNames ?? [],
    commit: rec.commit,
  };
}

/** Test seam only. */
export const __testing = {
  sessions,
  MAX_CONCURRENT_JOBS,
  reset: (): void => {
    for (const rec of sessions.values()) rec.subscribers.clear();
    sessions.clear();
  },
};
