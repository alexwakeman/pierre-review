import { useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type { MergeBlockFacts, PrDetail as PrDetailT } from '@pierre-review/shared';
import { mergePrMutationKey, updateBranchMutationKey } from '../../hooks/usePrWrites.js';
import { ChevronIcon } from '../Icons.js';
import { useQueryDataUpdatedAt } from '../../hooks/useMergeQueueStatus.js';
import { usePrArmedIntent } from '../../hooks/useAutoMerge.js';
import { ApproveControl } from '../ApproveControl.js';
import { MergeControl } from '../MergeControl.js';
import { MergeWhenReadyControl } from '../MergeWhenReadyControl.js';
import { ClosePrControl } from '../ClosePrControl.js';
import { ReopenPrControl } from '../ReopenPrControl.js';

/**
 * THE ACTIONS ROW — every viewer write action on the PR: approve (and withdraw an approval), merge,
 * "merge when ready", close without merging, reopen. Shared by the Overview tab (ChecksTab) and the
 * top of the Claude Review tab. Each caller supplies its own row chrome; this renders the controls.
 *
 * ⚠ HIDDEN BY DEFAULT behind ONE reveal button ("Show actions"), so a write is never one stray
 * click away while reading. ⚠ NOTHING REMEMBERS THE CHOICE: every mount (a new tab, another view,
 * another PR) starts closed, so the actions show only after a click in the view at hand. Only the
 * BUTTONS hide: the merge facts stay on the Overview's Status row, and the closed row still says
 * where the viewer stands ("You approved") and whether a merge is in flight.
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
  // Open for ONE PR: a pane that stays mounted while the reader moves to another PR starts closed.
  const [openFor, setOpenFor] = useState<number | null>(null);
  const open = openFor === pr.id;
  // A merge or branch update started here keeps running while the buttons are hidden; say so.
  const merging = useIsMutating({ mutationKey: mergePrMutationKey(pr.id) }) > 0;
  const updating = useIsMutating({ mutationKey: updateBranchMutationKey(pr.id) }) > 0;
  const toggle = (): void => setOpenFor(open ? null : pr.id);
  const standing =
    pr.viewerReviewStanding === 'approved'
      ? 'You approved'
      : pr.viewerReviewStanding === 'changes_requested'
        ? 'You requested changes'
        : null;
  const reveal = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
    >
      {open ? 'Hide actions' : 'Show actions'}
      <ChevronIcon dir={open ? 'up' : 'down'} size={11} />
    </button>
  );
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="pr-actions-closed">
        {reveal}
        {standing != null && <span className="text-xs text-gray-600 dark:text-gray-300">{standing}</span>}
        {merging && <span className="text-xs text-gray-600 dark:text-gray-300">Merging…</span>}
        {!merging && updating && (
          <span className="text-xs text-gray-600 dark:text-gray-300">Updating the branch…</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      {reveal}
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
