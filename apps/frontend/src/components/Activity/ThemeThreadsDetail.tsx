import { useMemo } from 'react';
import type { ThemePrRef, ThemeThreadRef } from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../../store/pinnedTabs.js';
import { usePr } from '../../hooks/usePr.js';
import { indexUsers } from '../../lib/ui.js';
import { ThreadCard } from '../ThreadView/index.js';
import { CommentCard } from '../CommentCard.js';
import { SeverityPill } from './ThemesReportView.js';

// The "click a theme card → all its threads" drill-down (ephemeral singleton tab). It renders the
// concrete review threads / PR-level comments a Bot or Human theme groups, using the SAME ThreadCard
// (full metadata + follow-up comments) the PR detail Threads tab uses. Grouped by PR; each group
// fetches that PR's detail once and can open the PR in its own tab. The theme is the transient seed
// (store `themeThreadsSeed`); nothing is fetched beyond the involved PRs' detail.

const PR_GROUP_CAP = 12; // PRs rendered (a firehose theme is capped; the rest noted)

export function prRefToMeta(pr: {
  prId: number;
  prNumber: number;
  repoFullName: string;
  title?: string | null;
  authorLogin?: string | null;
}): TabMeta {
  return {
    id: pr.prId,
    number: pr.prNumber,
    title: pr.title ?? `#${pr.prNumber}`,
    repoFullName: pr.repoFullName,
    authorLogin: pr.authorLogin ?? null,
    authorDisplayName: null,
    authorAvatarUrl: null,
  };
}

// One PR's member threads/comments. Fetches the PR detail once; renders the threads whose id is in
// the theme's member set (+ member PR-level comments). Header opens the PR in its own detail tab.
function ThemePrGroup({
  prId,
  prNumber,
  repoFullName,
  refs,
}: {
  prId: number;
  prNumber: number;
  repoFullName: string;
  refs: ThemeThreadRef[];
}): JSX.Element {
  const { data: pr, isLoading } = usePr(prId);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const usersById = useMemo(() => indexUsers(pr?.users), [pr]);

  const threadIds = new Set<number>();
  const commentIds = new Set<number>();
  for (const r of refs) {
    if (r.source === 'review' && r.threadId != null) threadIds.add(r.threadId);
    else if (r.source === 'issue' && r.commentId != null) commentIds.add(r.commentId);
  }
  const memberThreads = (pr?.threads ?? []).filter((t) => threadIds.has(t.id));
  const memberComments = (pr?.comments ?? []).filter((c) => commentIds.has(c.id));
  const authorLogin = pr?.authorId != null ? usersById.get(pr.authorId)?.githubLogin ?? null : null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900/50">
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-mono text-gray-500">{repoFullName}</span>{' '}
          <span className="font-semibold text-gray-800 dark:text-gray-100">#{prNumber}</span>
          {pr?.title ? <span className="text-gray-600 dark:text-gray-300"> — {pr.title}</span> : null}
        </span>
        <button
          type="button"
          onClick={() =>
            openPrDetailTab(
              prRefToMeta({ prId, prNumber, repoFullName, title: pr?.title, authorLogin }),
              { fromActivity: true },
            )
          }
          className="shrink-0 rounded border border-sky-300 px-2 py-0.5 text-[11px] font-medium text-sky-600 hover:bg-sky-50 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950/40"
        >
          Open PR →
        </button>
      </div>
      <div className="space-y-2 p-3">
        {isLoading && !pr ? (
          <div className="h-16 animate-pulse rounded bg-gray-100 dark:bg-gray-900" />
        ) : (
          <>
            {memberThreads.map((t) => (
              <ThreadCard
                key={`t${t.id}`}
                thread={t}
                usersById={usersById}
                prUrl={pr!.githubUrl}
                repoId={pr!.repoId}
              />
            ))}
            {memberComments.map((c) => (
              <CommentCard key={`c${c.id}`} comment={c} usersById={usersById} repoId={pr?.repoId} />
            ))}
            {memberThreads.length === 0 && memberComments.length === 0 && (
              <div className="text-[12px] text-gray-400">
                {refs.length} comment{refs.length === 1 ? '' : 's'} in this PR — not currently loaded
                (the thread may be outdated or still hydrating).
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface PrGroup {
  prId: number;
  prNumber: number;
  repoFullName: string;
  refs: ThemeThreadRef[];
}

export function ThemeThreadsDetail(): JSX.Element {
  const seed = useFilters((s) => s.themeThreadsSeed);
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);

  if (!seed) return <div className="p-6 text-sm text-gray-400">No theme selected.</div>;
  const { theme, source } = seed;

  // Group member threads by PR (first-appearance order).
  const groups: PrGroup[] = [];
  const byPr = new Map<number, PrGroup>();
  for (const r of theme.threads) {
    let g = byPr.get(r.prId);
    if (!g) {
      g = { prId: r.prId, prNumber: r.prNumber, repoFullName: r.repoFullName, refs: [] };
      byPr.set(r.prId, g);
      groups.push(g);
    }
    g.refs.push(r);
  }
  const shown = groups.slice(0, PR_GROUP_CAP);
  const hiddenGroups = groups.length - shown.length;

  return (
    <div className="mx-auto max-w-[100rem] space-y-4 p-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityPill severity={theme.severity} />
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{theme.title}</h2>
          <span className="rounded bg-gray-100 px-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {source === 'bot' ? 'Bot theme' : 'Discussion theme'}
          </span>
        </div>
        {theme.summary && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{theme.summary}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
          <span>
            {theme.threads.length} thread{theme.threads.length === 1 ? '' : 's'} across {groups.length}{' '}
            PR{groups.length === 1 ? '' : 's'}
          </span>
          {theme.prs.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              {theme.prs.map((pr: ThemePrRef) => (
                <button
                  key={pr.prId}
                  type="button"
                  onClick={() => openPrDetailTab(prRefToMeta(pr), { fromActivity: true })}
                  className="rounded px-1 tabular-nums text-sky-600 hover:bg-sky-100 hover:underline dark:text-sky-400 dark:hover:bg-sky-950/50"
                  title={`${pr.repoFullName}#${pr.prNumber} — open PR`}
                >
                  #{pr.prNumber}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>

      {theme.threads.length === 0 ? (
        <div className="text-sm text-gray-400">This theme has no linked threads.</div>
      ) : (
        <div className="space-y-3">
          {shown.map((g) => (
            <ThemePrGroup
              key={g.prId}
              prId={g.prId}
              prNumber={g.prNumber}
              repoFullName={g.repoFullName}
              refs={g.refs}
            />
          ))}
          {hiddenGroups > 0 && (
            <div className="text-[12px] text-gray-400">
              + {hiddenGroups} more PR{hiddenGroups === 1 ? '' : 's'} not shown.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
