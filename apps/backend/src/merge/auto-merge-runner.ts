// ---------------------------------------------------------------------------------------
// The armed-merge watcher — "merge when ready", Pierre-side.
//
// WHY NOT GitHub's own auto-merge: `enablePullRequestAutoMerge` 422s unless the merge
// requirements are ALREADY met (broken since 2026-03-25) and needs repo settings we can't
// assume are on. So arming records an intent in `auto_merge_requests` and this pass
// re-evaluates it on the scheduler tick.
//
// The rules, in order, per armed intent:
//   1. head moved            → state 'disarmed_head_moved', UNLESS the new head is provably the
//                              base-into-head merge this watcher itself asked for (see
//                              `isOurUpdateMerge`). Arming is consent to merge THE CODE THE
//                              USER SAW; a new push is new code they didn't.
//   2. past expiresAt        → 'expired'.
//   3. PR no longer open     → 'disarmed_blocked' (a human merged/closed it — deliberately NOT
//                              'merged', which means "the watcher merged it" and would raise a
//                              false "Limn merged this" toast).
//   4. retargeted base       → 'disarmed_blocked'. The head pin cannot see a retarget (PATCH
//                              pulls/{n} with a new `base` leaves head.sha alone), so merging
//                              would land the change in a branch nobody consented to.
//   5. behind + a strategy   → bring it current and wait a tick. The head is NOT re-pinned here
//                              (rule 1 does that once the move is proven ours).
//   6. blocked / conflicts   → KEEP WAITING, recording `lastReason`. A blocked PR unblocks on
//                              its own (checks finish, the review lands); that is the entire
//                              value of arming. Only the head-moved case disarms.
//   7. clean / unstable      → re-read the intent (the user may have hit Cancel mid-tick) and
//                              merge. ('unstable' = non-required checks red; GitHub merges it.)
//
// MERGE-QUEUE repos (`viaMergeQueue`, stamped at arm time, re-verified live each tick): the
// terminal action replaces rule 7's direct merge — GitHub refuses PUT .../merge on a
// queue-protected branch. Rules 1–5 apply unchanged (freshen BEFORE the first enqueue, never
// after — a branch update kicks the entry out of the queue), then: enqueue once required
// reviews are satisfied (head-pinned, CAS-guarded, `enqueuedAt` stamped); while queued, wait;
// queue-merged with OUR entry live → 'merged' (the toast is truthful); queued/dequeued/merged
// by anyone else → 'disarmed_blocked'. A queue disabled since arming falls back to the
// direct merge.
//
// Isolation: every intent is acted on with ITS OWN account's token (`getAccessToken`), and
// each account's work is wrapped in its own try/catch so one bad token can't abort the loop.
// The scan is bounded per tick so a big backlog is drained over several ticks rather than
// turning one tick into an unbounded burst of GitHub traffic.
// ---------------------------------------------------------------------------------------

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getAccessToken, getAccountUserId } from '../auth/account.js';
import {
  getAutoMergeRequest,
  listArmedMergeRequestsForRunner,
  markPrMergedLocally,
  updateAutoMergeState,
  WRITE_PERMISSIONS,
  type ArmedMergeWork,
} from '../db/queries.js';
import {
  enqueuePullRequestOnQueue,
  fetchCommitParents,
  fetchMergeQueueState,
  fetchPrMergeSnapshot,
  isCommitContainedInRef,
  mergePullRequest,
  updatePullRequestBranch,
  type MergeQueueState,
  type PrMergeSnapshot,
} from '../github/mutations.js';

// Cron for the watcher. NOT in `config` on purpose: it is not a deployment knob (the whole
// feature is "it lands within a couple of minutes of going green"), and a misconfigured value
// here would silently either hammer GitHub or make arming feel broken.
export const AUTO_MERGE_CRON = '*/2 * * * *';

// Bound one tick. Each intent costs 1–3 GitHub calls, so this is the ceiling on a tick's
// GitHub traffic; the scan is LEAST-RECENTLY-CHECKED first (see
// `listArmedMergeRequestsForRunner`), so a backlog bigger than this rotates instead of the
// same oldest rows being re-picked forever.
const MAX_INTENTS_PER_TICK = 25;

// Consecutive GitHub failures before an intent is given up on. Kept in memory (process-local):
// a restart resets the count, which errs towards retrying rather than towards a silently dead
// intent — the right way round for something the user is waiting on.
const MAX_CONSECUTIVE_FAILURES = 3;
const failureCounts = new Map<number, number>();

// Intents whose branch we asked GitHub to update from the base, keyed by intent id, holding the
// head SHA the update was issued AGAINST. GitHub's update-branch returns 202 ACCEPTED and does
// the merge asynchronously with no handle to poll, so the head move lands some time later — on
// a later tick. Process-local like `failureCounts`: losing it on a restart just means the (by
// then unexplained) head move disarms the intent, which is the safe direction.
interface PendingUpdate {
  fromSha: string;
  at: number;
}
const pendingUpdates = new Map<number, PendingUpdate>();

// How long an issued update stays acceptable as the explanation for a head move. Past this the
// move is treated as a human push. GitHub finishes an update-branch in seconds; a generous
// window costs nothing and a stale one is exactly the hole we're closing.
const PENDING_UPDATE_TTL_MS = 15 * 60 * 1000;

// Intents already freshened once from the base at the user's request. `behindBy > 0` is true of
// almost every healthy PR (any trunk commit since the branch point), so freshening on it every
// tick would push a merge commit — and a CI run — every two minutes for the intent's whole
// 72-hour life. Once is what "update before merging" means.
const freshenedIntents = new Set<number>();

function forgetIntent(id: number): void {
  failureCounts.delete(id);
  pendingUpdates.delete(id);
  freshenedIntents.delete(id);
}

// One tick at a time. A slow tick (a big backlog, a slow clone-based rebase) must not overlap
// the next one and double-attempt the same merge.
let running = false;

// The synced CI states that mean "the checks haven't finished". Used for exactly one thing:
// naming the phase behind GitHub's `mergeableState: 'blocked'`, which collapses "required
// checks still running" and "required reviews missing" into one word with nothing on the same
// payload to separate them. Reading the ALREADY-SYNCED status keeps that free — this path runs
// for every intent on every tick — and it never gates anything; GitHub is still the authority.
const CHECKS_PENDING = new Set(['pending', 'expected']);

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Terminal-state helper: resolve an intent and drop all of its process-local bookkeeping.
 *
 * `phase` is CLEARED here, always: it describes a live intent, and every terminal outcome is
 * already a `state` member. Leaving the last live phase behind would give a finished card two
 * sources of truth that disagree ('merging' under a 'disarmed_head_moved' row).
 */
async function resolve(
  id: number,
  state: 'merged' | 'disarmed_head_moved' | 'disarmed_blocked' | 'expired' | 'failed',
  reason: string | null,
): Promise<void> {
  forgetIntent(id);
  await updateAutoMergeState(id, { state, lastReason: reason, phase: null });
}

/**
 * Is this head move the base-into-head merge WE asked GitHub for, rather than a human push?
 *
 * Proof, all three parts required:
 *   • we issued an update for this intent, recently, against exactly the pinned head;
 *   • the new head is a TWO-parent commit whose FIRST parent is that pinned head (a human
 *     commit on top of the branch also has the old head as a parent, so the parent check alone
 *     proves nothing — the arity is what separates "merged into" from "pushed onto");
 *   • the SECOND parent is contained in the base branch, i.e. what got merged in really is the
 *     base and not some other branch the author merged themselves.
 *
 * Anything unproven (including a compare we couldn't run) is a NO: the whole point of the head
 * pin is that unexplained code never merges.
 */
async function isOurUpdateMerge(
  work: ArmedMergeWork,
  token: string,
  snap: PrMergeSnapshot,
  pinnedOid: string,
): Promise<boolean> {
  const pending = pendingUpdates.get(work.id);
  if (!pending) return false;
  if (pending.fromSha !== pinnedOid) return false;
  if (Date.now() - pending.at > PENDING_UPDATE_TTL_MS) return false;

  const parents = await fetchCommitParents(token, work.owner, work.name, snap.headSha);
  if (parents.length !== 2 || parents[0] !== pinnedOid) return false;
  const contained = await isCommitContainedInRef(
    token,
    work.owner,
    work.name,
    snap.baseRef,
    parents[1]!,
  );
  return contained === true;
}

/**
 * Merge-queue intents, part 1: settle an intent whose PR is already through (or in, or thrown
 * out of) the queue. Returns true when the tick is done with this intent; false only when the
 * PR is simply not in the queue and we never put it there — the caller then walks the shared
 * conflicts/freshen gates and, once current, attempts the enqueue.
 *
 * Attribution rides `enqueuedAt`: a merge observed while OUR entry was live is the watcher's
 * own landing ('merged' — the toast fires); a queue entry a human created supersedes the
 * intent instead ('disarmed_blocked' — landing is already arranged, and 'merged' would claim
 * credit for it).
 */
async function settleQueuedIntent(
  work: ArmedMergeWork,
  queue: MergeQueueState,
  log: FastifyBaseLogger,
): Promise<boolean> {
  // The LIVE PR state, not the synced one: a fast queue can merge within a tick, and the
  // synced row lags until the next sync observes it.
  if (queue.prState === 'MERGED') {
    if (work.enqueuedAt != null) {
      forgetIntent(work.id);
      // Stamp locally exactly like the direct-merge landing, so the SPA reflects it before
      // the next sync; attribution is corrected by the sync if the queue merged as another
      // actor.
      const viewerUserId = await getAccountUserId(work.accountId);
      await markPrMergedLocally(work.prId, work.accountId, viewerUserId);
      await updateAutoMergeState(work.id, { state: 'merged', lastReason: null, phase: null });
      log.info(
        { prId: work.prId, repo: `${work.owner}/${work.name}`, number: work.number },
        'auto-merge landed via the merge queue',
      );
    } else {
      await resolve(work.id, 'disarmed_blocked', 'the PR was merged outside auto-merge');
    }
    return true;
  }
  if (queue.prState === 'CLOSED') {
    await resolve(work.id, 'disarmed_blocked', 'the PR was closed outside auto-merge');
    return true;
  }

  if (queue.inQueue) {
    if (work.enqueuedAt != null) {
      // The steady state: our entry is in the queue, the queue is doing its job.
      await updateAutoMergeState(work.id, {
        lastReason:
          queue.position != null
            ? `in the merge queue (position ${queue.position})`
            : 'in the merge queue',
        phase: 'queued',
      });
    } else {
      await resolve(
        work.id,
        'disarmed_blocked',
        'the PR was added to the merge queue outside auto-merge',
      );
    }
    return true;
  }

  // We enqueued it and it is no longer in the queue (and not merged): the queue rejected the
  // entry (UNMERGEABLE) or a human dequeued it. Re-enqueueing would fight that decision —
  // surface it and stand down instead.
  if (work.enqueuedAt != null) {
    await resolve(
      work.id,
      'disarmed_blocked',
      'the PR was removed from the merge queue — re-arm to queue it again',
    );
    return true;
  }

  return false;
}

/**
 * Merge-queue intents, part 2: the PR is current and not queued — add it to the queue once
 * the review half of branch protection is satisfied. Checks do NOT gate entry
 * (AWAITING_CHECKS is a normal entry state; the queue runs them itself), so waiting on
 * `reviewDecision` by name is both the correct green light and more honest than hammering
 * the mutation for its error string.
 *
 * The enqueue itself carries the SAME consent anchor as the direct merge: the head pin rides
 * into the mutation (`expectedHeadOid`), so GitHub rejects it if the branch moved after our
 * snapshot — and a rejection throws to the caller's strike counter, exactly like a failed
 * merge (transient errors retry; a persistent refusal fails the intent with GitHub's own
 * message).
 */
async function enqueueWhenReady(
  work: ArmedMergeWork,
  queue: MergeQueueState,
  token: string,
  pinnedOid: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (queue.reviewDecision === 'REVIEW_REQUIRED' || queue.reviewDecision === 'CHANGES_REQUESTED') {
    await updateAutoMergeState(work.id, {
      lastReason:
        queue.reviewDecision === 'REVIEW_REQUIRED'
          ? 'waiting: required reviews aren’t in yet'
          : 'waiting: a reviewer requested changes',
      phase: 'awaiting_review',
    });
    return;
  }

  // COMPARE-AND-SET immediately before the enqueue, exactly like the direct merge: a Cancel
  // mid-tick DELETED the row, and enqueueing anyway would land a PR the user called off.
  const live = await getAutoMergeRequest(work.accountId, work.prId);
  if (
    !live ||
    live.state !== 'armed' ||
    live.expectedHeadOid !== pinnedOid ||
    live.mergeMethod !== work.mergeMethod
  ) {
    forgetIntent(work.id);
    log.info(
      { prId: work.prId, repo: `${work.owner}/${work.name}`, number: work.number },
      'auto-merge: the intent changed while the tick was running; not enqueueing',
    );
    return;
  }

  // Stamped BEFORE the mutation for the same reason the direct merge stamps 'merging': the
  // enqueue can throw (or hang), and a row that reads 'awaiting_review' while we are in fact
  // enqueueing is a lie the user acts on. `lastReason` is deliberately left alone — this is the
  // machine field only, and the prose belongs to the outcome.
  await updateAutoMergeState(work.id, { phase: 'enqueuing' });
  const entry = await enqueuePullRequestOnQueue(token, work.prNodeId, pinnedOid);
  await updateAutoMergeState(work.id, {
    enqueuedAt: new Date(),
    lastReason:
      entry.position != null
        ? `added to the merge queue (position ${entry.position})`
        : 'added to the merge queue',
    phase: 'queued',
  });
  log.info(
    { prId: work.prId, repo: `${work.owner}/${work.name}`, number: work.number },
    'auto-merge: added the PR to the merge queue',
  );
}

/**
 * Evaluate ONE armed intent. Returns nothing — every outcome is recorded on the row. Throws
 * only on an unexpected GitHub/network error, which the caller converts into a failure strike.
 */
async function processOne(
  work: ArmedMergeWork,
  token: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const now = Date.now();

  if (work.expiresAt.getTime() <= now) {
    await resolve(work.id, 'expired', 'the 72-hour window passed without the PR becoming mergeable');
    return;
  }

  // A merge/close that happened outside Pierre (or was synced after arming). One carve-out:
  // a merge observed while OUR queue entry was live is the watcher's own landing (the queue
  // merges asynchronously, and the sync can observe it before the next tick does) — that is
  // 'merged', so the toast fires, not "outside auto-merge".
  if (work.prState !== 'open') {
    if (work.prState === 'merged' && work.viaMergeQueue && work.enqueuedAt != null) {
      await resolve(work.id, 'merged', null);
      log.info(
        { prId: work.prId, repo: `${work.owner}/${work.name}`, number: work.number },
        'auto-merge landed via the merge queue',
      );
      return;
    }
    await resolve(
      work.id,
      'disarmed_blocked',
      `the PR was ${work.prState} outside auto-merge`,
    );
    return;
  }

  // Permission is re-checked at LAND time, not just at arm time: access can be revoked
  // between the two, and the watcher must never act on a stale grant. This reads the synced
  // repo permission (refreshed every sync); GitHub itself is the final authority and would
  // reject the merge anyway.
  if (!WRITE_PERMISSIONS.has(work.viewerPermission ?? '')) {
    await resolve(
      work.id,
      'disarmed_blocked',
      'this account no longer has write access to the repository',
    );
    return;
  }

  // ONE `GET /pulls/{n}` for both the head and the mergeability: they are non-overlapping
  // fields of the same payload, and this runs for every intent on every tick.
  const m = await fetchPrMergeSnapshot(token, work.owner, work.name, work.number);

  let pinnedOid = work.expectedHeadOid;
  if (m.headSha !== pinnedOid) {
    if (!(await isOurUpdateMerge(work, token, m, pinnedOid))) {
      await resolve(
        work.id,
        'disarmed_head_moved',
        `the branch moved (${short(pinnedOid)} → ${short(m.headSha)}) — re-arm to merge the new code`,
      );
      return;
    }
    // Our own update landed: re-pin to it (this is the ONLY sanctioned re-pin) and give the
    // new head a tick for its checks to be queued before reading mergeability again.
    pendingUpdates.delete(work.id);
    pinnedOid = m.headSha;
    await updateAutoMergeState(work.id, {
      expectedHeadOid: pinnedOid,
      lastReason: `merged ${m.baseRef} in — waiting for checks`,
      phase: 'awaiting_checks',
    });
    return;
  }

  // The second consent anchor. A retarget (PATCH pulls/{n} with a new `base`) does NOT move
  // head.sha, so the pin above is blind to it — without this the watcher would happily land
  // the PR in a branch the user never chose. Consent is established by the base the SPA was
  // showing when they armed, i.e. the last SYNCED base ref; see the report on
  // `expected_base_ref`, which is the column that would make this exact.
  if (work.syncedBaseRef == null) {
    await updateAutoMergeState(work.id, {
      lastReason:
        'waiting: can’t confirm which branch this PR targets — re-sync the repository, then re-arm',
      // No phase member describes this, and inventing the nearest one would put a wrong label
      // on a row the user has to act on. Null hands the card back to `lastReason`.
      phase: null,
    });
    return;
  }
  if (work.syncedBaseRef !== m.baseRef) {
    await resolve(
      work.id,
      'disarmed_blocked',
      `the PR was retargeted (${work.syncedBaseRef} → ${m.baseRef}) — re-arm to merge into the new base`,
    );
    return;
  }

  // ---- The merge-queue fork, part 1: where does the intent stand with the queue? --------
  // Queue intents fork BEFORE the freshen gates, because a PR already sitting in the queue
  // (or just merged by it) must never be freshened — a branch update moves the head, which
  // kicks the entry out of the queue. The state is re-read LIVE each tick (one GraphQL
  // point, paid only by queue intents): a queue disabled since arming makes the direct
  // merge below the right verb again, so `queue` drops back to null and nothing here runs.
  let queue: MergeQueueState | null = null;
  if (work.viaMergeQueue) {
    queue = await fetchMergeQueueState(token, work.owner, work.name, work.number);
    if (queue && queue.enabled) {
      if (await settleQueuedIntent(work, queue, log)) return;
    } else {
      queue = null;
    }
  }

  const conflicts = m.mergeable === false || m.mergeableState === 'dirty';
  // GitHub's 'behind' merge state is the only thing that BLOCKS a merge — it appears when the
  // base requires strictly-up-to-date branches. `behindBy` comes from an independent
  // `GET /compare` and is > 0 for any branch whose trunk moved since the branch point, which
  // is most healthy PRs; treating it as a blocker parked every clean armed PR forever. It is
  // only a hint that the branch COULD be freshened, honoured once when the user asked for it.
  const blockedByBehind = m.mergeableState === 'behind';
  const couldFreshen =
    m.behindBy > 0 && work.updateStrategy !== 'none' && !freshenedIntents.has(work.id);
  const behind = blockedByBehind || couldFreshen;

  if (conflicts) {
    // Keep waiting: a conflict is usually cleared by the author pushing a fix — which moves
    // the head, which disarms us on the next tick with a clear reason. Either way the user
    // finds out from the row, not from a surprise merge.
    await updateAutoMergeState(work.id, {
      lastReason: `waiting: conflicts with ${m.baseRef}`,
      phase: 'waiting_conflicts',
    });
    return;
  }

  if (behind) {
    if (work.updateStrategy === 'none') {
      await updateAutoMergeState(work.id, {
        lastReason: `waiting: ${m.behindBy || 'some'} commit(s) behind ${m.baseRef}`,
        phase: 'waiting_behind',
      });
      return;
    }
    // Bring the branch current and let a LATER tick re-evaluate against fresh CI.
    // A clone-based rebase is local-only (config.canRebaseUpdate === !isCloud); in cloud we
    // fall back to GitHub's native merge-in, which is the only clone-free option.
    if (work.updateStrategy === 'rebase' && !config.isCloud) {
      const { updatePrBranchFromTrunk } = await import('../coding/merge.js');
      // Stamped BEFORE the call, for the same reason 'merging' and 'enqueuing' are: the
      // clone-based rebase (clone, fetch, rebase, force-push) runs for tens of seconds while the
      // SPA re-reads this row every 8s, and this is the ONLY window in which "Rebasing onto the
      // base branch…" is true. `lastReason` is deliberately left alone — the machine field only.
      // A throw lands on the strike counter, which stamps 'retrying', so the phase can't stick.
      await updateAutoMergeState(work.id, { phase: 'updating_rebase' });
      const out = await updatePrBranchFromTrunk({
        accountId: work.accountId,
        owner: work.owner,
        name: work.name,
        prNumber: work.number,
        headRef: m.headRef,
        headSha: m.headSha,
        trunk: m.baseRef,
        strategy: 'rebase',
      });
      // The rebase is SYNCHRONOUS and returns the sha it pushed, so re-pinning to that exact
      // value adopts nothing we didn't produce — unlike the native update below.
      // ⚠ And because it has already RETURNED, the phase moves off 'updating_rebase' in the same
      // write as the prose: nothing is in flight any more, only the new head's checks. Leaving
      // 'updating_rebase' here spun "Rebasing onto the base branch…" (a WORKING_PHASE) for the
      // rest of the cron interval over a row whose own `lastReason` said it was waiting for
      // checks — phase and prose contradicting each other is the one thing this column exists to
      // prevent. Same shape as the native update's re-pin above, whose prose is the twin of this.
      freshenedIntents.add(work.id);
      await updateAutoMergeState(work.id, {
        expectedHeadOid: out.headSha,
        lastReason: `rebased onto ${m.baseRef} — waiting for checks`,
        phase: 'awaiting_checks',
      });
      return;
    }
    const upd = await updatePullRequestBranch(
      token,
      work.owner,
      work.name,
      work.number,
      pinnedOid,
    );
    if (!upd.ok) {
      await updateAutoMergeState(work.id, {
        lastReason: `waiting: couldn’t update from ${m.baseRef} (${upd.message})`,
        // The update was refused, so the branch is still exactly where it was: behind.
        phase: 'waiting_behind',
      });
      return;
    }
    // 202 ACCEPTED. GitHub performs the base-into-head merge ASYNCHRONOUSLY and hands back no
    // handle to poll, so re-reading the head here and re-pinning to whatever we find would
    // adopt a human's concurrent push as consented-to code — the exact thing the pin exists to
    // prevent. Record what we asked for instead; a later tick re-pins only once the new head
    // is PROVEN to be our merge commit (`isOurUpdateMerge`).
    pendingUpdates.set(work.id, { fromSha: pinnedOid, at: Date.now() });
    freshenedIntents.add(work.id);
    await updateAutoMergeState(work.id, {
      lastReason: `merging ${m.baseRef} in — waiting for GitHub to finish the update`,
      phase: 'updating_merge',
    });
    return;
  }

  // ---- The merge-queue fork, part 2: current, not queued yet — enqueue when ready. ------
  // Past the conflicts + freshen gates the queue intent's terminal action replaces the
  // direct merge entirely: GitHub refuses PUT .../merge on a queue-protected branch, and
  // the green light is different too — the queue runs the checks itself, so only the REVIEW
  // half of branch protection gates entry.
  if (queue) {
    await enqueueWhenReady(work, queue, token, pinnedOid, log);
    return;
  }

  if (m.mergeableState === 'blocked') {
    await updateAutoMergeState(work.id, {
      lastReason: 'waiting: branch protection not satisfied (required reviews or checks)',
      // 'blocked' is GitHub's word for BOTH "the required checks are still running" and "the
      // required reviews are missing", and nothing else on that payload separates them. The
      // synced head CI status is the free tiebreak (no extra fetch on a per-intent-per-tick
      // path); anything short of it actively saying "still running" stays the honest generic.
      phase: CHECKS_PENDING.has(work.syncedCiStatus ?? '')
        ? 'awaiting_checks'
        : 'blocked_protection',
    });
    return;
  }

  // Anything that isn't clean / has_hooks / unstable is not a green light. 'unknown' in
  // particular means GitHub is still computing — waiting is the only safe reading.
  if (!['clean', 'has_hooks', 'unstable'].includes(m.mergeableState)) {
    await updateAutoMergeState(work.id, {
      lastReason: `waiting: merge state "${m.mergeableState}"`,
      // Deliberately unlabelled: this branch exists precisely because we do NOT know what the
      // state means. `lastReason` names it verbatim, which is all we can honestly say.
      phase: null,
    });
    return;
  }

  // COMPARE-AND-SET, immediately before the irreversible bit. Everything above acts on the
  // snapshot the scan took, which can be minutes old by now: a user who hit "Cancel auto-merge"
  // mid-tick DELETED this row, and merging anyway would leave the UI saying "cancelled" for a
  // PR that landed. Re-read and only proceed if the intent is still exactly what we evaluated.
  const live = await getAutoMergeRequest(work.accountId, work.prId);
  if (
    !live ||
    live.state !== 'armed' ||
    live.expectedHeadOid !== pinnedOid ||
    live.mergeMethod !== work.mergeMethod
  ) {
    forgetIntent(work.id);
    log.info(
      { prId: work.prId, repo: `${work.owner}/${work.name}`, number: work.number },
      'auto-merge: the intent changed while the tick was running; not merging',
    );
    return;
  }

  // Stamped immediately before the irreversible call. On success `lastReason` is set to NULL
  // (the outcome is the state, not a blocker), so without this the row would say nothing at all
  // at the exact moment the user is watching hardest — and a merge that hangs or throws would
  // leave the last blocker on screen while we were in fact merging.
  await updateAutoMergeState(work.id, { phase: 'merging' });

  const out = await mergePullRequest(token, work.owner, work.name, work.number, {
    method: work.mergeMethod,
    expectedHeadSha: pinnedOid,
  });
  if (out.ok) {
    forgetIntent(work.id);
    // Stamp locally exactly like the interactive merge route, so the SPA reflects the merge
    // before the next sync; then mark the intent merged (what the toast diffs on). The merge
    // is attributed to the ACCOUNT owner — it went out on their token, so GitHub will
    // attribute it to them too on the next sync.
    const viewerUserId = await getAccountUserId(work.accountId);
    await markPrMergedLocally(work.prId, work.accountId, viewerUserId);
    await updateAutoMergeState(work.id, { state: 'merged', lastReason: null, phase: null });
    log.info(
      { prId: work.prId, repo: `${work.owner}/${work.name}`, number: work.number },
      'auto-merge landed',
    );
    return;
  }
  if (out.reason === 'head_moved') {
    await resolve(
      work.id,
      'disarmed_head_moved',
      'the branch moved just before the merge — re-arm to merge the new code',
    );
    return;
  }
  if (out.reason === 'method_disallowed') {
    await resolve(work.id, 'failed', `github: ${out.message}`);
    return;
  }
  // 'not_mergeable' / 'error': treat as transient and keep waiting, but count the strike.
  throw new Error(out.message);
}

/**
 * One watcher pass. Never throws — a failure on one intent is recorded on its row and the
 * loop continues, so a single bad tenant can't stop everyone else's merges.
 */
export async function runAutoMergeTick(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    const work = await listArmedMergeRequestsForRunner(MAX_INTENTS_PER_TICK);
    if (work.length === 0) return;

    // Group by account so each tenant's token is fetched once and one bad token fails only
    // that tenant's intents.
    const byAccount = new Map<number, ArmedMergeWork[]>();
    for (const w of work) {
      const list = byAccount.get(w.accountId);
      if (list) list.push(w);
      else byAccount.set(w.accountId, [w]);
    }

    for (const [accountId, intents] of byAccount) {
      let token: string;
      try {
        token = await getAccessToken(accountId);
      } catch (err) {
        log.warn({ err, accountId }, 'auto-merge: no usable token for account; skipping');
        continue;
      }
      for (const intent of intents) {
        try {
          await processOne(intent, token, log);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const strikes = (failureCounts.get(intent.id) ?? 0) + 1;
          failureCounts.set(intent.id, strikes);
          if (strikes >= MAX_CONSECUTIVE_FAILURES) {
            await resolve(intent.id, 'failed', `github: ${message}`).catch(() => {});
            log.warn(
              { err, prId: intent.prId, accountId },
              'auto-merge: giving up after repeated failures',
            );
          } else {
            await updateAutoMergeState(intent.id, {
              lastReason: `retrying after an error: ${message}`,
              phase: 'retrying',
            }).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'auto-merge tick failed');
  } finally {
    running = false;
  }
}
