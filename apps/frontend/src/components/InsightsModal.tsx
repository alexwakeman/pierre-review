import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InsightsOpenPr, RepoInsights } from '@pierre-review/shared';
import { useInsights, useMe } from '../hooks/useTriage.js';
import { useUsers } from '../hooks/useTimeline.js';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../store/pinnedTabs.js';
import { api, ApiError } from '../api/client.js';
import { indexUsers, userLabel, relativeTime } from '../lib/ui.js';
import { Avatar } from './CommentCard.js';
import { OpenDurationChart } from './InsightsChart.js';
import { RepoAnalyticsModal } from './RepoAnalyticsModal.js';

// Header "Insights" panel: a per-repo sprint snapshot — open / draft / merged-7d /
// stalled counts, median time-to-first-review, the oldest unreviewed PR, the
// reviewers carrying the most pending requests, and a collapsible list of every
// open PR (with its own Stale toggle, independent of the timeline filters). When
// Claude Review is enabled each open PR gets a one-click "Review" (defaults to
// Sonnet). Per repo only; opened from the header, dismissed via backdrop / X / Esc.
function fmtHours(h: number | null): string {
  if (h == null) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'warn' | 'good';
  title?: string;
}): JSX.Element {
  const valueColor =
    tone === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'good'
        ? 'text-green-600 dark:text-green-400'
        : 'text-gray-800 dark:text-gray-100';
  return (
    <div
      className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 dark:border-gray-800 dark:bg-gray-900/60"
      title={title}
    >
      <div className={`text-lg font-semibold tabular-nums ${valueColor}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
    </div>
  );
}

// One-click Claude review for an open PR in the list. Defaults to Sonnet; the global
// banner tracks progress once started. Reflects busy / error inline.
function ReviewButton({ prId }: { prId: number }): JSX.Element {
  const bump = useFilters((s) => s.bumpClaudeReviewKickoff);
  const start = useMutation({
    mutationFn: () => api.generateClaudeReview(prId, 'claude-sonnet-4-6', 'auto'),
    onSuccess: () => bump(), // wake the progress banner
  });
  const label = start.isPending
    ? 'Starting…'
    : start.isSuccess
      ? 'Started ✓'
      : start.isError
        ? 'Retry'
        : 'Review';
  const title = start.isError
    ? start.error instanceof ApiError
      ? start.error.message
      : 'Failed to start the review'
    : 'Start a Claude review (Sonnet) for this PR';
  return (
    <button
      type="button"
      onClick={() => start.mutate()}
      disabled={start.isPending || start.isSuccess}
      title={title}
      className="shrink-0 rounded border border-purple-300 px-1.5 py-0.5 text-[11px] text-purple-600 hover:bg-purple-50 disabled:opacity-60 dark:border-purple-700 dark:text-purple-300 dark:hover:bg-purple-900/30"
    >
      {label}
    </button>
  );
}

function OpenPrRow({
  pr,
  repoFullName,
  usersById,
  canReview,
  onPick,
}: {
  pr: InsightsOpenPr;
  repoFullName: string;
  usersById: ReturnType<typeof indexUsers>;
  canReview: boolean;
  // Open this PR as its own PR-focus tab (and close Insights).
  onPick: (meta: TabMeta) => void;
}): JSX.Element {
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
  return (
    <li className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-900/40">
      <button
        type="button"
        onClick={() =>
          onPick({
            id: pr.prId,
            number: pr.number,
            title: pr.title,
            repoFullName,
            authorLogin: author?.githubLogin ?? null,
            authorDisplayName: author?.displayName ?? null,
            authorAvatarUrl: author?.avatarUrl ?? null,
          })
        }
        className="min-w-0 flex-1 text-left"
        title={`Focus #${pr.number} on the timeline`}
      >
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-gray-400">#{pr.number}</span>
          <span className="truncate text-gray-700 dark:text-gray-200">{pr.title}</span>
          {pr.isDraft && (
            <span className="shrink-0 rounded bg-gray-200 px-1 text-[9px] uppercase text-gray-500 dark:bg-gray-700 dark:text-gray-300">
              draft
            </span>
          )}
          {pr.isStalled && (
            <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] uppercase text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              stalled
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-gray-400">
          <Avatar user={author} size={12} />
          <span className="truncate">{userLabel(author, pr.authorId)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">opened {relativeTime(pr.openedAt)}</span>
        </div>
      </button>
      {canReview && <ReviewButton prId={pr.prId} />}
    </li>
  );
}

function RepoCard({
  repo,
  usersById,
  windows,
  showStale,
  canReview,
  onPick,
  onOpenCharts,
}: {
  repo: RepoInsights;
  usersById: ReturnType<typeof indexUsers>;
  windows: { merged: number; review: number; stall: number };
  showStale: boolean;
  canReview: boolean;
  onPick: (meta: TabMeta) => void;
  onOpenCharts: (repoId: number, name: string) => void;
}): JSX.Element {
  const [listOpen, setListOpen] = useState(false);
  const visiblePrs = showStale
    ? repo.openPrList
    : repo.openPrList.filter((p) => !p.isStalled);
  const hiddenStale = repo.openPrList.length - visiblePrs.length;

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="mb-2 flex items-center gap-2">
        <span className="truncate text-sm font-semibold text-gray-700 dark:text-gray-200">
          {repo.repoFullName}
        </span>
        <button
          type="button"
          onClick={() => onOpenCharts(repo.repoId, repo.repoFullName)}
          className="ml-auto shrink-0 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:border-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          title="Open the analytics charts for this repo"
        >
          📊 Charts
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
        <Stat label="Open" value={repo.openPrs} title="Currently-open, non-draft PRs" />
        <Stat label="Draft" value={repo.draftPrs} title="Currently-open draft PRs" />
        <Stat
          label={`Merged ${windows.merged}d`}
          value={repo.mergedLast7d}
          tone="good"
          title={`PRs merged in the last ${windows.merged} days`}
        />
        <Stat
          label="Stalled"
          value={repo.stalledPrs}
          tone={repo.stalledPrs > 0 ? 'warn' : 'default'}
          title={`Open PRs with unresolved threads and no commit in ${windows.stall} days`}
        />
        <Stat
          label="1st review"
          value={fmtHours(repo.medianHoursToFirstReview)}
          title={`Median time from open to first review, over PRs opened in the last ${windows.review} days`}
        />
      </div>

      <OpenDurationChart points={repo.openDurationTrend} />

      {repo.oldestUnreviewed != null && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Oldest unreviewed:{' '}
          <a
            href={repo.oldestUnreviewed.githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-600 hover:underline dark:text-blue-400"
            title={repo.oldestUnreviewed.title}
          >
            #{repo.oldestUnreviewed.number}
          </a>{' '}
          <span className="text-gray-400">
            · opened {relativeTime(repo.oldestUnreviewed.openedAt)}
          </span>
        </div>
      )}

      {repo.reviewLoad.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">
            Pending reviews by reviewer
          </div>
          <div className="flex flex-wrap gap-1.5">
            {repo.reviewLoad.map((r) => {
              const user = usersById.get(r.userId);
              return (
                <span
                  key={r.userId}
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-1.5 py-0.5 text-xs dark:border-gray-700"
                  title={`${userLabel(user, r.userId)} — ${r.pending} pending review${r.pending === 1 ? '' : 's'}`}
                >
                  <Avatar user={user} size={14} />
                  <span className="max-w-[8rem] truncate">{userLabel(user, r.userId)}</span>
                  <span className="font-semibold tabular-nums text-gray-500">{r.pending}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {repo.openPrList.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setListOpen((o) => !o)}
            className="flex w-full items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            aria-expanded={listOpen}
          >
            <span className="text-gray-400">{listOpen ? '▾' : '▸'}</span>
            Open PRs ({visiblePrs.length})
            {!showStale && hiddenStale > 0 && (
              <span className="font-normal text-gray-400">· {hiddenStale} stale hidden</span>
            )}
          </button>
          {listOpen && (
            <ul className="mt-1 divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
              {visiblePrs.length === 0 ? (
                <li className="px-2 py-2 text-[11px] text-gray-500">
                  No open PRs{!showStale ? ' (stale hidden)' : ''}.
                </li>
              ) : (
                visiblePrs.map((pr) => (
                  <OpenPrRow
                    key={pr.prId}
                    pr={pr}
                    repoFullName={repo.repoFullName}
                    usersById={usersById}
                    canReview={canReview}
                    onPick={onPick}
                  />
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function InsightsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const { data, isLoading } = useInsights(open);
  const { data: users } = useUsers();
  const canReview = useMe().data?.claudeReviewEnabled ?? false;
  const usersById = useMemo(() => indexUsers(users), [users]);
  const [showStale, setShowStale] = useState(true);
  const [analyticsRepo, setAnalyticsRepo] = useState<{ id: number; name: string } | null>(null);
  const qc = useQueryClient();
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);

  // Picking an open PR opens it as its own PR-focus TAB (a fresh isolated Timeline)
  // and closes Insights. Works for open PRs outside the loaded window: the PR-focus
  // tab fetches a ~90-day member-agnostic window so the subject PR is present.
  const onPick = (meta: TabMeta): void => {
    openPrFocusTab(meta);
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      // When the analytics drill-down is up it owns Escape (closes itself first).
      if (analyticsRepo) return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, analyticsRepo]);

  if (!open) return null;

  const windows = {
    merged: data?.mergedWindowDays ?? 7,
    review: data?.reviewWindowDays ?? 30,
    stall: data?.stallThresholdDays ?? 7,
  };

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[82vh] w-[44rem] max-w-[94vw] flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Insights"
      >
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Insights</h2>
            <p className="truncate text-[11px] text-gray-400">
              Per-repo snapshot · merged over {windows.merged}d · first-review median over{' '}
              {windows.review}d
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
              <input
                type="checkbox"
                checked={showStale}
                onChange={(e) => setShowStale(e.target.checked)}
              />
              Show stale
            </label>
            <button
              type="button"
              onClick={() => void qc.invalidateQueries({ queryKey: ['insights'] })}
              className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              title="Refresh"
            >
              ↻
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              aria-label="Close (Esc)"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
          {isLoading && !data && (
            <div className="py-8 text-center text-sm text-gray-500">Loading insights…</div>
          )}
          {data != null && data.repos.length === 0 && (
            <div className="py-8 text-center text-sm text-gray-500">
              No repositories to report on.
            </div>
          )}
          {data?.repos.map((repo) => (
            <RepoCard
              key={repo.repoId}
              repo={repo}
              usersById={usersById}
              windows={windows}
              showStale={showStale}
              canReview={canReview}
              onPick={onPick}
              onOpenCharts={(id, name) => setAnalyticsRepo({ id, name })}
            />
          ))}
        </div>
      </div>
    </div>
    <RepoAnalyticsModal
      repoId={analyticsRepo?.id ?? null}
      repoName={analyticsRepo?.name ?? null}
      onClose={() => setAnalyticsRepo(null)}
    />
    </>
  );
}
