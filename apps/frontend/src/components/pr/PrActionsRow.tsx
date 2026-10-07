import type { MergeBlockFacts, PrDetail as PrDetailT } from '@pierre-review/shared';
import { useQueryDataUpdatedAt } from '../../hooks/useMergeQueueStatus.js';
import { usePrArmedIntent } from '../../hooks/useAutoMerge.js';
import { ApproveControl } from '../ApproveControl.js';
import { MergeControl } from '../MergeControl.js';
import { MergeWhenReadyControl } from '../MergeWhenReadyControl.js';
import { ClosePrControl } from '../ClosePrControl.js';
import { ReopenPrControl } from '../ReopenPrControl.js';

/**
 * THE ACTIONS ROW — every viewer write action on the PR: approve, merge, "merge when ready",
 * close without merging, reopen. Shared by the Overview tab (ChecksTab) and the top of the Claude
 * Review tab. Each caller supplies its own row chrome; this renders the controls only.
 */

/**
 * The facts the blocked-reason derivation reads. Built here so the Overview's Status row verdict
 * and the two merge controls read the SAME object — before that the controls built their verdict
 * from the live merge-options alone and rendered a worse reason than the line above them.
 *
 * ⚠ THE THREAD COUNT IS `!isResolved`, AND IT IS NOT THE COUNT THE OVERVIEW'S BOTS ROW SHOWS:
 * GitHub's conversation-resolution rule gates on the resolve CLICK, so this population includes
 * `likely_addressed` threads (carried as their own subset).
 */
export function prBlockFacts(pr: PrDetailT): MergeBlockFacts {
  return {
    reviewDecision: pr.reviewDecision,
    ciStatus: pr.ciStatus,
    unresolvedThreads: pr.threads.filter((t) => !t.isResolved).length,
    likelyAddressedThreads: pr.threads.filter(
      (t) => !t.isResolved && t.derivedState === 'likely_addressed',
    ).length,
    requestedReviewers: pr.requestedReviewers.length,
  };
}

/**
 * Whether any control would render. Approve is not state-gated; merge/arm need push + open +
 * non-draft; close needs push OR author + open and HIDES while an auto-merge is armed ("close
 * without merging" and "merge when ready" are opposite promises); reopen is the mirror gate on a
 * closed PR. ⚠ No `armedIntent` condition on reopen: an armed intent and a closed PR are not a live
 * combination (the runner resolves an intent whose PR closed).
 */
export function prActionsVisible(pr: PrDetailT, armed: boolean): boolean {
  return (
    pr.viewerCanApprove ||
    (pr.viewerCanPush && pr.state === 'open' && !pr.isDraft) ||
    (pr.viewerCanClose && pr.state === 'open' && !armed) ||
    (pr.viewerCanReopen && pr.state === 'closed')
  );
}

/** `prActionsVisible` with the armed intent read for the caller (a selector over the polled list). */
export function usePrActionsVisible(pr: PrDetailT): boolean {
  return prActionsVisible(pr, usePrArmedIntent(pr.id) != null);
}

export function PrActionControls({
  pr,
  blockFacts,
}: {
  pr: PrDetailT;
  /** The caller's own facts when it already built them (ChecksTab); else built here. */
  blockFacts?: MergeBlockFacts;
}): JSX.Element {
  // When THIS PR row was read — the merge controls weigh its synced queue membership against their
  // live merge-options answer by age (`mergeQueueStatus`). A cache read, not a second observer.
  const prSyncedAt = useQueryDataUpdatedAt(['pr', pr.id]);
  const armedIntent = usePrArmedIntent(pr.id);
  const facts = blockFacts ?? prBlockFacts(pr);
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      {pr.viewerCanApprove && <ApproveControl prId={pr.id} standing={pr.viewerReviewStanding} />}
      {pr.viewerCanPush && pr.state === 'open' && !pr.isDraft && (
        <>
          <MergeControl
            prId={pr.id}
            githubUrl={pr.githubUrl}
            blockFacts={facts}
            // The synced queue facts, so a queued PR's control is the queue status line +
            // "Remove from queue" from the first paint, collapsed or not — never "Merge ▾".
            inMergeQueue={pr.inMergeQueue}
            mergeQueueEntryState={pr.mergeQueueEntryState}
            syncedAt={prSyncedAt}
            resolverTarget={{
              prId: pr.id,
              repoId: pr.repoId,
              repoFullName: pr.repoFullName,
              prNumber: pr.number,
              prTitle: pr.title,
              githubUrl: pr.githubUrl,
            }}
          />
          <MergeWhenReadyControl
            prId={pr.id}
            blockFacts={facts}
            inMergeQueue={pr.inMergeQueue}
            mergeQueueEntryState={pr.mergeQueueEntryState}
            syncedAt={prSyncedAt}
          />
        </>
      )}
      {pr.viewerCanClose && pr.state === 'open' && armedIntent == null && (
        <ClosePrControl prId={pr.id} />
      )}
      {pr.viewerCanReopen && pr.state === 'closed' && <ReopenPrControl prId={pr.id} />}
    </div>
  );
}
