import { useMemo } from 'react';
import { FEED_WINDOW_DAYS } from '@pierre-review/shared';
import { usePinnedTabs, parseUserActivityKey } from '../../store/pinnedTabs.js';
import { useUsers } from '../../hooks/useTimeline.js';
import { profileUrl, userLabel } from '../../lib/ui.js';
import { ExternalLinkIcon } from '../Icons.js';
import { FeedView } from './FeedView.js';

// ONE contributor's activity — the same consolidated Feed, the same cards (PR events,
// reviews, comments, thread replies, thread-addressing commit runs), filtered to that person
// as the ACTOR. Opened from the user popover's "View activity"; keyed per user, so several
// people's feeds can sit side by side in the tab strip.
//
// Note on merge/close rows: those events are recorded against the PR's AUTHOR (that is how
// the whole feed works, see sync/upsert.ts), so on this tab they mean "a PR they authored was
// merged/closed", not "they pressed merge". The caption says so rather than pretending
// otherwise.
export function UserActivityDetail(): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const { data: users } = useUsers();

  // The tab's own key carries the user id — no seed to consume, so re-opening the same
  // person's tab (or reloading into a stale key) can never show someone else's feed.
  const userId = parseUserActivityKey(activeTab);
  const tab = tabs.find((t) => t.key === activeTab) ?? null;
  const user = useMemo(
    () => (userId != null ? (users ?? []).find((u) => u.id === userId) : undefined),
    [users, userId],
  );

  // Prefer the live roster; fall back to the label metadata captured when the tab was opened
  // (the roster query may not have loaded yet, or the actor may have aged out of it).
  const login = user?.githubLogin ?? tab?.userMeta?.login ?? null;
  const avatarUrl = user?.avatarUrl ?? tab?.userMeta?.avatarUrl ?? null;
  const label = user
    ? userLabel(user, userId ?? 0)
    : (tab?.userMeta?.displayName ?? tab?.userMeta?.login ?? `user ${userId ?? '?'}`);

  if (userId == null) {
    return (
      <div className="p-4 text-body text-ui-mute">
        No contributor selected.
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            width={32}
            height={32}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-8 w-8 shrink-0 rounded-full bg-ui-raise"
          />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ui-hover text-meta font-semibold text-ui-mute">
            {(label[0] ?? '?').toUpperCase()}
          </span>
        )}
        <h2 className="text-title font-semibold text-ui-ink">
          {label}
          <span className="font-normal text-ui-faint"> · activity</span>
        </h2>
        {/* The scope caption is a FIXED string now, and deliberately so: the feed below covers
            every repo in the active Workspace. It used to name the FilterBar's per-repo
            visibility, which is a Timeline-board filter the feed no longer honours — a caption
            reading "across 2 repos" over a Workspace-wide feed is worse than no caption. */}
        <span className="text-meta text-ui-faint">
          last {FEED_WINDOW_DAYS} days · across this Workspace · merge/close rows are PRs they authored
        </span>
        {login && (
          <a
            href={profileUrl(login)}
            target="_blank"
            rel="noreferrer noopener"
            className="hit bg-ui-raise ml-auto inline-flex items-center gap-0.5 rounded-ui px-1.5 py-0.5 text-meta font-medium text-ui-mute hover:bg-ui-hover"
            title={`@${login} on GitHub`}
          >
            GitHub
            <ExternalLinkIcon size={10} />
          </a>
        )}
      </div>

      {/* The feed itself — the shared FeedView, scoped to this one actor. It skips the
          server "seen" marker, the new-item auto-insert and the "New" marker under a userIds scope. */}
      <UserFeed userId={userId} />
    </div>
  );
}

// Split out so the actor array is memoised on the userId alone — an inline `[userId]` would
// be a fresh array every render, churning FeedView's effect deps for no reason.
function UserFeed({ userId }: { userId: number }): JSX.Element {
  const userIds = useMemo(() => [userId], [userId]);
  return <FeedView userIds={userIds} />;
}
