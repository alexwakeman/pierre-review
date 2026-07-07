import { useMemo, useState } from 'react';
import type { MergeMethod } from '@pierre-review/shared';
import { useMergeOptions, useMergePr, useUpdatePrBranch } from '../hooks/usePrWrites.js';
import { ApiError } from '../api/client.js';

// Merge control for the Overview tab (CORE / free tier), rendered next to Approve when the
// viewer has push access and the PR is open + not a draft. Collapsed it's a single "Merge ▾"
// button; expanding fetches the repo's allowed merge methods + GitHub's live mergeability
// (lazily, so the hot PR-detail path stays fast). It offers merge / squash / rebase (whichever
// the repo enables, defaulting to the repo's first allowed), an "Update branch from trunk"
// when the head is behind (rebase locally / merge — no conflict resolution in the free tier),
// and an info-only note (link to GitHub) when the PR conflicts. The server re-checks write
// access + conflicts and 409s otherwise.

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

  // The chosen method — default to the repo's first allowed once options load.
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [updateStrategy, setUpdateStrategy] = useState<'rebase' | 'merge'>('rebase');
  const effectiveMethod: MergeMethod =
    method && options?.allowedMethods.includes(method)
      ? method
      : (options?.defaultMethod ?? 'merge');

  const mergeError =
    merge.error instanceof ApiError
      ? merge.error.message
      : merge.error
        ? 'Failed to merge the PR.'
        : null;
  const updateError =
    update.error instanceof ApiError
      ? update.error.message
      : update.error
        ? 'Failed to update the branch.'
        : null;

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
        <span aria-hidden>⇱</span> Merge ▾
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

  const canMerge = !options.conflicts && !options.blocked && options.allowedMethods.length > 0;

  return (
    <div className="space-y-2">
      {/* Conflicts — info only. Conflict resolution is a Pro feature; free tier links out. */}
      {options.conflicts && (
        <div className="rounded border border-amber-300 bg-amber-50/60 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-200">
          ⚠ This PR conflicts with <span className="font-mono">{options.baseRef}</span>. Resolve the
          conflicts on{' '}
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium underline"
          >
            GitHub ↗
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

      {/* Blocked by branch protection — merge disabled with the reason. */}
      {options.blocked && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Merging is blocked by branch protection (required reviews or checks aren’t satisfied yet).
        </div>
      )}

      {/* Method + Merge / Cancel. */}
      <div className="flex flex-wrap items-center gap-2">
        {options.allowedMethods.length > 1 && (
          <select
            value={effectiveMethod}
            onChange={(e) => setMethod(e.target.value as MergeMethod)}
            disabled={!canMerge || merge.isPending}
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
          disabled={!canMerge || merge.isPending}
          className="whitespace-nowrap rounded border border-violet-500 px-2 py-0.5 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-900/30"
          title={canMerge ? 'Merge this PR' : 'This PR can’t be merged right now'}
        >
          {merge.isPending ? 'Merging…' : METHOD_VERB[effectiveMethod]}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            merge.reset();
            update.reset();
          }}
          disabled={merge.isPending}
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          Cancel
        </button>
        {mergeError && <span className="text-xs text-red-500">{mergeError}</span>}
      </div>
    </div>
  );
}
