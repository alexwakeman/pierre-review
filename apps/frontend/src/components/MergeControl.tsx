import { useMemo, useState } from 'react';
import type { MergeMethod } from '@pierre-review/shared';
import {
  useDequeueMergeQueue,
  useEnqueueMergeQueue,
  useMergeOptions,
  useMergePr,
  useUpdatePrBranch,
} from '../hooks/usePrWrites.js';
import { useDisarmAutoMerge } from '../hooks/useAutoMerge.js';
import { dateTime, MERGE_TONE_CLASS, mergeVerdict, relativeTime, toMergeStateStatus } from '../lib/ui.js';
import { ApiError } from '../api/client.js';
import { CaretIcon, ExternalLinkIcon, MergeIcon, WarningIcon } from './Icons.js';

// Merge control for the Overview tab (CORE / free tier), rendered next to Approve when the
// viewer has push access and the PR is open + not a draft. Collapsed it's a single "Merge ▾"
// button; expanding fetches the repo's allowed merge methods + GitHub's live mergeability
// (lazily, so the hot PR-detail path stays fast).
//
// It resolves THREE ways, in this order — they are mutually exclusive by construction:
//
//   1. the base branch has a MERGE QUEUE  → "Add to merge queue" replaces Merge entirely.
//      GitHub won't accept a direct merge on a queued branch, so offering one would only
//      produce a confusing 405. Position/ETA + "Remove from queue" render while queued.
//   2. it can merge now                   → merge / squash / rebase (whichever the repo allows).
//   3. it can't merge YET                 → the verdict line says why. ARMING lives in the
//      sibling MergeWhenReadyControl (the ONE way to arm — it also covers clean-but-behind,
//      which this control's !canMerge gate could never see). The armed panel + its cancel
//      still render here: they carry richer detail (method, reason, expiry) than the button.
//
// Everything that says "can this land?" comes from the ONE `mergeVerdict` resolver in lib/ui,
// so this control, the open-PR rows and the timeline tooltip can never disagree.

const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

const METHOD_VERB: Record<MergeMethod, string> = {
  merge: 'Merge',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

export function MergeControl({ prId, githubUrl }: { prId: number; githubUrl: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data: options, isLoading, isError } = useMergeOptions(prId, open);
  const merge = useMergePr(prId);
  const update = useUpdatePrBranch(prId);
  const enqueue = useEnqueueMergeQueue(prId);
  const dequeue = useDequeueMergeQueue(prId);
  const disarm = useDisarmAutoMerge(prId);

  // The chosen method — default to the repo's first allowed once options load.
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [updateStrategy, setUpdateStrategy] = useState<'rebase' | 'merge'>('rebase');
  const effectiveMethod: MergeMethod =
    method && options?.allowedMethods.includes(method)
      ? method
      : (options?.defaultMethod ?? 'merge');

  const errText = (e: unknown, fallback: string): string | null =>
    e instanceof ApiError ? e.message : e ? fallback : null;
  const mergeError = errText(merge.error, 'Failed to merge the PR.');
  const updateError = errText(update.error, 'Failed to update the branch.');
  const queueError = errText(enqueue.error ?? dequeue.error, 'Merge-queue action failed.');
  const armError = errText(disarm.error, 'Failed to change auto-merge.');

  const behindLabel = useMemo(() => {
    if (options == null || !options.behind) return null;
    const n = options.behindBy;
    return `${n > 0 ? n : 'Some'} commit${n === 1 ? '' : 's'} behind ${options.baseRef}`;
  }, [options]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded border border-violet-500 px-2 py-0.5 text-sm font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-900/30"
      >
        <MergeIcon />
        Merge
        <CaretIcon />
      </button>
    );
  }

  if (isLoading) {
    return <div className="text-xs text-gray-400">Checking merge status…</div>;
  }
  if (isError || options == null) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-500">
        Couldn’t load merge status.
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-gray-300 px-1.5 py-0.5 text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300"
        >
          Close
        </button>
      </div>
    );
  }

  const queue = options.mergeQueue;
  const armed = options.autoMerge.armed;
  const isArmed = armed?.state === 'armed';

  // The one verdict, fed the live merge-options values (not the synced PR row).
  //
  // `autoMergeArmed` is deliberately NOT passed here even though the resolver accepts it: an
  // 'armed' verdict reports canMerge:true (arming doesn't take the manual merge away), which
  // on THIS surface would enable a Merge button for a PR that is still blocked. The armed
  // state gets its own panel below; this verdict stays a pure statement of mergeability, so
  // the button it gates can't lie. (Other surfaces, which render the verdict but offer no
  // button, do want the 'armed' collapse.)
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

  const hasMethods = options.allowedMethods.length > 0;
  const canMergeNow = verdict.canMerge && hasMethods;
  const busy = merge.isPending || enqueue.isPending || dequeue.isPending;

  return (
    <div className="w-full space-y-2">
      {/* The verdict, always first — "why can't I merge this?" answered in one line. */}
      <div className={`text-xs font-medium ${MERGE_TONE_CLASS[verdict.tone]}`}>
        {(verdict.tone === 'bad' || verdict.tone === 'warn') && (
          <WarningIcon size={12} className="mr-1 inline-block align-[-0.1em]" />
        )}
        {verdict.label}
        {verdict.detail && (
          <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">
            — {verdict.detail}
          </span>
        )}
      </div>

      {/* Conflicts — info only. Conflict resolution is a Pro feature; free tier links out. */}
      {options.conflicts && (
        <div className="rounded border border-amber-300 bg-amber-50/60 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200">
          <WarningIcon size={12} className="mr-1 inline-block align-[-0.1em]" />
          This PR conflicts with <span className="font-mono">{options.baseRef}</span>. Resolve the
          conflicts on{' '}
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium underline"
          >
            GitHub <ExternalLinkIcon size={11} className="inline-block align-[-0.1em]" />
          </a>
          .
        </div>
      )}

      {/* Behind trunk — offer an update (rebase locally / merge). Hidden on conflicts. */}
      {options.canUpdateBranch && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500 dark:text-gray-400">{behindLabel}.</span>
          {options.canRebaseUpdate && (
            <select
              value={updateStrategy}
              onChange={(e) => setUpdateStrategy(e.target.value as 'rebase' | 'merge')}
              disabled={update.isPending}
              className="rounded border border-gray-300 bg-white px-1 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900"
              title="How to bring in the base branch"
            >
              <option value="rebase">Rebase onto {options.baseRef}</option>
              <option value="merge">Merge {options.baseRef} in</option>
            </select>
          )}
          <button
            type="button"
            onClick={() =>
              update.mutate(
                options.canRebaseUpdate ? { strategy: updateStrategy } : { strategy: 'merge' },
              )
            }
            disabled={update.isPending}
            className="rounded border border-sky-500 px-2 py-0.5 font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-50 dark:border-sky-600 dark:text-sky-300 dark:hover:bg-sky-900/30"
            title="Bring in the latest base-branch changes before merging"
          >
            {update.isPending ? 'Updating…' : 'Update branch'}
          </button>
          {updateError && <span className="text-red-500">{updateError}</span>}
        </div>
      )}

      {/* An armed intent — what it will do, and how to call it off. */}
      {isArmed && armed != null && (
        <div className="rounded border border-violet-300 bg-violet-50/60 px-2 py-1.5 text-xs text-violet-900 dark:border-violet-800/60 dark:bg-violet-950/20 dark:text-violet-200">
          <div className="font-medium">
            {/* On a queue intent the METHOD verb would mislead — the queue's own configured
                method wins, not the intent's. Say what actually lands it instead. */}
            Auto-merge armed · {armed.viaMergeQueue ? 'via the merge queue' : METHOD_VERB[armed.mergeMethod]} · armed{' '}
            {relativeTime(armed.armedAt)}
          </div>
          <div className="mt-0.5 text-violet-700/90 dark:text-violet-300/90">
            {armed.lastReason ?? 'Waiting for the blockers to clear.'}
          </div>
          {/* Honest about the mechanism: this is a watcher in THIS server, not a GitHub setting. */}
          <div className="mt-0.5 text-[11px] text-violet-700/70 dark:text-violet-300/70">
            {armed.viaMergeQueue
              ? 'Limn adds it to the merge queue while the app is running; GitHub lands it from there.'
              : 'Limn merges it while the app is running.'}{' '}
            A new commit on the branch disarms it — you re-arm to merge the new code. Expires{' '}
            {dateTime(armed.expiresAt)}.
          </div>
          <button
            type="button"
            onClick={() => disarm.mutate()}
            disabled={disarm.isPending}
            className="mt-1 rounded border border-violet-400 px-1.5 py-0.5 font-medium hover:bg-violet-100 disabled:opacity-50 dark:border-violet-700 dark:hover:bg-violet-900/40"
          >
            {disarm.isPending ? 'Cancelling…' : 'Cancel auto-merge'}
          </button>
        </div>
      )}

      {/* Action row. A merge queue REPLACES the merge button (GitHub won't take a direct merge). */}
      <div className="flex flex-wrap items-center gap-2">
        {queue?.enabled ? (
          queue.inQueue ? (
            <>
              <span className="text-xs text-gray-600 dark:text-gray-300">
                In the merge queue
                {queue.position != null && ` · position ${queue.position}`}
                {queue.state && ` · ${queue.state.toLowerCase().replace(/_/g, ' ')}`}
                {queue.estimatedTimeToMergeMs != null &&
                  ` · ~${Math.max(1, Math.round(queue.estimatedTimeToMergeMs / 60000))} min`}
              </span>
              <button
                type="button"
                onClick={() => dequeue.mutate()}
                disabled={busy}
                className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
              >
                {dequeue.isPending ? 'Removing…' : 'Remove from queue'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => enqueue.mutate(effectiveMethod)}
              disabled={busy}
              className="whitespace-nowrap rounded border border-violet-500 px-2 py-0.5 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-900/30"
              title="This branch uses a merge queue — GitHub merges it in turn"
            >
              {enqueue.isPending ? 'Queueing…' : 'Add to merge queue'}
            </button>
          )
        ) : (
          <>
            {options.allowedMethods.length > 1 && (
              <select
                value={effectiveMethod}
                onChange={(e) => setMethod(e.target.value as MergeMethod)}
                disabled={busy || !canMergeNow}
                className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                {options.allowedMethods.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => merge.mutate(effectiveMethod)}
              disabled={!canMergeNow || busy}
              className="whitespace-nowrap rounded border border-violet-500 px-2 py-0.5 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-900/30"
              title={canMergeNow ? 'Merge this PR' : verdict.detail ?? 'This PR can’t be merged right now'}
            >
              {merge.isPending ? 'Merging…' : METHOD_VERB[effectiveMethod]}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            merge.reset();
            update.reset();
            enqueue.reset();
            dequeue.reset();
            disarm.reset();
          }}
          disabled={busy}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          Cancel
        </button>
        {mergeError && <span className="text-xs text-red-500">{mergeError}</span>}
        {queueError && <span className="text-xs text-red-500">{queueError}</span>}
        {armError && <span className="text-xs text-red-500">{armError}</span>}
      </div>
    </div>
  );
}
