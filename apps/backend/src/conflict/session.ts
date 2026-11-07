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
import type { StoredEdit, StoredSuggestion } from './land.js';
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

/** The manual-edit store's handle. Same shape, same lifetime, DIFFERENT STORE — see `edits`. */
export type EditId = string;

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
   * lines exist between the two.
   */
  suggestions: Map<SuggestionId, StoredSuggestion>;
  /**
   * The reader's OWN text for a region, validated by `validateConflictEdit` before its id
   * existed. Mechanically identical to `suggestions` — that is the point, it is that mechanism
   * reused — and kept in a SEPARATE map because the two have different provenances and
   * different refusal sentences. One map would let a `'suggestion'` decision redeem an `editId`
   * and be told "that suggestion has expired. Ask Claude again." about text the reader typed.
   */
  edits: Map<EditId, StoredEdit>;
  /** When the record was minted. ⚠ THE ONE CLOCK `touch()` CANNOT MOVE — see
   *  `MAX_SESSION_LIFETIME_MS`. */
  createdAt: number;
  /** Wall-clock expiry, pushed out on every touch and capped by the absolute lifetime. */
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

/**
 * How long a record may live NO MATTER HOW OFTEN IT IS READ.
 *
 * ⚠ `touch()` ALONE BOUNDS NOTHING. Every manifest read touches, and the SPA polls the manifest
 * for as long as the overlay is mounted (`useConflictSession` — the poll is the recovery channel
 * after a proxy cuts the stream, so it cannot simply stop at `ready`). A tab left open overnight
 * therefore pushed `expiresAt` out forever: the record stayed resident, `liveSessionIds()` kept
 * reporting it to the janitor, and its two fetch refs pinned objects against every repack.
 *
 * So the TTL measures IDLENESS and this measures AGE, and a session hits whichever comes first.
 * Losing one is cheap by construction (the header): the model is rebuilt against the shas as they
 * are now, and the reader's decisions are in the SPA's own store under the pinned key.
 */
const MAX_SESSION_LIFETIME_MS = 4 * 60 * 60_000;

/** Push the expiry out. Called on every successful lookup: an open resolver in use is not idle. */
function touch(rec: ConflictSessionRecord, now: number): void {
  rec.expiresAt = Math.min(
    now + config.conflictSessionTtlMs,
    rec.createdAt + MAX_SESSION_LIFETIME_MS,
  );
}

/* ═════════════════════ how many jobs may run ═════════════════════ */

/**
 * ⚠ TWO CAPS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS — and they refuse in two different
 * sentences, because they are two different facts about the world.
 *
 *   PER ACCOUNT — one at a time. A resolver is a clone, two fetches and a merge-tree; a person
 *   resolves one pull request at a time, and a second one from the same account is a second tab
 *   or a second click, not a second job. The reader is told about THEIR OWN work: "you're already
 *   resolving one".
 *
 *   GLOBAL — the machine's ceiling. It protects disk and CPU, and it is the ONLY thing the
 *   per-account cap cannot bound once there are many accounts.
 *
 * ⚠ A TENANT IS NEVER TOLD ABOUT ANOTHER TENANT'S LOAD. The global refusal says the service is
 * busy and stops; it names no count, no account and no pull request. The predecessor was a single
 * process-global cap of 2 whose own comment reasoned from "the LOCAL mode's single account", so
 * in cloud one tenant opening two resolvers told every other tenant that two pull requests were
 * already being prepared — false about their work, and a disclosure about somebody else's.
 */
const MAX_JOBS_PER_ACCOUNT = 1;
const MAX_CONCURRENT_JOBS = 4;

/**
 * ⚠ AND TWO MORE CAPS ON THE RECORDS THEMSELVES, WHICH ARE NOT THE SAME THING AS THE JOB CAPS
 * ABOVE. A job ends in seconds; the RECORD it leaves behind holds a whole `ConflictModel` — the
 * base/ours/theirs text of every region, up to `config.conflictMaxTotalBytes` (8 MiB) of it — and
 * lives until the TTL or the lifetime ceiling reaps it. `MAX_JOBS_PER_ACCOUNT` serialises the
 * builds and refuses NONE of them, so one account scripting an open per conflicted pull request
 * retained one model per PR: hundreds of megabytes of string data in a process every other tenant
 * shares, bounded by nothing. This is the bound.
 *
 * The arithmetic is deliberately conservative and the worst case is the one to read: 24 × 8 MiB.
 * Real models are orders of magnitude smaller (a conflict is a few hunks of a few files), so the
 * ceiling is reached by an adversary long before it is reached by readers.
 *
 * ⚠ EVICTION, NOT REFUSAL, AND ONLY OF A SETTLED RECORD. A running job owns its record (the same
 * rule `sweep` follows). What an evicted reader loses is what a restart loses — the model, never
 * the decisions — so refusing the open instead would protect nothing and block the work.
 */
const MAX_SESSIONS_PER_ACCOUNT = 3;
const MAX_TOTAL_SESSIONS = 24;

/** Running jobs, split into this account's and everyone's, in ONE pass over the map. */
function jobCounts(accountId: number): { mine: number; total: number } {
  let mine = 0;
  let total = 0;
  for (const rec of sessions.values()) {
    if (!rec.openRunning && !rec.commitRunning) continue;
    total += 1;
    if (rec.accountId === accountId) mine += 1;
  }
  return { mine, total };
}

/**
 * Make room for one more record: drop a SETTLED session — unwatched before watched, and within
 * each the one read longest ago — from this account's own share first and then the process's,
 * until both ceilings have room.
 *
 * ⚠ SYNCHRONOUS, like everything else in the claim window. `expiresAt` is the touch order (every
 * touch sets it from the same TTL), so the smallest is the one read longest ago.
 */
function evictForNewSession(accountId: number): void {
  // ⚠ AN UNWATCHED RECORD GOES FIRST. A live subscriber is a tab with the overlay open on
  // screen; an abandoned one is exactly what this cap exists to collect. Both are survivable
  // (the client falls through to the poll, gets "no longer open" and offers Start again), but
  // one of them interrupts somebody mid-resolution and the other does not.
  const rank = (rec: ConflictSessionRecord): [number, number] => [
    rec.subscribers.size > 0 ? 1 : 0,
    rec.expiresAt,
  ];
  const evictOldest = (of: readonly ConflictSessionRecord[]): boolean => {
    let oldest: ConflictSessionRecord | null = null;
    for (const rec of of) {
      if (rec.openRunning || rec.commitRunning) continue;
      if (oldest == null) {
        oldest = rec;
        continue;
      }
      const [w, e] = rank(rec);
      const [ow, oe] = rank(oldest);
      if (w < ow || (w === ow && e < oe)) oldest = rec;
    }
    if (oldest == null) return false;
    endStream(oldest);
    sessions.delete(keyOf(oldest.accountId, oldest.prId));
    return true;
  };
  // This account's share first — a hoarder must never evict somebody else's work to make room
  // for its own fourth session.
  for (;;) {
    const mine = [...sessions.values()].filter((r) => r.accountId === accountId);
    if (mine.length < MAX_SESSIONS_PER_ACCOUNT) break;
    if (!evictOldest(mine)) break;
  }
  for (;;) {
    if (sessions.size < MAX_TOTAL_SESSIONS) break;
    if (!evictOldest([...sessions.values()])) break;
  }
}

/**
 * Why this account may not start a job right now, or null.
 *
 * ⚠ CALLED INSIDE THE SYNCHRONOUS CLAIM WINDOW and it must stay synchronous: an `await` between
 * this and the `openRunning = true` / `commitRunning = true` write is the gap in which two
 * requests both pass the check (the AI in-flight-slot defect, one feature over).
 */
function capacityRefusal(accountId: number): 'shutdown' | 'account' | 'capacity' | null {
  if (shuttingDown) return 'shutdown';
  const { mine, total } = jobCounts(accountId);
  if (mine >= MAX_JOBS_PER_ACCOUNT) return 'account';
  if (total >= MAX_CONCURRENT_JOBS) return 'capacity';
  return null;
}

/* ═════════════════════ shutdown ═════════════════════ */

/**
 * Set by the SIGTERM handler (index.ts). From here on no NEW job may be claimed, while the ones
 * already running are left alone to finish — a commit mid-push is a `git push` GitHub may
 * already have accepted, and killing it is how a reader ends up with a landed commit and a
 * screen that says it failed.
 *
 * ⚠ IT DOES NOT PRESERVE SESSIONS, AND MUST NOT GROW INTO SOMETHING THAT DOES. A restart loses
 * every session, deliberately and correctly (see the header): the model is pinned to
 * `(headSha, baseSha, modelHash)` and the reader's decisions live in the SPA's own store. What
 * this buys is the IN-FLIGHT PUSH, nothing else.
 */
let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

/** Jobs still running anywhere in the process — the SIGTERM handler's wait condition. */
export function runningJobCount(): number {
  let n = 0;
  for (const rec of sessions.values()) if (rec.openRunning || rec.commitRunning) n += 1;
  return n;
}

/**
 * The session ids the janitor must NOT collect refs for.
 *
 * ⚠ LIVE MEANS PRESENT IN THIS MAP, not "running". A settled session sitting at `ready` still
 * owns `refs/pierre/conflict/<id>/{head,base}`, and its commit re-reads those refs minutes
 * later — deleting them mid-resolution is how a commit lands against objects that are no longer
 * reachable.
 *
 * ⚠ IT SWEEPS FIRST, AND THAT IS NOT AN OPTIMISATION. Every other sweep is request-driven
 * (claim/peek/get/drop), and the case the janitor exists for — a reader who opens the resolver
 * and closes the TAB, so the deferred DELETE never lands — is by definition the case where no
 * further request arrives. Without this the expired record sat in the map, reported itself live
 * on every tick, and its two refs were counted in `refsKept` and kept forever: the janitor
 * scanned, repacked, and collected exactly the leak it was written to collect.
 */
export function liveSessionIds(now: number = Date.now()): Set<string> {
  sweep(now);
  const ids = new Set<string>();
  for (const rec of sessions.values()) ids.add(rec.sessionId);
  return ids;
}

export type ClaimResult =
  /** A fresh session; the caller must run the build and settle it. */
  | { kind: 'created'; session: ConflictSessionRecord }
  /** The live session for this PR, untouched — re-attach, do not build again. */
  | { kind: 'reused'; session: ConflictSessionRecord }
  /** Nothing was claimed. `reason` picks the sentence, and the four are not interchangeable. */
  | {
      kind: 'busy';
      session: ConflictSessionRecord | null;
      reason: 'pr' | 'account' | 'capacity' | 'shutdown';
    };

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
  const refusal = capacityRefusal(accountId);
  if (refusal) return { kind: 'busy', session: null, reason: refusal };
  // AFTER the refusal, so a claim that is going to be refused never costs somebody their model.
  evictForNewSession(accountId);

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
    edits: new Map(),
    createdAt: now,
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
):
  | { ok: true; signal: AbortSignal }
  | { ok: false; reason: 'pr' | 'account' | 'capacity' | 'shutdown' } {
  if (rec.openRunning || rec.commitRunning) return { ok: false, reason: 'pr' };
  // `rec` holds no job (the line above proved it), so it contributes nothing to either count
  // and needs no exclusion.
  const refusal = capacityRefusal(rec.accountId);
  if (refusal) return { ok: false, reason: refusal };
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

/* ═════════════════════════════ manual edits (CORE) ═════════════════════════════ */

/**
 * ⚠ A THIRD MEMORY BOUND, FOR THE ONE THING IN THIS FILE A READER CAN GROW BY TYPING.
 *
 * The record caps above bound how many MODELS the process retains; this bounds how much typed
 * text one of them may accumulate — and since nothing is ever evicted (see `storeEdit`), it is
 * the WHOLE bound. Without it the ceiling would be one edit per decidable region per save:
 * `CONFLICT_MAX_FILES` × `CONFLICT_MAX_REGIONS` is 4,800 regions, at up to
 * `conflictSuggestMaxChars` (4,000) each, so ~19 MiB per session before anybody re-saves — more
 * than the 8 MiB the whole model is capped at, in a process every tenant shares. Sixty-four
 * full-size edits is far more hand-editing than any resolution contains and well under a
 * megabyte, so the refusal is reachable by a script and not by a person.
 *
 * ⚠ IT IS TIED TO THE PER-EDIT CAP RATHER THAN SPELLED AS A NUMBER, so the two move together.
 */
const MAX_EDIT_CHARS_PER_SESSION = 64 * config.conflictSuggestMaxChars;

const editChars = (edit: StoredEdit): number => {
  let n = 0;
  for (const line of edit.lines) n += line.length + 1;
  return n;
};

/**
 * Store one validated edit and mint its handle, or null when this session is already holding
 * as much typed text as it may.
 *
 * ⚠ A HANDLE IS NEVER EVICTED — `storeSuggestion`'s rule, and for the same reason. Re-saving a
 * region used to DELETE its previous edit on the argument that "a region has one current text";
 * true of the region, false of the handles pointing at it. The undo stack is the counter-example
 * that shipped: it files `previousEditId` when a decision is replaced, so a second save followed
 * by one Ctrl+Z restored an id the server had just destroyed. The pane could not tell — the
 * client's own line map is append-only, so the region went on rendering applied-green and
 * counting as decided — and the WHOLE commit then came back `UnknownEdit`, naming no file and no
 * region, with every region on screen looking answered. A second tab saving the same region did
 * it to the first tab's decisions from across the process. `MAX_EDIT_CHARS_PER_SESSION` is the
 * bound now, and it is a real one.
 *
 * ⚠ AND THE BUDGET IS COMPUTED WITHOUT MUTATING, so a refusal is the no-op this route's contract
 * promises ("a refusal mints nothing, so there is no handle to redeem"). The eviction ran BEFORE
 * the sum, so a save that overran the cap destroyed the region's previous, accepted, already-
 * decided edit on its way to answering `too_many_edits` — the same unlocatable `UnknownEdit` at
 * commit time, reached by doing nothing wrong.
 *
 * ⚠ THE HOST MINTS THE ID, exactly as it does for a suggestion: an id minted anywhere else is
 * an id into a store the commit path cannot read.
 */
export function storeEdit(rec: ConflictSessionRecord, edit: StoredEdit): EditId | null {
  let held = 0;
  for (const e of rec.edits.values()) held += editChars(e);
  if (held + editChars(edit) > MAX_EDIT_CHARS_PER_SESSION) return null;
  const id = randomUUID();
  rec.edits.set(id, edit);
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
  MAX_JOBS_PER_ACCOUNT,
  MAX_SESSIONS_PER_ACCOUNT,
  MAX_TOTAL_SESSIONS,
  MAX_EDIT_CHARS_PER_SESSION,
  reset: (): void => {
    for (const rec of sessions.values()) rec.subscribers.clear();
    sessions.clear();
    shuttingDown = false;
  },
};
