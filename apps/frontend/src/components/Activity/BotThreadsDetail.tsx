import { useMemo, useState } from 'react';
import type { BotResolvableThreadGroup } from '@pierre-review/shared';
import {
  useResolvableBotThreads,
  useScopeResolveBotThreads,
} from '../../hooks/useBotTriage.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { type TabMeta } from '../../store/pinnedTabs.js';
import { CI_META, indexUsers, relativeTime, userLabel } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { ThreadCountChips } from '../ThreadList/ThreadCountChips.js';

// The resolvable-bot-threads DRILL-DOWN — a persistent, singleton tab opened by the Bot-ROI
// backlog banner ("Review & resolve"). The scope-wide review-and-resolve flow lives here. It
// lists every PR with ≥1 `likely_addressed` automated-reviewer thread as a COMPACT one-line row
// (author · CI · age · a bot thread-state summary), with the bulk resolve action pinned to the
// TOP. Per-PR exclusion checkboxes let a reviewer drop a PR they'd rather handle by hand; the
// resolve is confirm-gated, chunked, and the server RE-DERIVES eligibility (the heuristic only
// LOOKS addressed — a later commit touched the file). Clicking a row opens that PR's detail tab
// on its Threads tab with the 'likely_addressed' pill preselected — inspect before resolving.

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
  const openPrThreadsFiltered = useFilters((s) => s.openPrThreadsFiltered);
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);

  const [confirming, setConfirming] = useState(false);
  // Empty = all PRs checked (the default). Tracks DE-selected PR ids so a refetch that drops
  // a resolved PR needs no reset effect — a stale id just falls out of `groups`.
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    resolved: number;
    failed: number;
  } | null>(null);

  const groups = data?.groups ?? [];
  const totalEligible = data?.totalEligible ?? 0;
  const shown = data?.shown ?? 0;

  // The selected PRs (not de-selected) and every resolvable thread id under them.
  const selectedGroups = useMemo(
    () => groups.filter((g) => !deselected.has(g.prId)),
    [groups, deselected],
  );
  const selectedPrIds = useMemo(() => selectedGroups.map((g) => g.prId), [selectedGroups]);
  const selectedThreadIds = useMemo(
    () => selectedGroups.flatMap((g) => g.threads.map((t) => t.threadId)),
    [selectedGroups],
  );

  const toggleGroup = (prId: number): void =>
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(prId)) next.delete(prId);
      else next.add(prId);
      return next;
    });

  // Open the PR's detail tab on its Threads tab with the likely-addressed pill preset. Does NOT
  // route back to the Bots feed — goes straight to the PR detail. Author fields from the loaded
  // user map (PrDetail backfills any gaps).
  const openPr = (g: BotResolvableThreadGroup): void => {
    const author = g.authorId != null ? usersById.get(g.authorId) : undefined;
    const meta: TabMeta = {
      id: g.prId,
      number: g.prNumber,
      title: g.prTitle,
      repoFullName: g.repoFullName,
      authorLogin: author?.githubLogin ?? null,
      authorDisplayName: author?.displayName ?? null,
      authorAvatarUrl: author?.avatarUrl ?? null,
    };
    openPrThreadsFiltered(meta, 'likely_addressed');
  };

  const runResolve = (): void => {
    // NEVER send an empty threadIds list — [] means resolve-NOTHING by design server-side.
    if (selectedThreadIds.length === 0) return;
    setProgress({ done: 0, total: selectedThreadIds.length, resolved: 0, failed: 0 });
    resolve.mutate(
      {
        threadIds: selectedThreadIds,
        repoIds: repoScope,
        prIds: selectedPrIds,
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
          PRs with likely-addressed automated-reviewer threads — a later commit touched their
          file, so they only LOOK resolved. Review, then resolve on GitHub. Click a PR to inspect.
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
          {/* TOP action bar — the bulk resolve pinned above the list. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 dark:border-gray-800 dark:bg-gray-900/40">
            {resolve.isPending && progress ? (
              <span className="text-[12px] text-gray-500 tabular-nums">
                Resolving… {progress.done}/{progress.total} ({progress.resolved} resolved
                {progress.failed > 0 ? `, ${progress.failed} failed` : ''})
              </span>
            ) : confirming ? (
              <>
                <span className="text-[12px] text-gray-600 dark:text-gray-300">
                  Resolve {selectedThreadIds.length} likely-addressed thread
                  {selectedThreadIds.length === 1 ? '' : 's'} across {selectedPrIds.length} PR
                  {selectedPrIds.length === 1 ? '' : 's'} on GitHub?
                </span>
                <button
                  type="button"
                  disabled={resolve.isPending || selectedThreadIds.length === 0}
                  onClick={runResolve}
                  className="rounded bg-green-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-green-700 disabled:opacity-60"
                >
                  Yes, resolve
                </button>
                <button
                  type="button"
                  disabled={resolve.isPending}
                  onClick={() => setConfirming(false)}
                  className="rounded px-2 py-1 text-[12px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={selectedThreadIds.length === 0}
                onClick={() => setConfirming(true)}
                className="rounded border border-sky-400 px-2.5 py-1 text-[12px] font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50 dark:border-sky-600 dark:text-sky-200 dark:hover:bg-sky-900/30"
                title="These threads only LOOK addressed (a later commit touched their file) — you approve the batch before it resolves on GitHub."
              >
                Resolve {selectedThreadIds.length} thread{selectedThreadIds.length === 1 ? '' : 's'}
                {' '}across {selectedPrIds.length} PR{selectedPrIds.length === 1 ? '' : 's'}
              </button>
            )}
            <span className="text-[11px] text-gray-400 tabular-nums">
              {selectedPrIds.length} of {groups.length} PR{groups.length === 1 ? '' : 's'} selected
              {totalEligible > shown && ` · showing the ${shown} newest of ${totalEligible}`}
            </span>
            {!resolve.isPending &&
              resolve.data &&
              (resolve.data.resolved > 0 || resolve.data.failed > 0) && (
                <span className="text-[11px] text-gray-500">
                  Resolved {resolve.data.resolved}
                  {resolve.data.failed > 0 && ` · ${resolve.data.failed} failed`}.
                </span>
              )}
            {resolve.isError && (
              <span className="text-[11px] text-red-500">
                {(resolve.error as Error)?.message ?? 'Couldn’t resolve.'}
              </span>
            )}
          </div>

          {/* Compact per-PR rows — a checkbox to exclude, then a clickable body that opens the
              PR's Threads tab (likely-addressed pill preset). No per-thread enumeration. */}
          <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
            {groups.map((g) => {
              const selected = !deselected.has(g.prId);
              const author = g.authorId != null ? usersById.get(g.authorId) : undefined;
              const ci = CI_META[g.ciStatus];
              const resolvable = g.botThreadCounts.likely_addressed;
              return (
                <div
                  key={g.prId}
                  className={`flex items-center gap-2.5 border-b border-gray-100 px-3 py-2 last:border-b-0 dark:border-gray-800/60 ${
                    selected ? '' : 'opacity-50'
                  }`}
                >
                  {/* stopPropagation so excluding a PR never also navigates. */}
                  <input
                    type="checkbox"
                    checked={selected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleGroup(g.prId)}
                    title={selected ? 'Exclude this PR from the resolve' : 'Include this PR'}
                    className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => openPr(g)}
                    title="Open this PR's Threads tab (likely-addressed threads)"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
                      title={ci?.label ?? 'no checks'}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-[11px] text-gray-400">
                        {g.repoFullName} #{g.prNumber}
                      </span>{' '}
                      <span className="text-[13px] font-medium text-gray-800 dark:text-gray-100">
                        {g.prTitle}
                      </span>
                    </span>
                    <span className="hidden shrink-0 items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 sm:inline-flex">
                      <Avatar user={author} size={14} />
                      <span className="max-w-[7rem] truncate">
                        {userLabel(author, g.authorId)}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-[11px] text-gray-400 md:inline">
                      {relativeTime(g.openedAt)}
                    </span>
                    <ThreadCountChips counts={g.botThreadCounts} />
                    <span
                      className="shrink-0 rounded bg-sky-100 px-1.5 py-px text-[10px] font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                      title="Threads a later commit likely addressed — the resolvable set"
                    >
                      {resolvable} resolvable
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
