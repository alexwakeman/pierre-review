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
  type ArmedMergeWork,
} from '../db/queries.js';
import {
  fetchCommitParents,
  fetchPrMergeSnapshot,
  isCommitContainedInRef,
  mergePullRequest,
  updatePullRequestBranch,
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

const WRITE_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** Terminal-state helper: resolve an intent and drop all of its process-local bookkeeping. */
async function resolve(
  id: number,
  state: 'merged' | 'disarmed_head_moved' | 'disarmed_blocked' | 'expired' | 'failed',
  reason: string | null,
): Promise<void> {
  forgetIntent(id);
  await updateAutoMergeState(id, { state, lastReason: reason });
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

  // A merge/close that happened outside Pierre (or was synced after arming).
  if (work.prState !== 'open') {
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
    });
    return;
  }

  if (behind) {
    if (work.updateStrategy === 'none') {
      await updateAutoMergeState(work.id, {
        lastReason: `waiting: ${m.behindBy || 'some'} commit(s) behind ${m.baseRef}`,
      });
      return;
    }
    // Bring the branch current and let a LATER tick re-evaluate against fresh CI.
    // A clone-based rebase is local-only (config.canRebaseUpdate === !isCloud); in cloud we
    // fall back to GitHub's native merge-in, which is the only clone-free option.
    if (work.updateStrategy === 'rebase' && !config.isCloud) {
      const { updatePrBranchFromTrunk } = await import('../coding/merge.js');
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
      freshenedIntents.add(work.id);
      await updateAutoMergeState(work.id, {
        expectedHeadOid: out.headSha,
        lastReason: `rebased onto ${m.baseRef} — waiting for checks`,
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
    });
    return;
  }

  if (m.mergeableState === 'blocked') {
    await updateAutoMergeState(work.id, {
      lastReason: 'waiting: branch protection not satisfied (required reviews or checks)',
    });
    return;
  }

  // Anything that isn't clean / has_hooks / unstable is not a green light. 'unknown' in
  // particular means GitHub is still computing — waiting is the only safe reading.
  if (!['clean', 'has_hooks', 'unstable'].includes(m.mergeableState)) {
    await updateAutoMergeState(work.id, {
      lastReason: `waiting: merge state "${m.mergeableState}"`,
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
    await updateAutoMergeState(work.id, { state: 'merged', lastReason: null });
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
