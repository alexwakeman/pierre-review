import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PrDetail as PrDetailT, User } from '@gh-team-monitor/shared';
import { usePr } from '../hooks/usePr.js';
import { api } from '../api/client.js';
import { indexUsers, PR_STATE_META, relativeTime, userLabel } from '../lib/ui.js';
import { Avatar } from './CommentCard.js';
import { ThreadList } from './ThreadList/index.js';
import { ChecksTab } from './ChecksTab.js';
import { Markdown } from './Markdown.js';

function newSummary(n: PrDetailT['newSinceLastViewed']): string | null {
  if (!n) return null;
  const parts: string[] = [];
  if (n.comments > 0) parts.push(`${n.comments} new comment${n.comments === 1 ? '' : 's'}`);
  if (n.reviews > 0) parts.push(`${n.reviews} new review${n.reviews === 1 ? '' : 's'}`);
  if (n.commits > 0) parts.push(`${n.commits} new commit${n.commits === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : null;
}

type Tab = 'checks' | 'threads' | 'activity';

interface ActivityRow {
  key: string;
  time: string;
  label: string;
  actorId: number | null;
  detail?: string;
  href?: string;
}

function buildActivity(pr: PrDetailT): ActivityRow[] {
  const rows: ActivityRow[] = [];
  rows.push({
    key: 'opened',
    time: pr.openedAt,
    label: 'opened this PR',
    actorId: pr.authorId,
    href: pr.githubUrl,
  });
  for (const c of pr.commits) {
    rows.push({
      key: `commit:${c.id}`,
      time: c.committedAt,
      label: 'pushed a commit',
      actorId: c.authorId ?? c.committerId,
      detail: c.message?.split('\n')[0],
      href: `${pr.githubUrl}/commits/${c.sha}`,
    });
  }
  for (const r of pr.reviews) {
    rows.push({
      key: `review:${r.id}`,
      time: r.submittedAt,
      label: `reviewed (${r.state.replace('_', ' ')})`,
      actorId: r.authorId,
      detail: r.body ?? undefined,
      href: pr.githubUrl,
    });
  }
  for (const c of pr.comments) {
    rows.push({
      key: `comment:${c.id}`,
      time: c.createdAt,
      label: 'commented',
      actorId: c.authorId,
      detail: c.body,
      href: pr.githubUrl,
    });
  }
  if (pr.mergedAt) {
    rows.push({ key: 'merged', time: pr.mergedAt, label: 'merged this PR', actorId: pr.authorId, href: pr.githubUrl });
  } else if (pr.closedAt) {
    rows.push({ key: 'closed', time: pr.closedAt, label: 'closed this PR', actorId: pr.authorId, href: pr.githubUrl });
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time));
}

function ActivityList({
  pr,
  usersById,
  since,
  onClearSince,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  since: string | null;
  onClearSince: () => void;
}): JSX.Element {
  const all = useMemo(() => buildActivity(pr), [pr]);
  const rows = since ? all.filter((r) => r.time > since) : all;
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {since && (
        <li className="flex items-center gap-2 bg-sky-500/5 px-3 py-1.5 text-xs text-sky-600 dark:text-sky-400">
          <span>Showing {rows.length} since you last looked</span>
          <button
            type="button"
            onClick={onClearSince}
            className="ml-auto text-gray-400 hover:text-gray-600"
          >
            show all
          </button>
        </li>
      )}
      {rows.map((r) => {
        const user = r.actorId != null ? usersById.get(r.actorId) : undefined;
        return (
          <li key={r.key} className="flex items-start gap-2 px-3 py-2 text-sm">
            <Avatar user={user} size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{userLabel(user, r.actorId)}</span>
                <span className="text-gray-500">{r.label}</span>
                <a
                  href={r.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="ml-auto shrink-0 text-xs text-gray-400 hover:text-blue-500"
                >
                  {relativeTime(r.time)}
                </a>
              </div>
              {r.detail && (
                <div className="mt-0.5 truncate text-xs text-gray-500" title={r.detail}>
                  {r.detail.split('\n')[0]}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PrDetail({
  prId,
  selectedThreadId,
}: {
  prId: number;
  selectedThreadId: number | null;
}): JSX.Element {
  const { data: pr, isLoading, error } = usePr(prId);
  const [tab, setTab] = useState<Tab>('checks');
  const [activitySince, setActivitySince] = useState<string | null>(null);
  const qc = useQueryClient();

  // Selecting a thread (e.g. via a timeline marker) forces the Threads tab.
  useEffect(() => {
    if (selectedThreadId != null) setTab('threads');
  }, [selectedThreadId]);

  // Capture the last-viewed instant before marking (so new comments highlight
  // on this visit), then mark the PR viewed and refresh the list views' badges.
  // We deliberately do NOT invalidate this PR's own query.
  const markViewed = useMutation({
    mutationFn: (id: number) => api.markPrViewed(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const markedRef = useRef<number | null>(null);
  useEffect(() => {
    if (pr && markedRef.current !== pr.id) {
      markedRef.current = pr.id;
      markViewed.mutate(pr.id);
    }
  }, [pr, markViewed]);

  const usersById = useMemo(() => indexUsers(pr?.users), [pr]);

  if (isLoading) {
    return <div className="p-4 text-sm text-gray-500">Loading PR…</div>;
  }
  if (error || !pr) {
    return (
      <div className="p-4 text-sm text-red-500">
        {error ? String(error) : 'PR not found'}
      </div>
    );
  }

  const stateMeta = PR_STATE_META[pr.state];
  const author = pr.authorId != null ? usersById.get(pr.authorId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 px-4 py-2 pr-28 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-xs font-semibold text-white"
            style={{ backgroundColor: stateMeta.color }}
          >
            {pr.isDraft ? 'Draft' : stateMeta.label}
          </span>
          <a
            href={pr.githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate text-sm font-semibold hover:underline"
            title={pr.title}
          >
            <span className="text-gray-400">#{pr.number}</span> {pr.title}
          </a>
          {pr.isStalled && (
            <span
              className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs font-medium text-red-500"
              title="Open, no recent commits, and has open threads"
            >
              Stalled
            </span>
          )}
          {(() => {
            const summary = newSummary(pr.newSinceLastViewed);
            return summary ? (
              <button
                type="button"
                onClick={() => {
                  setTab('activity');
                  setActivitySince(pr.lastViewedAt);
                }}
                className="ml-auto shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium text-sky-500 hover:bg-sky-500/25"
                title="Filter activity to what's new since you last looked"
              >
                👁 {summary}
              </button>
            ) : null;
          })()}
          <a
            href={pr.githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={`${newSummary(pr.newSinceLastViewed) ? '' : 'ml-auto'} shrink-0 text-xs text-blue-500 hover:underline`}
          >
            open on GitHub ↗
          </a>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
          <Avatar user={author} size={16} />
          <span>{userLabel(author, pr.authorId)}</span>
          <span>·</span>
          <span>{pr.repoFullName}</span>
          <span>·</span>
          <span>opened {relativeTime(pr.openedAt)}</span>
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200 px-3 dark:border-gray-800">
        {(['checks', 'threads', 'activity'] as Tab[]).map((t) => {
          const failing = pr.checkRuns.filter(
            (c) => c.state === 'failure' || c.state === 'error',
          ).length;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs capitalize ${
                tab === t
                  ? 'border-blue-500 text-blue-500'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t}
              {t === 'checks' && failing > 0 && (
                <span className="ml-1 text-red-500" title={`${failing} failing`}>
                  ●
                </span>
              )}
              {t === 'threads' && pr.threads.length > 0 && (
                <span className="ml-1 opacity-60">{pr.threads.length}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'checks' ? (
          <ChecksTab pr={pr} usersById={usersById} />
        ) : tab === 'threads' ? (
          <ThreadList
            threads={pr.threads}
            usersById={usersById}
            prUrl={pr.githubUrl}
            selectedThreadId={selectedThreadId}
            viewedSince={pr.lastViewedAt}
          />
        ) : (
          <ActivityList
            pr={pr}
            usersById={usersById}
            since={activitySince}
            onClearSince={() => setActivitySince(null)}
          />
        )}
      </div>
    </div>
  );
}
