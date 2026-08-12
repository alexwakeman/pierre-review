import { useState } from 'react';
import { useMergeOptions } from '../hooks/usePrWrites.js';
import { useArmAutoMerge, useDisarmAutoMerge, usePrArmedIntent } from '../hooks/useAutoMerge.js';
import { mergeVerdict, mergeWhenReadyEligible, toMergeStateStatus } from '../lib/ui.js';
import { ApiError } from '../api/client.js';

// The dedicated "Merge when ready" control — THE one place auto-merge is ARMED (MergeControl
// keeps its richer armed panel + cancel, but no arm button). Mounted beside Merge/Close in the
// Overview Actions row for an open, non-draft PR the viewer can push to; whether it SHOWS is
// `mergeWhenReadyEligible` over the live merge-options: a self-clearing blocker (blocked /
// behind / unknown) or clean-but-behind (mergeable now, behindBy > 0 — arm = update from
// trunk, then land). A fully clean up-to-date PR gets no button (that's just Merge), and
// neither do conflicts (the fix-push disarms, so the wait could only end by cancelling itself).
//
// On a merge-QUEUE repo the same arm exists with a different landing verb: the watcher adds
// the PR to the queue (instead of a direct merge GitHub would refuse) once required reviews
// are in — the copy says so, and a PR already IN the queue gets no button (its 'queued'
// verdict fails eligibility; it is already landing).
//
// merge-options is fetched EAGERLY here (unlike MergeControl's click-gated fetch): eligibility
// needs the LIVE behindBy, and the user is looking at this exact PR — 3 GitHub calls per
// viewed eligible PR is the accepted cost. The query KEY is shared with MergeControl (30s
// staleTime), so one fetch serves both controls.
export function MergeWhenReadyControl({ prId }: { prId: number }): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  const { data: options } = useMergeOptions(prId, true);
  const armedIntent = usePrArmedIntent(prId);
  const arm = useArmAutoMerge(prId);
  const disarm = useDisarmAutoMerge(prId);

  const errText = (e: unknown, fallback: string): string | null =>
    e instanceof ApiError ? e.message : e ? fallback : null;
  const armError = errText(arm.error, 'Failed to arm auto-merge.');
  const disarmError = errText(disarm.error, 'Failed to cancel auto-merge.');

  // Armed renders regardless of eligibility — cancelling must always be possible. The polled
  // list is the instant own-tab source; the lazily-fetched options cover a cross-tab arm the
  // 45s poll hasn't caught yet.
  const armed = armedIntent ?? (options?.autoMerge.armed?.state === 'armed' ? options.autoMerge.armed : null);
  if (armed != null) {
    // Three phases, not two: a queue intent that the watcher has already enqueued is past
    // "waiting for conditions" — the queue is landing it, and cancelling now also removes
    // the queue entry (the server does both).
    const inQueue = armed.enqueuedAt != null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded border border-violet-300 bg-violet-50/60 px-2 py-0.5 text-sm font-medium text-violet-700 dark:border-violet-800/60 dark:bg-violet-950/20 dark:text-violet-300"
          title={
            inQueue
              ? 'Limn added this PR to the merge queue — GitHub lands it from here. Cancelling also removes it from the queue.'
              : armed.viaMergeQueue
                ? 'Limn updates it from trunk if needed and adds it to the merge queue when required reviews are in — while the app is running. A new commit on the branch disarms it.'
                : 'Limn updates it from trunk if needed and merges when checks pass — while the app is running. A new commit on the branch disarms it.'
          }
        >
          <span aria-hidden>⏲</span>{' '}
          {inQueue
            ? 'In the merge queue'
            : armed.viaMergeQueue
              ? 'Armed — queueing when ready'
              : 'Armed — merging when ready'}
        </span>
        <button
          type="button"
          onClick={() => disarm.mutate()}
          disabled={disarm.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          {disarm.isPending ? 'Cancelling…' : inQueue ? 'Cancel & dequeue' : 'Cancel auto-merge'}
        </button>
        {disarmError && <span className="text-xs text-red-500">{disarmError}</span>}
      </div>
    );
  }

  // No button until eligibility is KNOWN — a guess from the synced row would either flash a
  // button that vanishes or (worse) gate on behindBy facts the lean row doesn't carry.
  if (options == null) return null;

  const queue = options.mergeQueue;
  // Same construction as MergeControl's, and like there `autoMergeArmed` is deliberately NOT
  // passed — 'armed' reports canMerge:true, which would read as the clean-but-behind case.
  const verdict = mergeVerdict({
    mergeable: options.conflicts
      ? 'conflicting'
      : options.mergeable === true
        ? 'mergeable'
        : 'unknown',
    mergeStateStatus: toMergeStateStatus(options.mergeStateStatus),
    inMergeQueue: queue?.inQueue ?? false,
    queuePosition: queue?.position ?? null,
    behindBy: options.behindBy,
  });
  const queueEnabled = queue?.enabled ?? false;
  const eligible = mergeWhenReadyEligible({
    allowedByRepo: options.autoMerge.allowedByRepo,
    methodCount: options.allowedMethods.length,
    alreadyArmed: false, // the armed early-return above already covered it
    verdict,
    behindBy: options.behindBy,
  });
  if (!eligible) return null;

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {/* The honest contract in one line: what it does AND that it's this server's watcher,
            not a GitHub setting. On a clean-but-behind PR this is a ≤2-min delayed merge, so
            the confirm step is deliberate, not decoration. */}
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {queueEnabled
            ? 'Updates from trunk if needed and adds it to the merge queue when required reviews are in — while Limn is running.'
            : 'Updates from trunk if needed and merges when checks pass — while Limn is running.'}
        </span>
        <button
          type="button"
          onClick={() =>
            arm.mutate(
              {
                mergeMethod: options.defaultMethod,
                // ALWAYS a real strategy — 'none' left a PR that fell behind AFTER arming
                // waiting forever on an up-to-date-required repo. Rebase is local-only
                // (config.canRebaseUpdate); cloud falls back to a merge-in.
                updateStrategy: options.canRebaseUpdate ? 'rebase' : 'merge',
              },
              { onSuccess: () => setConfirming(false) },
            )
          }
          disabled={arm.isPending}
          className="whitespace-nowrap rounded border border-violet-500 px-2 py-0.5 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-900/30"
        >
          {arm.isPending ? 'Arming…' : 'Arm auto-merge'}
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            arm.reset();
          }}
          disabled={arm.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          Cancel
        </button>
        {armError && <span className="text-xs text-red-500">{armError}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1 rounded border border-violet-400 px-2 py-0.5 text-sm font-medium text-violet-600 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/30"
      title={
        queueEnabled
          ? "Arm Limn's watcher: it updates from trunk if needed and adds the PR to the merge queue when required reviews are in — while the app is running"
          : "Arm Limn's watcher: it updates from trunk if needed and merges when checks pass — while the app is running"
      }
    >
      <span aria-hidden>⏲</span> {queueEnabled ? 'Queue when ready' : 'Merge when ready'}
    </button>
  );
}
