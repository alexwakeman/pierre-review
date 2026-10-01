// The post-write SETTLE LADDER — "keep re-reading this PR until GitHub has finished reacting to
// what we just did".
//
// WHY ONE READ IS NOT ENOUGH. A write to GitHub is acknowledged before GitHub has finished with
// it. A push is attached to its pull request asynchronously, and mergeability is not stored at
// all: asking for it STARTS a background trial merge, and the answer while that runs is UNKNOWN
// (or, for a moment after a push, the verdict for the PREVIOUS head). The post-write resync
// (sync/resync-after-write.ts) reads once, milliseconds after the write, so it routinely stored
// exactly that in-between state — and nothing re-read it, because GitHub finishing its
// computation does NOT bump the PR's `updatedAt`, which is the only thing the adaptive walk's
// `since` window sees. That is how a resolved conflict kept its "Conflicts" card: the stored row
// said CONFLICTING/DIRTY for a head that was no longer conflicting.
//
// SO: a short, coalescing ladder per (account, PR) — re-read at ~5s, 15s, 45s and 120s after the
// write — that STOPS as soon as the row says what the write implies:
//   • the PR is no longer open (nothing left to settle), or
//   • every expectation the writer handed us is met AND both merge columns are KNOWN.
// The expectations are the writer's own facts about its write:
//   headSha        — "I pushed exactly this commit": the stored head must BE it.
//   headNot        — "I asked GitHub to move the head" (a native update-branch, which returns no
//                    sha): the stored head must be anything BUT the old one.
//   notConflicting — "I pushed a FULL conflict resolution to the PR's own branch": a stored
//                    CONFLICTING / DIRTY is stale, not an answer. ⚠ This is the case the whole
//                    ladder exists for — a stale DIRTY is a KNOWN value, so "both merge columns
//                    known" alone would stop on it at step one.
//   mergeStateNot  — "my write should lift THIS verdict" (an approval → `blocked`): a stored
//                    value equal to it is read again. Same reason — a stale BLOCKED is known.
//   ciNot          — "I re-ran the CI that produced THIS status" (a rerun of a red run): a stored
//                    `ci_status` equal to it is read again. A stale FAILURE is known too.
// ⚠ A LADDER WITH NO EXPECTATION STOPS AT ITS FIRST READ THAT HAS BOTH MERGE COLUMNS KNOWN — so a
// writer whose effect GitHub reflects late must STATE it, or it gets one read. An expectation the
// write cannot meet (an approval that does not satisfy protection stays `blocked`) only costs the
// ladder's bounded four reads.
//
// ⚠ NOT THE VIEWED-PR POLL. `POST /api/prs/:id/refresh` (sync/refresh-pr.ts) is the live cadence
// for an OPEN pane and keeps its own probe/floor semantics; this module never touches it, and
// nothing here routes through `enqueuePrSync` (its debounce would swallow the cadence).
// ⚠ NO `waitForInFlight`. Every step runs after the write, so a sync already in flight started
// after it too — its answer is as good as ours, and a stand-down costs nothing but a re-read.
// ⚠ RATE LIMITS PAUSE, NEVER FAIL. While the account is limited a step re-arms instead of
// running (the cheap-consumer `isLimited` contract), bounded, and never surfaces as an error.
// ⚠ EVERY ENTRY IS RELEASED ON EVERY EXIT PATH — a settled PR, an exhausted ladder, a thrown
// lookup, a superseded run, a FIFO eviction. A leaked entry would hold a timer and a map slot
// for the life of the process.
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { isLimited } from '../github/rate-budget.js';
import { invalidatePrHydration } from './hydrate-detail.js';
import { notePrChanged } from './pr-change-signal.js';
import { syncOnePr } from './sync-one-pr.js';
import type { Logger } from './sync-repo.js';

const { pullRequests, repos } = schema;

/** What the writer knows its write implies. Every field optional; `{}` = "just re-read it". */
export interface PrSettleExpectation {
  /** The stored head must equal this sha (we pushed exactly this commit). */
  headSha?: string;
  /** The stored head must differ from this sha (we asked GitHub to move it). */
  headNot?: string;
  /** Stored `mergeable` must not be 'conflicting' AND `merge_state_status` not 'dirty'. */
  notConflicting?: boolean;
  /** Stored `merge_state_status` must differ from this (an approval → 'blocked'). */
  mergeStateNot?: string;
  /** Stored `ci_status` must differ from this (a CI rerun → the red status it re-ran). */
  ciNot?: string;
}

/** The stored facts a settle decision reads, plus the coordinates a sync needs. */
export interface PrSettleFacts {
  repoId: number;
  owner: string;
  name: string;
  number: number;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  headSha: string | null;
  mergeable: 'mergeable' | 'conflicting' | 'unknown' | null;
  mergeStateStatus: string | null;
  ciStatus: string | null;
}

/**
 * Read one PR's settle facts. ACCOUNT-SCOPED on both the PR row and its repo even though every
 * caller already proved ownership — an id-addressed read outside db/queries.ts, so it is named
 * in scripts/verify-isolation.ts. Null = not this account's PR (or gone).
 */
export async function getPrSettleFacts(
  prId: number,
  accountId: number,
): Promise<PrSettleFacts | null> {
  const rows = await db
    .select({
      repoId: pullRequests.repoId,
      owner: repos.owner,
      name: repos.name,
      number: pullRequests.number,
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
      headSha: pullRequests.headSha,
      mergeable: pullRequests.mergeable,
      mergeStateStatus: pullRequests.mergeStateStatus,
      ciStatus: pullRequests.ciStatus,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.id, prId),
        eq(pullRequests.accountId, accountId),
        eq(repos.accountId, accountId),
      ),
    )
    .limit(1)
    .execute();
  const r = rows[0];
  if (!r) return null;
  return {
    repoId: r.repoId,
    owner: r.owner,
    name: r.name,
    number: r.number,
    state: r.state,
    isDraft: r.isDraft,
    headSha: r.headSha ?? null,
    mergeable: r.mergeable ?? null,
    mergeStateStatus: r.mergeStateStatus ?? null,
    ciStatus: r.ciStatus ?? null,
  };
}

/**
 * The distinct repos THIS account's PRs (by local id) live in. ACCOUNT-SCOPED on both the PR row
 * and its repo, like `getPrSettleFacts`: a foreign or unknown id contributes nothing. It is an
 * id-LIST read outside db/queries.ts, so it is named in scripts/verify-isolation.ts.
 */
export async function getPrRepoIds(
  accountId: number,
  prIds: readonly number[],
): Promise<number[]> {
  const ids = [...new Set(prIds)];
  const out = new Set<number>();
  // Chunked so a large bot-thread resolve can never approach the driver's bound-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ repoId: pullRequests.repoId })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          inArray(pullRequests.id, ids.slice(i, i + 500)),
          eq(pullRequests.accountId, accountId),
          eq(repos.accountId, accountId),
        ),
      )
      .execute();
    for (const r of rows) out.add(r.repoId);
  }
  return [...out];
}

/**
 * Raise the SPA change signal (sync/pr-change-signal.ts) for the repos of these PRs, after a
 * route STAMPED them locally — a stamp is a board-visible move no walk will report. Never throws,
 * never rejects.
 *
 * ⚠ A ROUTE AWAITS THIS BEFORE IT REPLIES. The SPA's write sweep (prCacheSync.ts
 * `invalidateAfterPrWrite`) reads `['repos']` FIRST and records the stamps it saw as already
 * covered; a stamp raised after the reply lands after that read, so SyncStatus sees it as a new
 * server change and refetches the whole write set a second time.
 */
export async function notePrChangedForPrs(
  accountId: number,
  prIds: readonly number[],
): Promise<void> {
  if (prIds.length === 0) return;
  try {
    for (const repoId of await getPrRepoIds(accountId, prIds)) notePrChanged(accountId, repoId);
  } catch {
    /* advisory: the next walk's own sync_state stamp still cascades */
  }
}

/** `notePrChangedForPrs` for ONE PR — the common case. Never throws, never rejects. */
export function notePrChangedForPr(accountId: number, prId: number): Promise<void> {
  return notePrChangedForPrs(accountId, [prId]);
}

/** Is the writer's HEAD expectation (if any) met by the stored row? */
export function headExpectationMet(
  facts: Pick<PrSettleFacts, 'headSha'>,
  expect: PrSettleExpectation,
): boolean {
  if (expect.headSha != null && facts.headSha !== expect.headSha) return false;
  if (expect.headNot != null && (facts.headSha == null || facts.headSha === expect.headNot)) {
    return false;
  }
  return true;
}

const known = (v: string | null): boolean => v != null && v !== 'unknown';

/**
 * Has this PR settled? True once it left the open set, or once every expectation is met AND
 * the merge columns are known.
 *
 * ⚠ A DRAFT'S `merge_state_status` IS 'unknown' FOREVER (sync/upsert.ts maps GitHub's DRAFT
 * there on purpose), so a draft only needs `mergeable` — otherwise every draft would run the
 * whole ladder for nothing.
 */
export function isPrSettled(facts: PrSettleFacts, expect: PrSettleExpectation): boolean {
  if (facts.state !== 'open') return true;
  if (!headExpectationMet(facts, expect)) return false;
  if (
    expect.notConflicting &&
    (facts.mergeable === 'conflicting' || facts.mergeStateStatus === 'dirty')
  ) {
    return false;
  }
  if (expect.mergeStateNot != null && facts.mergeStateStatus === expect.mergeStateNot) return false;
  if (expect.ciNot != null && facts.ciStatus === expect.ciNot) return false;
  if (!known(facts.mergeable)) return false;
  if (!facts.isDraft && !known(facts.mergeStateStatus)) return false;
  return true;
}

// ── The ladder ──────────────────────────────────────────────────────────────────────────────

/** Offsets FROM THE SCHEDULING CALL, not gaps: re-reads at ~5s, 15s, 45s and 120s. */
const STEP_OFFSETS_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000];
/** While the account is rate-limited a step re-arms after this long instead of running. */
const PAUSE_RETRY_MS = 60_000;
/** GitHub's hard windows are hourly (rate-budget clamps waits at 65 min), so ~70 pauses cover
 *  the worst case; past that the entry is released rather than held forever. */
const MAX_PAUSES = 70;
/** Bounded FIFO, like refresh-pr's PROBE_STATE_MAX. An evicted entry only loses its follow-up
 *  reads — the walk and the unsettled-PR backstop still reach that PR. */
const SETTLE_MAX = 500;

interface SettleEntry {
  accountId: number;
  prId: number;
  log: Logger;
  expect: PrSettleExpectation;
  /** Index into STEP_OFFSETS_MS of the step that is armed / running. */
  step: number;
  pauses: number;
  /** Bumped by every scheduling call; a run whose generation is stale owns nothing. */
  gen: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, SettleEntry>();
let genSeq = 0;
const keyOf = (accountId: number, prId: number): string => `${accountId}:${prId}`;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A newer call's expectations win where they speak. A new HEAD expectation replaces the old one
 * wholesale (a newer push supersedes an older one — "must be X" and "must not be X" from two
 * writes cannot both be honoured). The rest are sticky: a later write that says nothing about
 * conflicts, the merge verdict or CI must not drop an earlier writer's expectation (a newer
 * `mergeStateNot` / `ciNot` replaces the older one) — and the worst a stale one can cost is a
 * ladder that runs to its bounded end.
 */
function mergeExpectations(
  prev: PrSettleExpectation,
  next: PrSettleExpectation,
): PrSettleExpectation {
  const out: PrSettleExpectation = {};
  const head = next.headSha != null || next.headNot != null ? next : prev;
  if (head.headSha != null) out.headSha = head.headSha;
  if (head.headNot != null) out.headNot = head.headNot;
  if (prev.notConflicting || next.notConflicting) out.notConflicting = true;
  const mergeStateNot = next.mergeStateNot ?? prev.mergeStateNot;
  if (mergeStateNot != null) out.mergeStateNot = mergeStateNot;
  const ciNot = next.ciNot ?? prev.ciNot;
  if (ciNot != null) out.ciNot = ciNot;
  return out;
}

// Steps currently running — only so a test can await them deterministically (`__prSettleDrain`).
const runningSteps = new Set<Promise<void>>();

function arm(key: string, entry: SettleEntry, delayMs: number): void {
  const gen = entry.gen;
  const timer = setTimeout(() => {
    // runStep never rejects (its own try/catch/finally), so neither does this bookkeeping.
    const p = runStep(key, entry, gen);
    runningSteps.add(p);
    void p.finally(() => runningSteps.delete(p));
  }, delayMs);
  // Never keep the process alive for a follow-up read (shutdown, the resolver's SIGTERM drain).
  // Guarded because faked timers may not expose unref.
  if (typeof timer.unref === 'function') timer.unref();
  entry.timer = timer;
}

function release(key: string, entry: SettleEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (entries.get(key) === entry) entries.delete(key);
}

/**
 * Start (or restart) the settle ladder for one PR. Fire-and-forget and NEVER throws: the caller
 * is the tail of a write that has already succeeded.
 *
 * Coalescing: a second call for the same PR merges its expectations into the live entry and
 * restarts the ladder from the first step — the newest write is the one whose aftermath matters.
 */
export function schedulePrSettle(
  accountId: number,
  prId: number,
  log: Logger,
  expect: PrSettleExpectation = {},
): void {
  try {
    const key = keyOf(accountId, prId);
    const existing = entries.get(key);
    let entry: SettleEntry;
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = null;
      existing.expect = mergeExpectations(existing.expect, expect);
      existing.log = log;
      entry = existing;
      // Re-insert so Map order tracks RECENCY and the FIFO trim evicts the stalest ladder.
      entries.delete(key);
    } else {
      if (entries.size >= SETTLE_MAX) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) {
          const oldest = entries.get(oldestKey);
          if (oldest) release(oldestKey, oldest);
          else entries.delete(oldestKey);
        }
      }
      entry = {
        accountId,
        prId,
        log,
        expect: mergeExpectations({}, expect),
        step: 0,
        pauses: 0,
        gen: 0,
        timer: null,
      };
    }
    entry.step = 0;
    entry.pauses = 0;
    entry.gen = ++genSeq;
    entries.set(key, entry);
    arm(key, entry, STEP_OFFSETS_MS[0] ?? 5_000);
  } catch (err) {
    // Map/timer bookkeeping cannot realistically throw, but the contract is "never throws".
    log.warn(`prSettle: could not schedule PR ${prId}: ${errMsg(err)}`);
  }
}

type StepOutcome = 'stop' | 'next' | 'pause';

async function stepOnce(entry: SettleEntry): Promise<StepOutcome> {
  // The cheap-consumer contract: a limited token is not asked anything. Not an error.
  if (isLimited(entry.accountId)) return 'pause';
  const before = await getPrSettleFacts(entry.prId, entry.accountId);
  if (!before || before.state !== 'open') return 'stop';
  // No waitForInFlight — see the header.
  await syncOnePr(before.repoId, before.number, entry.log);
  const after = await getPrSettleFacts(entry.prId, entry.accountId);
  if (!after) return 'stop';
  // The PR-detail hydration cache (60s) holds check runs and diff hunks for the head it read;
  // once the stored head, verdict or CI moved, a pane opened now must not be served the old one.
  if (
    after.headSha !== before.headSha ||
    after.mergeable !== before.mergeable ||
    after.mergeStateStatus !== before.mergeStateStatus ||
    after.ciStatus !== before.ciStatus
  ) {
    invalidatePrHydration(entry.accountId, after.owner, after.name, after.number);
  }
  return isPrSettled(after, entry.expect) ? 'stop' : 'next';
}

async function runStep(key: string, entry: SettleEntry, gen: number): Promise<void> {
  entry.timer = null;
  let outcome: StepOutcome = 'stop';
  try {
    outcome = await stepOnce(entry);
  } catch (err) {
    // A thrown lookup RELEASES the entry: a DB that cannot answer now is not a reason to hold a
    // timer, and the walk/backstop still reach this PR.
    outcome = 'stop';
    entry.log.warn(`prSettle: PR ${entry.prId} step failed, released: ${errMsg(err)}`);
  } finally {
    afterStep(key, entry, gen, outcome);
  }
}

function afterStep(key: string, entry: SettleEntry, gen: number, outcome: StepOutcome): void {
  // Superseded while this step ran (a newer write re-armed the ladder, or the entry was evicted):
  // the newer call owns the entry and its timer, so this run touches nothing.
  if (entries.get(key) !== entry || entry.gen !== gen) return;
  if (outcome === 'pause') {
    entry.pauses += 1;
    if (entry.pauses > MAX_PAUSES) {
      release(key, entry);
      return;
    }
    arm(key, entry, PAUSE_RETRY_MS);
    return;
  }
  if (outcome === 'next') {
    const prevOffset = STEP_OFFSETS_MS[entry.step];
    entry.step += 1;
    const nextOffset = STEP_OFFSETS_MS[entry.step];
    if (prevOffset === undefined || nextOffset === undefined) {
      entry.log.info(
        `prSettle: PR ${entry.prId} still unsettled after the last follow-up read — leaving it to the walk and the backstop`,
      );
      release(key, entry);
      return;
    }
    arm(key, entry, nextOffset - prevOffset);
    return;
  }
  release(key, entry);
}

/** Test-only: how many ladders are live, and one entry's public shape. */
export function __prSettleState(): {
  size: number;
  get: (accountId: number, prId: number) => { step: number; expect: PrSettleExpectation } | null;
} {
  return {
    size: entries.size,
    get: (accountId, prId) => {
      const e = entries.get(keyOf(accountId, prId));
      return e ? { step: e.step, expect: { ...e.expect } } : null;
    },
  };
}

/** Test-only: resolve once every step that has already started has finished. */
export async function __prSettleDrain(): Promise<void> {
  while (runningSteps.size > 0) await Promise.all([...runningSteps]);
}

/** Test-only: drop every ladder and its timer. */
export function __resetPrSettle(): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
  entries.clear();
}
