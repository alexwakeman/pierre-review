// The UNSETTLED-PR BACKSTOP and the TRUNK-MOVED RECHECK — re-reading merge state that GitHub
// changes WITHOUT bumping a pull request's `updatedAt`.
//
// THE BLIND SPOT. The adaptive walk re-reads only PRs whose `updatedAt` falls inside
// `since = lastIncrementalSyncAt − SYNC_OVERLAP_MINUTES`. GitHub finishing a mergeability
// computation does not bump `updatedAt`, and neither does CI finishing — so a PR the walk stored
// as `unknown` (GitHub was mid-computation when the walk asked) or as CI `pending` can stay that
// way for hours. Reproduced on real data: open PRs stored `unknown` (and CI `pending` for over two
// hours) that GitHub reported as known, with the same `updatedAt`. (A raw count of stored
// `unknown` rows overstates it: about half of the 132 first counted sat in one repo whose walks
// were FAILING, which is a different fault, and GitHub itself answers UNKNOWN on a first ask.)
// The 30-minute re-walk floor does not help — it re-walks, but with the same `since` window,
// which is exactly what excludes those PRs.
// The same blindness hits EVERY other open PR in a repo when a merge moves its trunk: each one's
// verdict (`behind`, `dirty`, `clean`) is now about a base that no longer exists, and nothing
// about THEM changed on GitHub's clock.
//
// SO, TWO CHEAP RE-READS through the Pending board's EXISTING batched liveness path
// (`fetchPrLivenessForNodes` with merge state — 1 GraphQL point, ≤25 PRs, ~5s — and
// `applyPrLiveness`, whose guards stay exactly as they are):
//   • runUnsettledPrBackstop — after every successful repo walk (scheduled AND manual): up to 25
//     open non-draft PRs whose stored `mergeable` / `merge_state_status` is unknown or NULL, most
//     recently updated first; plus at most 5 CI-`pending`-for-over-20-minutes PRs handed to the
//     settle ladder (the liveness selection carries no check rollup, so those need the full
//     single-PR read). It costs nothing — no GitHub call at all — on a repo with no such PRs.
//   • scheduleTrunkMovedRecheck — ~30s and ~90s after a merge LANDS (the merge route, the
//     auto-merge runner's direct and queue landings): up to 25 of the repo's open non-draft PRs,
//     forward cards first (a stale `clean` there is a Merge button that 405s).
//
// ⚠ GITHUB COMPUTES MERGEABILITY LAZILY: the first ask for a PR often answers UNKNOWN and STARTS
// the computation (measured: UNKNOWN, then MERGEABLE/CLEAN ~8s later, same `updatedAt`). One read
// is therefore not a backstop — PRs still unknown after the first pass get ONE second read ~10s
// later, and the trunk recheck's 90s pass is the 30s pass's second read. A PR still unsettled
// after two reads running — answered UNKNOWN, answered WITHOUT the merge fields, or not answered
// at all — is then left alone by the backstop for 30 minutes (`stuckUnknown`, excluded in the
// query), so a PR GitHub will not compute cannot cost a point on every hot-bucket walk.
// ⚠ NOT HEAD-AWARE, deliberately. The liveness selection carries no `headRefOid` (documented in
// github/queries.ts), and `applyPrLiveness`'s "an observed unknown never demotes a known state"
// rule stays as it is — this module only ever turns unknown INTO known, or lets a later read
// replace one known value with another.
// ⚠ NON-FATAL AND BUDGET-AWARE. Nothing here throws into its caller; a limited token is not asked
// (`isLimited`, and `fetchPrLivenessForNodes` degrades to empty on a limit) — a pause, never red.
// A read that FAILS (a gateway 502/timeout, a token that cannot be minted) puts the repo's
// backstop into a 15-minute back-off, so a repo GitHub cannot answer for is not re-asked on every
// walk.
// ⚠ IT NEVER WRITES `updatedAt`. `applyPrLiveness` advances it from the observation, but this
// module exists for updatedAt-SILENT changes: an observed newer `updatedAt` means real activity
// the walk has not persisted yet, and stamping it here would hide that activity from the SPA's
// "newer updatedAt → refetch the PR detail" rule once the walk does persist it.
import { and, desc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { MergeQueueEntryState, MergeStateStatus } from '@pierre-review/shared';
import { getAccessToken } from '../auth/account.js';
import { db, schema } from '../db/client.js';
import {
  applyPrLiveness,
  rankForMergeStatePass,
  type PrLivenessTarget,
} from '../db/pr-liveness.js';
import {
  fetchPrLivenessForNodes,
  PR_MERGE_STATE_NODE_BATCH,
  type PrLivenessObservation,
} from '../github/pr-liveness.js';
import { isLimited } from '../github/rate-budget.js';
import { notePrChanged } from './pr-change-signal.js';
import { getPrSettleFacts, schedulePrSettle } from './pr-settle.js';
import type { Logger } from './sync-repo.js';

const { pullRequests, ciStatusEvents } = schema;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The merge-state pass's measured batch (25 answers in ~5s; 50 502s the gateway). */
export const UNSETTLED_BATCH = PR_MERGE_STATE_NODE_BATCH;
/** How many open PRs the trunk-moved recheck ranks from (forward first, then most recent). */
const TRUNK_CANDIDATE_CAP = 500;
/** How many unsettled candidates the backstop selects. The cooling-down PRs are excluded IN THE
 *  QUERY (up to COOLING_EXCLUDE_MAX of them), so a repo with many stuck PRs cannot starve the
 *  rest; the in-memory filter after it is only the backstop for an over-long exclusion list. */
const UNSETTLED_CANDIDATE_CAP = 100;
const COOLING_EXCLUDE_MAX = 1_000;
/** After a FAILED backstop read (not a rate limit — that pauses), the repo is left alone this long. */
const FAILED_READ_BACKOFF_MS = 15 * 60_000;
const FAILED_READ_MAX = 1_000;
/**
 * A PR still unsettled after two reads running is left alone this long by the backstop.
 * GitHub normally finishes within seconds of being asked, so a PR still unknown after a second
 * read is one it is not computing (or cannot) — and re-asking on every hot-bucket walk (every
 * 2 min, 2 points each with its second read) would spend ~60 points/hour on a single repo for
 * nothing. The trunk-moved recheck ignores this: a moved base is a new question.
 */
const STUCK_UNKNOWN_COOLDOWN_MS = 30 * 60_000;
const STUCK_UNKNOWN_MAX = 5_000;
/** GitHub's lazy computation: the second read of a still-unknown PR. */
const SECOND_READ_DELAY_MS = 10_000;
/** CI `pending` for longer than this, with no newer observation, is presumed stale. */
const CI_STALE_MS = 20 * 60_000;
/** At most this many CI nudges (one single-PR sync each) per walk. */
const CI_NUDGES_PER_WALK = 5;
/** And never the same PR twice inside this window, so a genuinely long CI run costs ~3/hour. */
const CI_NUDGE_COOLDOWN_MS = 20 * 60_000;
const CI_NUDGE_MAX = 2_000;
/** After a merge lands: two re-reads, the second doubling as the first's lazy-computation read. */
const TRUNK_RECHECK_OFFSETS_MS: readonly number[] = [30_000, 90_000];
const TRUNK_TIMERS_MAX = 1_000;

type Mode = 'unsettled' | 'open';

function toTarget(r: {
  prId: number;
  repoId: number;
  githubNodeId: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown' | null;
  mergeStateStatus: string | null;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  inMergeQueue: boolean | null;
  mergeQueueEntryState: string | null;
  updatedAt: Date;
}): PrLivenessTarget {
  return {
    prId: r.prId,
    repoId: r.repoId,
    githubNodeId: r.githubNodeId,
    state: r.state,
    isDraft: r.isDraft,
    mergeable: r.mergeable ?? null,
    mergeStateStatus: (r.mergeStateStatus as MergeStateStatus | null) ?? null,
    reviewDecision: r.reviewDecision ?? null,
    inMergeQueue: r.inMergeQueue ?? null,
    mergeQueueEntryState: (r.mergeQueueEntryState as MergeQueueEntryState | null) ?? null,
    updatedAt: r.updatedAt,
  };
}

/**
 * The repo's PRs worth a merge-state re-read, as liveness targets.
 *
 * ⚠ REPO-ADDRESSED, so ACCOUNT-SCOPED: `(accountId, repoId)` both bind — a repo id belonging to
 * another tenant resolves nothing and can never reach GitHub or a write. Named in
 * scripts/verify-isolation.ts.
 *
 *   'unsettled' — open, non-draft, `mergeable` OR `merge_state_status` unknown/NULL, minus
 *                 `excludePrIds` (the ones cooling down — see `stuckUnknown`); most recently
 *                 updated first; up to 100 candidates, of which the caller asks GitHub about 25.
 *   'open'      — every open non-draft PR (capped), ranked by `rankForMergeStatePass` (forward
 *                 cards first); at most 25.
 */
export async function getRepoMergeStateTargets(
  accountId: number,
  repoId: number,
  mode: Mode,
  excludePrIds: readonly number[] = [],
): Promise<PrLivenessTarget[]> {
  const base = [
    eq(pullRequests.accountId, accountId),
    eq(pullRequests.repoId, repoId),
    eq(pullRequests.state, 'open'),
    eq(pullRequests.isDraft, false),
  ];
  const exclude = excludePrIds.slice(0, COOLING_EXCLUDE_MAX);
  if (mode === 'unsettled' && exclude.length > 0) {
    base.push(notInArray(pullRequests.id, exclude));
  }
  const where =
    mode === 'unsettled'
      ? and(
          ...base,
          or(
            isNull(pullRequests.mergeable),
            eq(pullRequests.mergeable, 'unknown'),
            isNull(pullRequests.mergeStateStatus),
            eq(pullRequests.mergeStateStatus, 'unknown'),
          ),
        )
      : and(...base);
  const rows = await db
    .select({
      prId: pullRequests.id,
      repoId: pullRequests.repoId,
      githubNodeId: pullRequests.githubNodeId,
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
      mergeable: pullRequests.mergeable,
      mergeStateStatus: pullRequests.mergeStateStatus,
      reviewDecision: pullRequests.reviewDecision,
      inMergeQueue: pullRequests.inMergeQueue,
      mergeQueueEntryState: pullRequests.mergeQueueEntryState,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequests)
    .where(where)
    .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id))
    .limit(mode === 'unsettled' ? UNSETTLED_CANDIDATE_CAP : TRUNK_CANDIDATE_CAP)
    .execute();
  const targets = rows.map(toTarget);
  return mode === 'unsettled' ? targets : rankForMergeStatePass(targets, UNSETTLED_BATCH);
}

export interface MergeStateRecheckResult {
  /** PRs asked about (0 when there was nothing to ask, or the read was skipped). */
  checked: number;
  /** Rows whose BOARD-VISIBLE state moved; any at all raises the repo's SPA change signal once. */
  changed: number;
  /** Observations that came back still unknown — GitHub is computing; worth one more read. */
  stillUnknown: number;
  /** The account's budget was exhausted: nothing was asked. Never an error. */
  paused: boolean;
  /** Stood down: another re-read for this repo was already running, or (backstop only) the repo
   *  is backing off after a failed read. */
  skipped: boolean;
}

// One re-read per (account, repo) at a time — the backstop, its second read and the trunk
// rechecks can all land on one repo within seconds and would otherwise pay twice for one answer.
// ⚠ SYNCHRONOUS CLAIM, released in a `finally` that covers every bail path incl. a thrown lookup.
const recheckInFlight = new Set<string>();
const repoKey = (accountId: number, repoId: number): string => `${accountId}:${repoId}`;

// `account:pr` → consecutive reads that left the PR UNSETTLED, and when the backstop may ask
// again. Bounded FIFO; an evicted entry only costs that PR one early re-ask.
interface StuckEntry {
  accountId: number;
  repoId: number;
  prId: number;
  streak: number;
  until: number;
}
const stuckUnknown = new Map<string, StuckEntry>();

function noteUnknownAnswer(
  accountId: number,
  repoId: number,
  prId: number,
  stillUnknown: boolean,
): void {
  const key = `${accountId}:${prId}`;
  const prev = stuckUnknown.get(key);
  if (!stillUnknown) {
    if (prev) stuckUnknown.delete(key);
    return;
  }
  const streak = (prev?.streak ?? 0) + 1;
  if (prev) stuckUnknown.delete(key);
  else if (stuckUnknown.size >= STUCK_UNKNOWN_MAX) {
    const oldest = stuckUnknown.keys().next().value;
    if (oldest !== undefined) stuckUnknown.delete(oldest);
  }
  stuckUnknown.set(key, {
    accountId,
    repoId,
    prId,
    streak,
    until: streak >= 2 ? Date.now() + STUCK_UNKNOWN_COOLDOWN_MS : 0,
  });
}

function coolingDown(accountId: number, prId: number, now: number): boolean {
  const e = stuckUnknown.get(`${accountId}:${prId}`);
  return e != null && e.until > now;
}

/** This repo's PRs the backstop is leaving alone right now — excluded in the query. */
function coolingPrIds(accountId: number, repoId: number, now: number): number[] {
  const out: number[] = [];
  for (const e of stuckUnknown.values()) {
    if (e.accountId === accountId && e.repoId === repoId && e.until > now) out.push(e.prId);
  }
  return out;
}

// `account:repo` → until when the backstop leaves this repo alone after a FAILED read. Bounded FIFO.
const failedReadUntil = new Map<string, number>();

function noteFailedRead(key: string): void {
  if (failedReadUntil.has(key)) failedReadUntil.delete(key);
  else if (failedReadUntil.size >= FAILED_READ_MAX) {
    const oldest = failedReadUntil.keys().next().value;
    if (oldest !== undefined) failedReadUntil.delete(oldest);
  }
  failedReadUntil.set(key, Date.now() + FAILED_READ_BACKOFF_MS);
}

const knownValue = (v: string | null | undefined): boolean => v != null && v !== 'unknown';

/**
 * Is this PR still UNSETTLED after the read? Judged on what is now STORED — the observed value
 * when GitHub stated a known one, else the stored one (`applyPrLiveness` never lets an observed
 * UNKNOWN demote a known value, and writes nothing for an ABSENT field).
 * ⚠ ABSENT COUNTS AS UNSETTLED, not just a literal UNKNOWN: a token that cannot read the merge
 * fields, or a node GitHub nulled after a partial error, leaves the row unknown for ever, and a
 * streak that reset on every such answer re-asked about that PR on every walk with no back-off.
 */
function unsettledAfterRead(target: PrLivenessTarget, obs: PrLivenessObservation): boolean {
  if (obs.state !== 'open') return false;
  const mergeable = knownValue(obs.mergeable) ? obs.mergeable : target.mergeable;
  const mergeState = knownValue(obs.mergeStateStatus)
    ? obs.mergeStateStatus
    : target.mergeStateStatus;
  const draft = obs.isDraft ?? target.isDraft;
  return !knownValue(mergeable) || (!draft && !knownValue(mergeState));
}

/**
 * Re-read up to 25 of one repo's open PRs' merge state from GitHub and write back what moved.
 * NEVER THROWS.
 */
export async function recheckRepoMergeStates(args: {
  accountId: number;
  repoId: number;
  log: Logger;
  mode: Mode;
}): Promise<MergeStateRecheckResult> {
  const { accountId, repoId, log, mode } = args;
  const out: MergeStateRecheckResult = {
    checked: 0,
    changed: 0,
    stillUnknown: 0,
    paused: false,
    skipped: false,
  };
  const key = repoKey(accountId, repoId);
  if (recheckInFlight.has(key)) return { ...out, skipped: true };
  const now = Date.now();
  if (mode === 'unsettled' && (failedReadUntil.get(key) ?? 0) > now) {
    return { ...out, skipped: true };
  }
  recheckInFlight.add(key);
  try {
    if (isLimited(accountId)) return { ...out, paused: true };
    const candidates = await getRepoMergeStateTargets(
      accountId,
      repoId,
      mode,
      mode === 'unsettled' ? coolingPrIds(accountId, repoId, now) : [],
    );
    const targets =
      mode === 'unsettled'
        ? candidates.filter((t) => !coolingDown(accountId, t.prId, now)).slice(0, UNSETTLED_BATCH)
        : candidates;
    // The cheap case, and the common one: nothing unsettled → no token, no GitHub call.
    if (targets.length === 0) return out;
    const token = await getAccessToken(accountId);
    const observed = await fetchPrLivenessForNodes(
      token,
      targets.map((t) => t.githubNodeId),
      {
        accountId,
        withMergeState: true,
        onPartial: () =>
          log.warn(`merge-state recheck repo ${repoId}: partial GraphQL response (continuing)`),
        onRateLimited: () => {
          out.paused = true;
        },
      },
    );
    out.checked = targets.length;
    const byNode = new Map(targets.map((t) => [t.githubNodeId, t]));
    const answered = new Set<string>();
    // Sequential, not Promise.all: on sqlite these share one write lock, and the loop is ≤25.
    for (const obs of observed) {
      const target = byNode.get(obs.nodeId);
      if (!target) continue;
      answered.add(obs.nodeId);
      // `updatedAt` stripped — see the header: this pass never advances it.
      const diff = await applyPrLiveness(accountId, target, { ...obs, updatedAt: null });
      if (diff?.movedOnBoard) out.changed += 1;
      const unsettled = unsettledAfterRead(target, obs);
      // A literal UNKNOWN is GitHub computing: worth the one quick second read.
      if (
        obs.state === 'open' &&
        (obs.mergeable === 'unknown' || obs.mergeStateStatus === 'unknown')
      ) {
        out.stillUnknown += 1;
      }
      noteUnknownAnswer(accountId, repoId, target.prId, unsettled);
    }
    // A PR asked about but not ANSWERED (a node the token cannot see, or one refused after a
    // partial error) is still unsettled — it builds the same streak, so it cannot be re-asked on
    // every walk. Not when the read was abandoned for a rate limit: nothing was answered then.
    if (!out.paused) {
      for (const t of targets) {
        if (!answered.has(t.githubNodeId)) noteUnknownAnswer(accountId, repoId, t.prId, true);
      }
    }
    if (out.changed > 0) notePrChanged(accountId, repoId);
    return out;
  } catch (err) {
    log.warn(`merge-state recheck repo ${repoId} failed (non-fatal): ${errMsg(err)}`);
    // Back the BACKSTOP off this repo (the trunk-moved recheck is per merge and bounded already):
    // a gateway that 502s the merge-state batch will 502 it again on the next walk.
    if (mode === 'unsettled') noteFailedRead(key);
    return out;
  } finally {
    recheckInFlight.delete(key);
  }
}

// Background re-reads this module started off a timer — tracked only so a test can await them
// deterministically (`__unsettledPrsDrain`). Every tracked promise is one that never rejects.
const backgroundWork = new Set<Promise<unknown>>();
function track(p: Promise<unknown>): void {
  backgroundWork.add(p);
  void p.finally(() => backgroundWork.delete(p));
}

// ── The per-walk backstop ────────────────────────────────────────────────────────────────────

// One pending second read per repo; a later walk's backstop simply replaces it.
const secondReads = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSecondRead(accountId: number, repoId: number, log: Logger): void {
  const key = repoKey(accountId, repoId);
  const existing = secondReads.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    secondReads.delete(key);
    track(recheckRepoMergeStates({ accountId, repoId, log, mode: 'unsettled' }));
  }, SECOND_READ_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  secondReads.set(key, timer);
}

// prId-keyed (`account:pr`) → when this PR was last nudged for stale CI. Bounded FIFO.
const ciNudgedAt = new Map<string, number>();

/**
 * Hand at most 5 of the repo's stale CI-`pending` PRs to the settle ladder. "Stale" = the PR's
 * latest `ci_status_events` observation (a transition log: written only when the status or head
 * CHANGES) is older than 20 minutes, i.e. the walk has seen nothing new since. Returns how many
 * were nudged. Cheap when there are none: one indexed select, no GitHub call.
 *
 * ⚠ THE LADDER, NOT THE LIVENESS PASS: the liveness selection carries no check rollup, and adding
 * `statusCheckRollup` to it would change its measured point cost. One single-PR sync (~1 point)
 * per nudge, at most 5 per walk, and never the same PR twice inside 20 minutes.
 */
export async function nudgeStaleCiPending(
  accountId: number,
  repoId: number,
  log: Logger,
  now: number = Date.now(),
): Promise<number> {
  const candidates = await db
    .select({ prId: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.isDraft, false),
        eq(pullRequests.ciStatus, 'pending'),
      ),
    )
    .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id))
    .limit(50)
    .execute();
  if (candidates.length === 0) return 0;
  const ids = candidates.map((c) => c.prId);
  const observations = await db
    .select({ prId: ciStatusEvents.prId, observedAt: ciStatusEvents.observedAt })
    .from(ciStatusEvents)
    .where(and(eq(ciStatusEvents.accountId, accountId), inArray(ciStatusEvents.prId, ids)))
    .execute();
  const latest = new Map<number, number>();
  for (const o of observations) {
    const t = o.observedAt.getTime();
    if (t > (latest.get(o.prId) ?? 0)) latest.set(o.prId, t);
  }
  let nudged = 0;
  for (const prId of ids) {
    if (nudged >= CI_NUDGES_PER_WALK) break;
    // No observation at all (a row older than the transition log) counts as stale.
    const seen = latest.get(prId) ?? 0;
    if (now - seen < CI_STALE_MS) continue;
    const key = `${accountId}:${prId}`;
    const last = ciNudgedAt.get(key);
    if (last != null && now - last < CI_NUDGE_COOLDOWN_MS) continue;
    if (last != null) ciNudgedAt.delete(key);
    else if (ciNudgedAt.size >= CI_NUDGE_MAX) {
      const oldest = ciNudgedAt.keys().next().value;
      if (oldest !== undefined) ciNudgedAt.delete(oldest);
    }
    ciNudgedAt.set(key, now);
    schedulePrSettle(accountId, prId, log);
    nudged += 1;
  }
  return nudged;
}

/**
 * The per-walk backstop. Called fire-and-forget after every successful repo walk (the scheduled
 * loop and the manual `runSyncForRepo` tail); NEVER THROWS and never holds the walk's slot.
 */
export async function runUnsettledPrBackstop(args: {
  accountId: number;
  repoId: number;
  log: Logger;
}): Promise<void> {
  const { accountId, repoId, log } = args;
  try {
    if (isLimited(accountId)) return;
    const r = await recheckRepoMergeStates({ accountId, repoId, log, mode: 'unsettled' });
    if (r.stillUnknown > 0 && !r.paused) scheduleSecondRead(accountId, repoId, log);
    if (r.checked > 0) {
      log.info(
        `unsettled-PR backstop repo ${repoId}: re-read ${r.checked}, ${r.changed} moved, ${r.stillUnknown} still computing`,
      );
    }
    if (isLimited(accountId)) return;
    await nudgeStaleCiPending(accountId, repoId, log);
  } catch (err) {
    log.warn(`unsettled-PR backstop repo ${repoId} failed (non-fatal): ${errMsg(err)}`);
  }
}

// ── After a merge lands: the trunk moved ────────────────────────────────────────────────────

const trunkTimers = new Map<string, Array<ReturnType<typeof setTimeout>>>();

function clearTrunkTimers(key: string): void {
  for (const t of trunkTimers.get(key) ?? []) clearTimeout(t);
  trunkTimers.delete(key);
}

/**
 * Re-read the repo's open PRs' merge state ~30s and ~90s from now. A burst of merges on one repo
 * coalesces: each call restarts both timers, so the reads land after the LAST merge. Timers are
 * unref'd; never throws.
 */
export function scheduleTrunkMovedRecheck(accountId: number, repoId: number, log: Logger): void {
  try {
    const key = repoKey(accountId, repoId);
    if (trunkTimers.has(key)) clearTrunkTimers(key);
    else if (trunkTimers.size >= TRUNK_TIMERS_MAX) {
      const oldest = trunkTimers.keys().next().value;
      if (oldest !== undefined) clearTrunkTimers(oldest);
    }
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    TRUNK_RECHECK_OFFSETS_MS.forEach((offset, i) => {
      const t = setTimeout(() => {
        // The last timer releases the key, so the map never holds a finished entry.
        if (i === TRUNK_RECHECK_OFFSETS_MS.length - 1 && trunkTimers.get(key) === timers) {
          trunkTimers.delete(key);
        }
        track(recheckRepoMergeStates({ accountId, repoId, log, mode: 'open' }));
      }, offset);
      if (typeof t.unref === 'function') t.unref();
      timers.push(t);
    });
    trunkTimers.set(key, timers);
  } catch (err) {
    log.warn(`trunk-moved recheck repo ${repoId}: could not schedule: ${errMsg(err)}`);
  }
}

/**
 * The tail of every merge WE landed (the merge route, the auto-merge runner's direct and queue
 * landings): raise the SPA change signal for the repo — the local `markPrMergedLocally` stamp is
 * itself a board-visible move — and schedule the trunk-moved recheck. The repo resolves through
 * the ACCOUNT-SCOPED settle-facts read. Never throws, never rejects.
 *
 * The returned promise settles once the signal is RAISED (one DB read; the recheck itself only
 * arms timers). A ROUTE awaits it before replying, so the write's own ordered `['repos']` read
 * covers the stamp (sync/pr-settle.ts `notePrChangedForPrs`); a background caller may drop it.
 */
export function noteMergeLanded(accountId: number, prId: number, log: Logger): Promise<void> {
  const work = (async () => {
    try {
      const facts = await getPrSettleFacts(prId, accountId);
      if (!facts) return;
      notePrChanged(accountId, facts.repoId);
      scheduleTrunkMovedRecheck(accountId, facts.repoId, log);
    } catch (err) {
      log.warn(`merge-landed follow-up for PR ${prId} failed (non-fatal): ${errMsg(err)}`);
    }
  })();
  track(work);
  return work;
}

/** Test-only: resolve once every background re-read already started has finished. */
export async function __unsettledPrsDrain(): Promise<void> {
  while (backgroundWork.size > 0) await Promise.all([...backgroundWork]);
}

/** Test-only: clear every timer and in-memory claim. */
export function __resetUnsettledPrs(): void {
  for (const t of secondReads.values()) clearTimeout(t);
  secondReads.clear();
  for (const key of [...trunkTimers.keys()]) clearTrunkTimers(key);
  recheckInFlight.clear();
  ciNudgedAt.clear();
  stuckUnknown.clear();
  failedReadUntil.clear();
}
