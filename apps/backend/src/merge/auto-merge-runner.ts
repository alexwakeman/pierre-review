// ---------------------------------------------------------------------------------------
// The armed-merge watcher — "merge when ready", Pierre-side.
//
// WHY NOT GitHub's own auto-merge: `enablePullRequestAutoMerge` 422s unless the merge
// requirements are ALREADY met (broken since 2026-03-25) and needs repo settings we can't
// assume are on. So arming records an intent in `auto_merge_requests` and this pass
// re-evaluates it on the scheduler tick.
//
// The rules, in order, per armed intent:
//   1. head moved            → state 'disarmed_head_moved'. Arming is consent to merge THE
//                              CODE THE USER SAW; a new push is new code they didn't.
//   2. past expiresAt        → 'expired'.
//   3. PR no longer open     → 'disarmed_blocked' (a human merged/closed it — deliberately NOT
//                              'merged', which means "the watcher merged it" and would raise a
//                              false "Limn merged this" toast).
//   4. behind + a strategy   → bring it current, RE-PIN the head we just moved, wait a tick.
//   5. blocked / conflicts   → KEEP WAITING, recording `lastReason`. A blocked PR unblocks on
//                              its own (checks finish, the review lands); that is the entire
//                              value of arming. Only the head-moved case disarms.
//   6. clean / unstable      → merge. ('unstable' = non-required checks red; GitHub merges it.)
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
  listArmedMergeRequestsForRunner,
  markPrMergedLocally,
  updateAutoMergeState,
  type ArmedMergeWork,
} from '../db/queries.js';
import {
  fetchMergeability,
  fetchPrHeadInfo,
  mergePullRequest,
  updatePullRequestBranch,
} from '../github/mutations.js';

// Cron for the watcher. NOT in `config` on purpose: it is not a deployment knob (the whole
// feature is "it lands within a couple of minutes of going green"), and a misconfigured value
// here would silently either hammer GitHub or make arming feel broken.
export const AUTO_MERGE_CRON = '*/2 * * * *';

// Bound one tick. Each intent costs 1–3 GitHub calls, so this is the ceiling on a tick's
// GitHub traffic; the scan is oldest-armed-first, so nothing starves.
const MAX_INTENTS_PER_TICK = 25;

// Consecutive GitHub failures before an intent is given up on. Kept in memory (process-local):
// a restart resets the count, which errs towards retrying rather than towards a silently dead
// intent — the right way round for something the user is waiting on.
const MAX_CONSECUTIVE_FAILURES = 3;
const failureCounts = new Map<number, number>();

// One tick at a time. A slow tick (a big backlog, a slow clone-based rebase) must not overlap
// the next one and double-attempt the same merge.
let running = false;

const WRITE_PERMISSIONS = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** Terminal-state helper: resolve an intent and clear its failure count. */
async function resolve(
  id: number,
  state: 'merged' | 'disarmed_head_moved' | 'disarmed_blocked' | 'expired' | 'failed',
  reason: string | null,
): Promise<void> {
  failureCounts.delete(id);
  await updateAutoMergeState(id, { state, lastReason: reason });
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

  const head = await fetchPrHeadInfo(token, work.owner, work.name, work.number);
  if (head.headSha !== work.expectedHeadOid) {
    await resolve(
      work.id,
      'disarmed_head_moved',
      `the branch moved (${short(work.expectedHeadOid)} → ${short(head.headSha)}) — re-arm to merge the new code`,
    );
    return;
  }

  const m = await fetchMergeability(token, work.owner, work.name, work.number);
  const conflicts = m.mergeable === false || m.mergeableState === 'dirty';
  const behind = m.mergeableState === 'behind' || m.behindBy > 0;

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
    // Bring the branch current, then RE-PIN the head we just moved (see updateAutoMergeState's
    // `expectedHeadOid` note) and let the next tick re-evaluate against fresh CI.
    // A clone-based rebase is local-only (config.canRebaseUpdate === !isCloud); in cloud we
    // fall back to GitHub's native merge-in, which is the only clone-free option.
    if (work.updateStrategy === 'rebase' && !config.isCloud) {
      const { updatePrBranchFromTrunk } = await import('../coding/merge.js');
      const out = await updatePrBranchFromTrunk({
        accountId: work.accountId,
        owner: work.owner,
        name: work.name,
        prNumber: work.number,
        headRef: head.headRef,
        headSha: head.headSha,
        trunk: m.baseRef,
        strategy: 'rebase',
      });
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
      head.headSha,
    );
    if (!upd.ok) {
      await updateAutoMergeState(work.id, {
        lastReason: `waiting: couldn’t update from ${m.baseRef} (${upd.message})`,
      });
      return;
    }
    // The native update creates a merge commit, so the head has moved — re-read it and re-pin.
    const after = await fetchPrHeadInfo(token, work.owner, work.name, work.number);
    await updateAutoMergeState(work.id, {
      expectedHeadOid: after.headSha,
      lastReason: `merged ${m.baseRef} in — waiting for checks`,
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

  const out = await mergePullRequest(token, work.owner, work.name, work.number, {
    method: work.mergeMethod,
    expectedHeadSha: head.headSha,
  });
  if (out.ok) {
    failureCounts.delete(work.id);
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
