// ---------------------------------------------------------------------------------------
// The PER-REPO LANDING ORDER for armed auto-merge intents ("arm five bumps and walk away").
//
// THE BUG THIS EXISTS TO FIX — verified against the pre-change runner, and REAL:
// `merge/auto-merge-runner.ts`'s `freshenedIntents` is a process-local Set with
// once-per-INTENT-LIFETIME semantics (it is only ever cleared by `forgetIntent`, which runs on
// a TERMINAL outcome). Arm five Dependabot PRs on one repo: all five freshen from trunk at
// once, #1 merges, THE TRUNK MOVES, and #2–#5 are out of date again with their one freshen
// already spent. It then failed two ways, depending on how GitHub words the block — a literal
// `mergeableState: 'behind'` freshens THROUGH the mark, so the batch churned N(N+1)/2 branch
// updates and CI runs; a repo reporting 'blocked' while `behindBy > 0` goes through the gated
// `couldFreshen` path instead, and those intents sat at their blocker until the 72-hour expiry.
// Batch arming was BROKEN, not merely slow.
//
// The fix has two halves and both live here in outline:
//   • exactly ONE intent per (accountId, repoId) holds the SLOT, in `armedAt` order — the order
//     the user clicked — so the repo lands its batch one PR at a time; and
//   • a landing clears the freshen marks of that repo's other armed intents (the runner does
//     it, off `siblingIds` below), which turns freshening from once-per-LIFETIME into
//     once-per-TURN: N branch updates and N CI runs for N PRs, not N² and not zero.
//
// WHY THIS IS ITS OWN FILE, and not a query in queries.ts: `listArmedMergeRequestsForRunner` is
// LIMITed to one tick's GitHub budget (25 rows, least-recently-checked first). A queue POSITION
// cannot be computed from a partial scan — "2nd of 5" is a fact about all five rows, and the
// page the runner is working may hold three of them. So the order rides its own, deliberately
// tiny, UNLIMITED read: five scalar columns, no GitHub, and one join that only resolves a PR to
// its repo.
//
// ⚠ THE GROUPING KEY IS `(accountId, repoId)`, NEVER `repoId` alone. Two accounts can track the
// same repo (that is why every GitHub-node-id unique in this schema is composite), and a
// repoId-keyed group would serialise one tenant's landings behind another's — a cross-tenant
// side channel as well as a bug.
//
// ⚠ `viaMergeQueue` INTENTS ARE EXCLUDED FROM THE FIFO — but the exclusion follows the LIVE
// QUEUE VERDICT, NEVER the stored flag. GitHub's merge queue already serialises them; a second
// queue in front of it would halve throughput for nothing, so a genuinely queued intent gets a
// slot that always holds (`position`/`depth` null — the wire fields stay absent, see
// `withArmedQueueFields`). ⚠ But the runner RE-VERIFIES the queue live on every tick and falls
// back to a DIRECT merge when it finds the queue disabled since arming — and a direct merger
// exempt from the direct FIFO is a repo landing two PRs in one tick, which is the exact thrash
// this file exists to prevent. So the runner marks those ids (`ArmedQueueMarks.queueDisabled`)
// and the fold puts them back in the FIFO where their landing verb now belongs.
// ---------------------------------------------------------------------------------------

import { and, asc, eq } from 'drizzle-orm';
import type { ArmedMergeRequest } from '@pierre-review/shared';
import { db, schema } from './client.js';

const { autoMergeRequests, pullRequests } = schema;

/** One armed intent, reduced to just what the FIFO needs. No GitHub, no prose, no mergeability. */
export interface ArmedIntentOrderRow {
  /** `auto_merge_requests.id` — the runner's handle on an intent, and the freshen-mark key. */
  id: number;
  accountId: number;
  /** Half of the grouping key. Reached through the PR, since the intent row has no repoId. */
  repoId: number;
  /** The WIRE payload's only handle on an intent — `ArmedMergeRequest` carries no intent id. */
  prId: number;
  armedAt: Date;
  viaMergeQueue: boolean;
}

/**
 * Every ARMED intent's place in the FIFO, unbounded.
 *
 * `accountId` null means EVERY account — the auto-merge watcher's own cross-tenant scan, the
 * same sanctioned exception `listArmedMergeRequestsForRunner` is. Every other caller passes a
 * real id: a per-request path must never pay for, or see, another tenant's rows.
 *
 * Ordered `armedAt ASC, id ASC`. ⚠ The id tiebreak is LOAD-BEARING, not decoration: sqlite
 * stores these timestamps as unix SECONDS, so arming five PRs from one click-through gives all
 * five the SAME `armedAt` — and the autoincrement id is then the only surviving record of the
 * order the user clicked, which is the order this feature promises to land them in.
 */
export async function listArmedIntentOrder(
  accountId: number | null,
): Promise<ArmedIntentOrderRow[]> {
  const armed = eq(autoMergeRequests.state, 'armed');
  const rows = await db
    .select({
      id: autoMergeRequests.id,
      accountId: autoMergeRequests.accountId,
      repoId: pullRequests.repoId,
      prId: autoMergeRequests.prId,
      armedAt: autoMergeRequests.armedAt,
      viaMergeQueue: autoMergeRequests.viaMergeQueue,
    })
    .from(autoMergeRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, autoMergeRequests.prId))
    .where(
      accountId == null ? armed : and(armed, eq(autoMergeRequests.accountId, accountId)),
    )
    .orderBy(asc(autoMergeRequests.armedAt), asc(autoMergeRequests.id))
    .execute();
  return rows;
}

/**
 * Why an intent stepped aside from the slot. BOTH mean "this PR needs its author, not a turn",
 * and both keep the intent ARMED at its FIFO place — they differ only in the copy the user
 * reads, and in one wire field: `yieldedForFailedChecks` describes exactly the first, and
 * saying "checks failed" over a conflict would send the author to the wrong screen.
 */
export type ArmedYieldReason = 'failed_checks' | 'conflicts';

/**
 * The runner's LIVE observations of GitHub — the facts this fold cannot derive from the rows,
 * because they are not in the database at all.
 *
 * All three are process-local sets owned by `merge/auto-merge-runner.ts` (alongside
 * `failureCounts` / `pendingUpdates` / `freshenedIntents`) and read here through one object so
 * a new mark is a field, not a fourth positional parameter every caller has to re-thread.
 */
export interface ArmedQueueMarks {
  /** Slot-holders whose REQUIRED CHECKS failed on a live rollup read: they stepped aside. */
  readonly yieldedForFailedChecks: ReadonlySet<number>;
  /**
   * Intents GitHub reports as CONFLICTING. ⚠ They yield too, and the reason they must is the
   * regression this set was added for: a conflicting slot-holder can NEVER be landed by the
   * watcher — the fix is a push, by a human, that may never come — so holding the repo's slot
   * for it parked every other armed PR on that repo for the full 72-hour window.
   */
  readonly yieldedForConflicts: ReadonlySet<number>;
  /**
   * `viaMergeQueue` intents whose queue the runner has LIVE-verified as DISABLED since arming.
   * Their landing verb is now a direct merge, so they belong in the direct FIFO; leaving them
   * exempt let a repo merge two PRs in one tick.
   */
  readonly queueDisabled: ReadonlySet<number>;
}

/** No live observations — the fold's identity element, for callers and tests that have none. */
export const NO_ARMED_QUEUE_MARKS: ArmedQueueMarks = {
  yieldedForFailedChecks: new Set(),
  yieldedForConflicts: new Set(),
  queueDisabled: new Set(),
};

/** Where one armed intent stands in its repo's landing order. */
export interface ArmedQueueSlot {
  /** 1-based place in this repo's armed FIFO. Null for a live `viaMergeQueue` intent — GitHub
   *  owns that order, and inventing a Limn position for it would be a second queue on screen. */
  position: number | null;
  /** How many DIRECT-merge intents this repo has armed. Null for a `viaMergeQueue` intent. */
  depth: number | null;
  /** May this intent freshen / enqueue / merge on this tick? Exactly one direct-merge intent
   *  per (account, repo) holds it; a live `viaMergeQueue` intent always does. */
  holdsSlot: boolean;
  /** Why this intent stepped aside, or null. It KEEPS its FIFO position and stays armed — see
   *  the runner's rule 8. */
  yieldReason: ArmedYieldReason | null;
  /**
   * Is there anyone to yield TO — another DIRECT intent on this repo that has not itself
   * stepped aside? The runner gates its (paid, one GraphQL point) live rollup read on this: a
   * yield that hands the slot to nobody buys nothing, and its copy — "letting the next armed PR
   * through" — is a claim about a PR that does not exist.
   */
  canYield: boolean;
  /** The OTHER armed DIRECT-merge intents on this (accountId, repoId). The runner clears their
   *  freshen marks when this PR lands, because the trunk they were freshened against moved. */
  siblingIds: readonly number[];
}

export interface ArmedQueueIndex {
  byIntentId: Map<number, ArmedQueueSlot>;
  byPrId: Map<number, ArmedQueueSlot>;
}

/**
 * The FIFO, as a pure function of the scan plus the runner's live yield marks — so it is
 * identical whether the runner derives it at the top of a tick or a route derives it to
 * decorate a payload, and so it can be tested without a database.
 *
 * THE SLOT PREDICATE, spelled once. A group is one `(accountId, repoId)`; its DIRECT intents are
 * those that will land by a direct merge — `!viaMergeQueue`, PLUS any whose queue the runner has
 * live-verified as gone (`marks.queueDisabled`) — ordered `armedAt ASC, id ASC`. Then:
 *
 *     the slot-holder is the FIRST direct intent that has not yielded,
 *     or — when every one of them has — the FIRST direct intent, full stop
 *
 * and everyone else waits at `queued_local`. Positions are assigned over the WHOLE group, so a
 * yielded intent keeps its place (1st of 5) while not holding the slot — the moment its blocker
 * clears the mark goes and it is the slot-holder again on the next tick.
 *
 * ⚠ THE ALL-YIELDED FALLBACK IS NOT A LOOPHOLE, it is the fix for a repo going dark. Handing the
 * slot to a yielded intent merges nothing: the runner re-evaluates it against a live snapshot and
 * a PR whose checks failed still reads `blocked`, so it parks on its blocker like any other. What
 * the fallback prevents is the state where NOBODY holds the slot — every row saying "letting the
 * next armed PR through" with no next armed PR, and (at depth 1, after the intent ahead merged)
 * an intent that could never take its own slot back. `canYield` is the other half: with nobody to
 * yield to, the runner does not pay for the rollup read that would re-enter the yield either.
 */
export function buildArmedRepoQueues(
  rows: readonly ArmedIntentOrderRow[],
  marks: ArmedQueueMarks,
): ArmedQueueIndex {
  const byIntentId = new Map<number, ArmedQueueSlot>();
  const byPrId = new Map<number, ArmedQueueSlot>();

  // ⚠ Composite key. See the header: repoId alone would serialise two tenants' landings into
  // one queue on any repo both of them track.
  const groups = new Map<string, ArmedIntentOrderRow[]>();
  for (const row of rows) {
    const key = `${row.accountId}:${row.repoId}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const reasonOf = (id: number): ArmedYieldReason | null =>
    marks.yieldedForFailedChecks.has(id)
      ? 'failed_checks'
      : marks.yieldedForConflicts.has(id)
        ? 'conflicts'
        : null;

  for (const group of groups.values()) {
    // Re-sorted here rather than trusted from the caller: this function is the definition of
    // the order, and a test that hands it rows in any order must get the same answer.
    const direct = group
      // ⚠ The LIVE verdict, not the stored flag: an intent whose merge queue was disabled since
      // arming direct-merges now, so it takes a place in the direct FIFO. See the header.
      .filter((r) => !r.viaMergeQueue || marks.queueDisabled.has(r.id))
      .sort((a, b) => a.armedAt.getTime() - b.armedAt.getTime() || a.id - b.id);
    const directIds = direct.map((r) => r.id);
    const unyielded = direct.filter((r) => reasonOf(r.id) == null);
    // The all-yielded fallback (see the doc comment): there is nobody to hand the slot to, so
    // the first intent keeps it rather than the repo stalling with no holder at all.
    const slotHolderId = (unyielded[0] ?? direct[0])?.id ?? null;

    for (const row of group) {
      const index = directIds.indexOf(row.id);
      const isDirect = index >= 0;
      const slot: ArmedQueueSlot = {
        position: isDirect ? index + 1 : null,
        depth: isDirect ? direct.length : null,
        // A live queue intent is never held back (header, and the shared type's own warning).
        holdsSlot: isDirect ? row.id === slotHolderId : true,
        yieldReason: isDirect ? reasonOf(row.id) : null,
        // Somebody ELSE on this repo could actually take the slot — the only case in which
        // stepping aside means anything.
        canYield: isDirect && unyielded.some((r) => r.id !== row.id),
        // Never includes the intent itself, and never includes a live queue intent: those keep
        // today's "freshen once BEFORE the first enqueue, never while queued" exactly.
        siblingIds: directIds.filter((id) => id !== row.id),
      };
      byIntentId.set(row.id, slot);
      byPrId.set(row.prId, slot);
    }
  }

  return { byIntentId, byPrId };
}

/** The scan + the fold, for a caller that just wants the answer. */
export async function resolveArmedQueues(
  accountId: number | null,
  marks: ArmedQueueMarks,
): Promise<ArmedQueueIndex> {
  return buildArmedRepoQueues(await listArmedIntentOrder(accountId), marks);
}

/**
 * Decorate one wire row with its landing order.
 *
 * The three fields are TRAILING OPTIONALS on `ArmedMergeRequest` and are left ABSENT wherever
 * they would not describe a live direct-merge intent: a terminal row (never in the scan), a
 * `viaMergeQueue` intent (null position), and a false `yieldedForFailedChecks` — a client that
 * has never heard of any of them must render exactly what it did before.
 *
 * ⚠ `yieldedForFailedChecks` is exactly what its name says, so ONLY the `failed_checks` reason
 * writes it. A CONFLICT yield carries its own truthful phase (`waiting_conflicts`) instead;
 * flagging it here would put "checks failed, letting the next PR through" over a PR whose checks
 * are fine, and send its author to the wrong screen.
 */
export function withArmedQueueFields(
  request: ArmedMergeRequest,
  index: ArmedQueueIndex,
): ArmedMergeRequest {
  const slot = index.byPrId.get(request.prId);
  if (!slot || slot.position == null || slot.depth == null) return request;
  return {
    ...request,
    queuePosition: slot.position,
    queueDepth: slot.depth,
    ...(slot.yieldReason === 'failed_checks' ? { yieldedForFailedChecks: true } : {}),
  };
}
