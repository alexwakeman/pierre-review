import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EventType, PrDetail as PrDetailT, User } from '@pierre-review/shared';
import { usePr } from '../hooks/usePr.js';
import { api } from '../api/client.js';
import { useFilters } from '../store/filters.js';
import { dateTime, indexUsers, PR_STATE_META, relativeTime } from '../lib/ui.js';
import { Avatar } from './CommentCard.js';
import { UserName } from './UserName.js';
import { ShowOnTimeline } from './ShowOnTimeline.js';
import { ThreadList } from './ThreadList/index.js';
import { ChecksTab } from './ChecksTab.js';
import { Markdown } from './Markdown.js';
import { isNewComment, NewTag } from './ThreadView/index.js';

function newSummary(n: PrDetailT['newSinceLastViewed']): string | null {
  if (!n) return null;
  const parts: string[] = [];
  if (n.comments > 0) parts.push(`${n.comments} new comment${n.comments === 1 ? '' : 's'}`);
  if (n.reviews > 0) parts.push(`${n.reviews} new review${n.reviews === 1 ? '' : 's'}`);
  if (n.commits > 0) parts.push(`${n.commits} new commit${n.commits === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : null;
}

type Tab = 'overview' | 'threads' | 'activity';

interface ActivityRow {
  key: string;
  time: string;
  label: string;
  actorId: number | null;
  detail?: string;
  href?: string;
  // The timeline event this entry maps to, so "Show" can recenter on and glow
  // it. refId matches the event's ref_id (null for lifecycle, which has no
  // marker — "Show" just recenters on the PR bar then).
  event: { type: EventType; refId: number | null };
}

function buildActivity(pr: PrDetailT): ActivityRow[] {
  const rows: ActivityRow[] = [];
  rows.push({
    key: 'opened',
    time: pr.openedAt,
    label: 'opened this PR',
    actorId: pr.authorId,
    href: pr.githubUrl,
    event: { type: 'pr_opened', refId: null },
  });
  for (const c of pr.commits) {
    rows.push({
      key: `commit:${c.id}`,
      time: c.committedAt,
      label: 'pushed a commit',
      actorId: c.authorId ?? c.committerId,
      detail: c.message?.split('\n')[0],
      href: `${pr.githubUrl}/commits/${c.sha}`,
      event: { type: 'commit_pushed', refId: c.id },
    });
  }
  for (const r of pr.reviews) {
    rows.push({
      key: `review:${r.id}`,
      time: r.submittedAt,
      label: `reviewed (${r.state.replace('_', ' ')})`,
      actorId: r.authorId,
      detail: r.body ?? undefined,
      href: r.url ?? pr.githubUrl,
      event: { type: 'review_submitted', refId: r.id },
    });
  }
  for (const c of pr.comments) {
    rows.push({
      key: `comment:${c.id}`,
      time: c.createdAt,
      label: 'commented',
      actorId: c.authorId,
      detail: c.body,
      href: c.url ?? pr.githubUrl,
      event: { type: 'pr_comment', refId: c.id },
    });
  }
  if (pr.mergedAt) {
    rows.push({
      key: 'merged',
      time: pr.mergedAt,
      label: 'merged this PR',
      actorId: pr.authorId,
      href: pr.githubUrl,
      event: { type: 'pr_merged', refId: null },
    });
  } else if (pr.closedAt) {
    rows.push({
      key: 'closed',
      time: pr.closedAt,
      label: 'closed this PR',
      actorId: pr.authorId,
      href: pr.githubUrl,
      event: { type: 'pr_closed', refId: null },
    });
  }
  // Newest first.
  return rows.sort((a, b) => b.time.localeCompare(a.time));
}

function ActivityList({
  pr,
  usersById,
  since,
  onClearSince,
  focusEvent,
  onConsumed,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  since: string | null;
  onClearSince: () => void;
  // Deep link from the timeline (e.g. a commit popover): scroll to + flash the
  // matching entry, then consume the request.
  focusEvent: { type: EventType; refId: number | null } | null;
  onConsumed: () => void;
}): JSX.Element {
  const all = useMemo(() => buildActivity(pr), [pr]);
  const rows = since ? all.filter((r) => r.time > since) : all;
  const showEventOnTimeline = useFilters((s) => s.showEventOnTimeline);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [flashKey, setFlashKey] = useState<string | null>(null);

  // Scroll to + flash the targeted entry once it's rendered.
  useEffect(() => {
    if (!focusEvent) return;
    const row = all.find(
      (r) => r.event.type === focusEvent.type && r.event.refId === focusEvent.refId,
    );
    onConsumed();
    if (!row) return;
    rowRefs.current.get(row.key)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashKey(row.key);
  }, [focusEvent, all, onConsumed]);

  // Fade the flash after a beat — kept on its own key so consuming focusEvent
  // (which re-runs the effect above) can't cancel the timer early.
  useEffect(() => {
    if (flashKey == null) return;
    const t = setTimeout(() => setFlashKey(null), 1800);
    return () => clearTimeout(t);
  }, [flashKey]);

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
          <li
            key={r.key}
            ref={(el) => {
              if (el) rowRefs.current.set(r.key, el);
              else rowRefs.current.delete(r.key);
            }}
            className={`flex items-start gap-2 px-3 py-2 text-sm ${
              r.key === flashKey ? 'activity-flash' : ''
            }`}
          >
            <Avatar user={user} size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <UserName
                  user={user}
                  fallbackId={r.actorId}
                  repoId={pr.repoId}
                  className="font-medium"
                />
                <span className="text-gray-500">{r.label}</span>
                <span className="text-xs text-gray-400" title={dateTime(r.time)}>
                  · {dateTime(r.time)}
                </span>
              </div>
              {r.detail && (
                <div className="mt-0.5 truncate text-xs text-gray-500" title={r.detail}>
                  {r.detail.split('\n')[0]}
                </div>
              )}
              <div className="mt-1 flex items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => showEventOnTimeline(pr.id, r.time, r.event)}
                  className="text-blue-500 hover:underline"
                  title="Show this event on the timeline"
                >
                  Show
                </button>
                {r.href && (
                  <a
                    href={r.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-gray-400 hover:text-blue-500"
                  >
                    Open on GitHub ↗
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Issue-level PR comments (distinct from inline review threads). Each maps to a
// `pr_comment` timeline event whose refId is the comment row id, so "Show on
// timeline" reuses the same (type, refId) + recenter mechanism as the Activity
// tab.
function PrCommentsList({
  pr,
  usersById,
  viewedSince,
  focusCommentId,
  onFocusConsumed,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  viewedSince: string | null;
  // Deep link from the timeline (pr_comment popover → "Open in detail pane"):
  // scroll to + flash this comment card, then consume the request.
  focusCommentId: number | null;
  onFocusConsumed: () => void;
}): JSX.Element {
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const [flashId, setFlashId] = useState<number | null>(null);

  // Scroll to + flash the deep-linked comment once it's rendered, then consume the
  // request (the flash lives on its own state so consuming can't cancel it early).
  useEffect(() => {
    if (focusCommentId == null) return;
    onFocusConsumed();
    const el = cardRefs.current.get(focusCommentId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(focusCommentId);
  }, [focusCommentId, onFocusConsumed]);

  useEffect(() => {
    if (flashId == null) return;
    const t = setTimeout(() => setFlashId(null), 1800);
    return () => clearTimeout(t);
  }, [flashId]);

  if (pr.comments.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-gray-500">
        No PR comments on this PR.
      </div>
    );
  }

  // Newest first (the API returns them oldest-first by createdAt).
  const comments = [...pr.comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-2 px-3 pb-3">
      {comments.map((c) => {
        const user = c.authorId != null ? usersById.get(c.authorId) : undefined;
        const isNew = isNewComment(c.createdAt, viewedSince);
        return (
          <div
            key={c.id}
            ref={(el) => {
              if (el) cardRefs.current.set(c.id, el);
              else cardRefs.current.delete(c.id);
            }}
            className={`rounded-md border border-gray-200 px-2.5 py-2 dark:border-gray-800 ${
              isNew ? 'comment-new' : ''
            } ${c.id === flashId ? 'activity-flash' : ''}`}
          >
            <div className="flex items-center gap-2 text-xs">
              <ShowOnTimeline
                prId={pr.id}
                at={c.createdAt}
                event={{ type: 'pr_comment', refId: c.id }}
                title="Show this comment on the timeline"
              />
              <span className="text-gray-300 dark:text-gray-600">·</span>
              <Avatar user={user} size={18} />
              <UserName
                user={user}
                fallbackId={c.authorId}
                repoId={pr.repoId}
                className="font-semibold"
              />
              <span className="text-gray-400" title={dateTime(c.createdAt)}>
                {relativeTime(c.createdAt)}
              </span>
              {isNew && <NewTag />}
            </div>
            <div className="mt-1 text-sm">
              <Markdown>{c.body}</Markdown>
            </div>
            {c.url && (
              <div className="mt-2 pl-2 text-[11px]">
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-blue-500 hover:underline"
                >
                  ↗ View comment on GitHub
                </a>
              </div>
            )}
          </div>
        );
      })}
    </div>
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
  const [tab, setTab] = useState<Tab>('overview');
  const [activitySince, setActivitySince] = useState<string | null>(null);
  const qc = useQueryClient();
  const openPrFocused = useFilters((s) => s.openPrFocused);
  const focusPrOnTimeline = useFilters((s) => s.focusPrOnTimeline);
  const activityFocus = useFilters((s) => s.activityFocus);
  const consumeActivityFocus = useFilters((s) => s.consumeActivityFocus);
  const activityFocusForPr = useMemo(
    () =>
      activityFocus && pr && activityFocus.prId === pr.id
        ? { type: activityFocus.type, refId: activityFocus.refId }
        : null,
    [activityFocus, pr],
  );
  const commentFocus = useFilters((s) => s.commentFocus);
  const consumeCommentFocus = useFilters((s) => s.consumeCommentFocus);
  const commentFocusForPr =
    commentFocus && pr && commentFocus.prId === pr.id ? commentFocus.commentId : null;

  // Selecting a thread (e.g. via a timeline marker) forces the Threads tab,
  // where the thread list lives and auto-scrolls to the selected thread.
  useEffect(() => {
    if (selectedThreadId != null) setTab('threads');
  }, [selectedThreadId]);

  // A timeline deep link to an Activity entry (e.g. the commit popover) forces the
  // Activity tab and clears the "since" filter so the target is visible; the list
  // then scrolls to + flashes it.
  useEffect(() => {
    if (activityFocusForPr) {
      setTab('activity');
      setActivitySince(null);
    }
  }, [activityFocusForPr]);

  // A timeline deep link to a PR comment (the pr_comment popover's "Open in detail
  // pane") forces the Overview tab, where PrCommentsList then scrolls to + flashes
  // it. PrCommentsList consumes the signal (not here) once it has scrolled.
  useEffect(() => {
    if (commentFocusForPr != null) setTab('overview');
  }, [commentFocusForPr]);

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
          <button
            type="button"
            onClick={() => openPrFocused(pr.id)}
            className="shrink-0 font-medium text-blue-500 hover:underline"
            title="Centre and highlight this PR on the timeline"
          >
            Show
          </button>
          <button
            type="button"
            onClick={() => focusPrOnTimeline(pr.id)}
            className="shrink-0 font-medium text-blue-500 hover:underline"
            title="Isolate this PR and its contributors on the timeline (Exit focus / Esc to leave)"
          >
            Focus
          </button>
          <span className="text-gray-300 dark:text-gray-600">·</span>
          <Avatar user={author} size={16} />
          <UserName user={author} fallbackId={pr.authorId} repoId={pr.repoId} />
          <span>·</span>
          <span>{pr.repoFullName}</span>
          <span>·</span>
          <span>opened {relativeTime(pr.openedAt)}</span>
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200 px-3 dark:border-gray-800">
        {(['overview', 'threads', 'activity'] as Tab[]).map((t) => {
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
              {t === 'overview' && failing > 0 && (
                <span className="ml-1 text-red-500" title={`${failing} failing`}>
                  ●
                </span>
              )}
              {t === 'threads' && pr.threads.length > 0 && (
                <span className="ml-1 opacity-60" title={`${pr.threads.length} threads`}>
                  {pr.threads.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' ? (
          <div>
            <ChecksTab pr={pr} usersById={usersById} />
            <div className="border-t border-gray-200 dark:border-gray-800">
              <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                PR comments
                {pr.comments.length > 0 && (
                  <span className="ml-1 font-normal opacity-70">· {pr.comments.length}</span>
                )}
              </div>
              <PrCommentsList
                pr={pr}
                usersById={usersById}
                viewedSince={pr.lastViewedAt}
                focusCommentId={commentFocusForPr}
                onFocusConsumed={consumeCommentFocus}
              />
            </div>
          </div>
        ) : tab === 'threads' ? (
          <ThreadList
            threads={pr.threads}
            usersById={usersById}
            prUrl={pr.githubUrl}
            repoId={pr.repoId}
            selectedThreadId={selectedThreadId}
            viewedSince={pr.lastViewedAt}
          />
        ) : (
          <ActivityList
            pr={pr}
            usersById={usersById}
            since={activitySince}
            onClearSince={() => setActivitySince(null)}
            focusEvent={activityFocusForPr}
            onConsumed={consumeActivityFocus}
          />
        )}
      </div>
    </div>
  );
}
