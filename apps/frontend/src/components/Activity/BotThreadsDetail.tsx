import { useMemo, useState } from 'react';
import type {
  BotResolvableThread,
  BotResolvableThreadGroup,
} from '@pierre-review/shared';
import {
  useResolvableBotThreads,
  useScopeResolveBotThreads,
} from '../../hooks/useBotTriage.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';

// The resolvable-bot-threads DRILL-DOWN — a persistent, singleton tab opened by the Bot-ROI
// backlog banner ("Review & resolve"). The scope-wide review-and-resolve flow lives HERE (moved
// out of the inline banner): every `likely_addressed` automated-reviewer thread in scope,
// grouped by PR with per-thread checkboxes (all checked by default), a confirm gate, and
// streamed chunked progress. The heuristic wording stays honest — these threads only LOOK
// addressed (a later commit touched their file), so the user reviews before resolving. NEW
// here: clicking a thread row navigates INTO the thread (its PR's detail tab, Threads tab
// scrolled + highlighted) so a doubtful row can be inspected before resolving.

export function BotThreadsDetail(): JSX.Element {
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  // The repo the tab was opened from (per-repo Bots tab) — scopes the whole tab to that repo;
  // null (the cross-repo Bots rail) falls back to the team scope. Read (not consumed) so the
  // scope persists for the tab's lifetime; only reset when the next drill-down opens.
  const focusRepoId = useFilters((s) => s.botThreadsFocusRepoId);
  const repoScope = useMemo(() => (focusRepoId != null ? [focusRepoId] : null), [focusRepoId]);
  const { data, isLoading, isError, refetch, isFetching } = useResolvableBotThreads(
    true,
    scope,
    repoScope,
  );
  const resolve = useScopeResolveBotThreads();
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const selectThread = useFilters((s) => s.selectThread);

  const [confirming, setConfirming] = useState(false);
  // Empty = all checked (the default). Tracks DE-selections so a refetch that drops resolved
  // threads doesn't need a reset effect — stale ids just fall out of `allIds`.
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    resolved: number;
    failed: number;
  } | null>(null);

  const groups = data?.groups ?? [];
  const allIds = useMemo(() => groups.flatMap((g) => g.threads.map((t) => t.threadId)), [groups]);
  const selectedIds = useMemo(
    () => allIds.filter((id) => !deselected.has(id)),
    [allIds, deselected],
  );
  const totalEligible = data?.totalEligible ?? 0;
  const shown = data?.shown ?? 0;

  const toggleThread = (id: number): void =>
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleGroup = (g: BotResolvableThreadGroup): void => {
    const ids = g.threads.map((t) => t.threadId);
    const allSelected = ids.every((id) => !deselected.has(id));
    setDeselected((prev) => {
      const next = new Set(prev);
      // All selected → deselect the group; otherwise select the whole group.
      for (const id of ids) (allSelected ? next.add(id) : next.delete(id));
      return next;
    });
  };

  // Navigate into the thread: the PR's detail tab with its Threads tab scrolled to + amber-
  // highlighting this thread (the FeedView pattern). Author fields null — PrDetail backfills.
  const openThread = (g: BotResolvableThreadGroup, t: BotResolvableThread): void => {
    const meta: TabMeta = {
      id: g.prId,
      number: g.prNumber,
      title: g.prTitle,
      repoFullName: g.repoFullName,
      authorLogin: null,
      authorDisplayName: null,
      authorAvatarUrl: null,
    };
    openPrDetailTab(meta, { fromActivity: true });
    selectThread(g.prId, t.threadId);
  };

  const runResolve = (): void => {
    // NEVER send an empty threadIds list — [] means resolve-NOTHING by design server-side.
    if (selectedIds.length === 0) return;
    // The PRs the selected threads belong to — their cached detail invalidates post-resolve.
    const selectedSet = new Set(selectedIds);
    const prIds = groups
      .filter((g) => g.threads.some((t) => selectedSet.has(t.threadId)))
      .map((g) => g.prId);
    setProgress({ done: 0, total: selectedIds.length, resolved: 0, failed: 0 });
    resolve.mutate(
      {
        threadIds: selectedIds,
        repoIds: repoScope,
        prIds,
        onProgress: (done, total, resolved, failed) =>
          setProgress({ done, total, resolved, failed }),
      },
      { onSettled: () => setConfirming(false) },
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
          <span aria-hidden>🧹</span> Resolve bot threads
        </h2>
        <span className="text-[11px] text-gray-400">
          likely-addressed automated-reviewer threads — a later commit touched their file, so
          they only LOOK resolved. Review, then resolve on GitHub. Click a thread to inspect it.
        </span>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="ml-auto rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-medium hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
        >
          <span aria-hidden className={isFetching ? 'animate-spin' : ''}>
            ↻
          </span>{' '}
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-gray-100 dark:bg-gray-900/40" />
          ))}
        </div>
      ) : isError ? (
        <div className="text-sm text-red-500">Couldn’t load the resolvable threads.</div>
      ) : totalEligible === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No likely-addressed bot threads to review. 🎉
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            <span className="tabular-nums">
              {selectedIds.length} of {allIds.length} selected
            </span>
            {totalEligible > shown && (
              <span className="text-gray-400">
                showing the {shown} newest of {totalEligible} — resolve these and refresh for
                more
              </span>
            )}
          </div>

          <div className="space-y-2">
            {groups.map((g) => {
              const ids = g.threads.map((t) => t.threadId);
              const allSelected = ids.every((id) => !deselected.has(id));
              return (
                <div key={g.prId} className="rounded border border-gray-200 dark:border-gray-800">
                  <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-2 py-1 dark:border-gray-800/60">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => toggleGroup(g)}
                      className="h-3 w-3 cursor-pointer"
                      title="Toggle all this PR's threads"
                    />
                    <a
                      href={g.githubUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 truncate text-[12px] font-medium text-gray-700 hover:underline dark:text-gray-200"
                      title={`${g.repoFullName} #${g.prNumber}`}
                    >
                      <span className="text-gray-400">{g.repoFullName}</span> #{g.prNumber}{' '}
                      {g.prTitle}
                    </a>
                    <span className="ml-auto shrink-0 text-[10px] text-gray-400">
                      {g.threads.length} thread{g.threads.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <ul>
                    {g.threads.map((t) => (
                      <li
                        key={t.threadId}
                        onClick={() => openThread(g, t)}
                        title="Open this thread in the PR's Threads tab"
                        className="flex cursor-pointer items-start gap-2 px-2 py-1 text-[11px] hover:bg-gray-50 dark:hover:bg-gray-800/40"
                      >
                        {/* stopPropagation so ticking the box never also navigates. */}
                        <input
                          type="checkbox"
                          checked={!deselected.has(t.threadId)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleThread(t.threadId)}
                          className="mt-0.5 h-3 w-3 shrink-0 cursor-pointer"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[10px] text-gray-600 dark:text-gray-300">
                              {t.path}
                            </span>
                            <span className="rounded bg-gray-100 px-1 py-px text-[9px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                              🤖 {t.botLabel}
                            </span>
                          </div>
                          {t.excerpt && (
                            <div className="truncate text-[10px] text-gray-400">{t.excerpt}</div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {resolve.isPending && progress ? (
              <span className="text-gray-500 tabular-nums">
                Resolving… {progress.done}/{progress.total} ({progress.resolved} resolved
                {progress.failed > 0 ? `, ${progress.failed} failed` : ''})
              </span>
            ) : confirming ? (
              <>
                <span className="text-gray-500">
                  Resolve {selectedIds.length} likely-addressed thread
                  {selectedIds.length === 1 ? '' : 's'} on GitHub?
                </span>
                <button
                  type="button"
                  disabled={resolve.isPending || selectedIds.length === 0}
                  onClick={runResolve}
                  className="rounded bg-green-600 px-2 py-0.5 font-medium text-white hover:bg-green-700 disabled:opacity-60"
                >
                  Yes, resolve
                </button>
                <button
                  type="button"
                  disabled={resolve.isPending}
                  onClick={() => setConfirming(false)}
                  className="rounded px-2 py-0.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={selectedIds.length === 0}
                onClick={() => setConfirming(true)}
                className="rounded border border-sky-400 px-2 py-0.5 font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50 dark:border-sky-600 dark:text-sky-200 dark:hover:bg-sky-900/30"
                title="These threads only LOOK addressed (a later commit touched their file) — you approve the batch before it resolves on GitHub."
              >
                Resolve {selectedIds.length} on GitHub
              </button>
            )}
            {!resolve.isPending &&
              resolve.data &&
              (resolve.data.resolved > 0 || resolve.data.failed > 0) && (
                <span className="text-gray-500">
                  Resolved {resolve.data.resolved}
                  {resolve.data.failed > 0 && ` · ${resolve.data.failed} failed`}.
                </span>
              )}
            {resolve.isError && (
              <span className="text-red-500">
                {(resolve.error as Error)?.message ?? 'Couldn’t resolve.'}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
