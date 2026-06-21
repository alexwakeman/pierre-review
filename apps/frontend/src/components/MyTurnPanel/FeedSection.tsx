import { useEffect, useMemo, useRef } from 'react';
import type { EventType, FeedEvent, ReviewState, User } from '@pierre-review/shared';
import { useUsers } from '../../hooks/useTimeline.js';
import { useFilters } from '../../store/filters.js';
import { useFeedStore } from '../../store/feed.js';
import { EVENT_META, indexUsers, relativeTime } from '../../lib/ui.js';
import { UserName } from '../UserName.js';

// Past-tense phrasing for the actor line ("@dana merged …"). Lifecycle verbs carry the
// whole meaning; comments/reviews add a detail subsection below.
const VERB: Record<EventType, string> = {
  pr_opened: 'opened',
  pr_merged: 'merged',
  pr_closed: 'closed',
  pr_reopened: 'reopened',
  pr_ready_for_review: 'marked ready for review',
  review_submitted: 'reviewed',
  review_comment: 'commented on a thread in',
  pr_comment: 'commented on',
  commit_pushed: 'pushed to', // excluded from the feed; here for type-completeness
};

// Verdict badge for review_submitted entries (mirrors ChecksTab's reviewer badges).
const VERDICT: Record<ReviewState, { label: string; cls: string } | null> = {
  approved: { label: 'approved', cls: 'bg-green-500/10 text-green-700 dark:text-green-400' },
  changes_requested: {
    label: 'changes requested',
    cls: 'bg-red-500/10 text-red-700 dark:text-red-400',
  },
  commented: { label: 'commented', cls: 'bg-gray-500/10 text-gray-600 dark:text-gray-300' },
  dismissed: { label: 'dismissed', cls: 'bg-gray-500/10 text-gray-400' },
  pending: null,
};

function FeedRow({
  ev,
  isNew,
  usersById,
}: {
  ev: FeedEvent;
  isNew: boolean;
  usersById: Map<number, User>;
}): JSX.Element {
  const openFeedEventOnTimeline = useFilters((s) => s.openFeedEventOnTimeline);
  const meta = EVENT_META[ev.type];
  const actor = ev.actorId != null ? usersById.get(ev.actorId) : undefined;
  const verdict = ev.reviewState ? VERDICT[ev.reviewState] : null;

  // Reveal this event on the timeline: open its marker popover (so the comment/
  // review content reads inline) + highlight it; a cross-person entry enters PR
  // Focus mode first. Lifecycle entries (no marker) just centre + glow as before.
  const show = (): void => {
    if (ev.prId == null) return;
    openFeedEventOnTimeline(ev.prId, ev.occurredAt, { type: ev.type, refId: ev.refId });
  };

  return (
    <li
      className={`rounded px-2 py-2 hover:bg-gray-50 dark:hover:bg-gray-900/40 [contain-intrinsic-size:auto_72px] [content-visibility:auto] ${
        isNew ? 'border-l-2 border-blue-400 bg-blue-50/40 dark:bg-blue-500/5' : 'border-l-2 border-transparent'
      }`}
    >
      <div className="flex gap-2">
        <span
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: meta.color }}
          title={meta.label}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm">
            <UserName user={actor} fallbackId={ev.actorId} repoId={ev.repoId} />
            <span className="text-gray-500 dark:text-gray-400"> {VERB[ev.type]} </span>
            <button
              type="button"
              onClick={show}
              className="font-medium text-gray-800 hover:underline disabled:no-underline dark:text-gray-100"
              disabled={ev.prId == null}
              title="Show on the timeline"
            >
              {ev.repoFullName}
              {ev.prNumber != null && ` #${ev.prNumber}`}
            </button>
          </div>
          {ev.prTitle && (
            <button
              type="button"
              onClick={show}
              disabled={ev.prId == null}
              className="block w-full truncate text-left text-xs text-gray-400 hover:underline"
            >
              {ev.prTitle}
            </button>
          )}
          {/* Per-activity detail subsection */}
          {verdict && (
            <span
              className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${verdict.cls}`}
            >
              {verdict.label}
            </span>
          )}
          {ev.excerpt && (
            <div className="mt-0.5 truncate text-xs italic text-gray-500 dark:text-gray-400">
              “{ev.excerpt}”
            </div>
          )}
          <div className="mt-0.5 text-[11px] text-gray-400">
            {relativeTime(ev.occurredAt)}
            {ev.prId != null && (
              <>
                {' · '}
                <button type="button" onClick={show} className="hover:underline">
                  Show on timeline
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// The "Feed" tab: a reverse-chronological activity stream across your Watched repos
// (last 14 days), read from the append-only IndexedDB store (kept fresh by useFeedSync
// at App level). Each entry links to + highlights the timeline. Marks the feed seen on
// mount so the tab badge clears, while still highlighting what was new this visit.
export function FeedSection(): JSX.Element {
  const events = useFeedStore((s) => s.events);
  const seenAt = useFeedStore((s) => s.seenAt);
  const markSeen = useFeedStore((s) => s.markSeen);

  // Build the user index ONCE here, not per row. FeedRow used to call
  // useUsers() + indexUsers() itself, so a feed of N rows created N query
  // observers and rebuilt the whole user Map N times on every mount — the bulk of
  // the deselect re-render cost (this panel re-mounts whenever a PR is deselected).
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);

  // Freeze the "new" boundary at the value it had when the tab opened, then mark seen
  // so the badge clears — entries above the frozen line keep their highlight this visit.
  const newBoundary = useRef(seenAt);
  useEffect(() => {
    markSeen();
  }, [markSeen]);

  const rows = useMemo(
    () =>
      events.map((ev) => (
        <FeedRow
          key={ev.id}
          ev={ev}
          isNew={Date.parse(ev.occurredAt) > newBoundary.current}
          usersById={usersById}
        />
      )),
    [events, usersById],
  );

  if (events.length === 0) {
    return (
      <div className="px-1 py-6 text-sm text-gray-500">
        No recent activity in your watched repos. Watch a repo (the eye toggle in the repo
        list) to start tracking its activity here.
      </div>
    );
  }

  return <ul className="space-y-0.5">{rows}</ul>;
}
