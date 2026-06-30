import { usePinnedTabs, type PinnedPr } from '../store/pinnedTabs.js';
import { useFilters } from '../store/filters.js';

// The "focus tab": the active timeline-focus (My Turn inbox, or an isolated PR) shown
// as its own tab. With the shared-timeline-focus model there's at most one at a time,
// and it's a STATE of the one timeline (not a separate ActiveTab value) — so it's
// active whenever the board is showing and a focus is engaged. Clicking it re-shows
// the focused board; the plain "Timeline" tab exits the focus.
function FocusTab({ label }: { label: string }): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const active = activeTab === 'timeline';
  return (
    <button
      type="button"
      onClick={() => setActiveTab('timeline')}
      className={`flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
        active
          ? 'border-gray-300 bg-white text-sky-600 dark:border-gray-700 dark:bg-gray-950 dark:text-sky-400'
          : 'border-transparent bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800'
      }`}
      title="The focused board"
      aria-current={active ? 'page' : undefined}
    >
      <span aria-hidden="true">◎</span>
      {label}
    </button>
  );
}

// A single pinned-PR tab: fixed width, two lines (title + author), with an ✕ to
// unpin. Clicking the body opens the PR full-screen (sets it as the active tab).
function PinnedTab({ pr }: { pr: PinnedPr }): JSX.Element {
  const active = usePinnedTabs((s) => s.activeTab === pr.id);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const unpin = usePinnedTabs((s) => s.unpin);

  const author = pr.authorDisplayName ?? pr.authorLogin ?? 'unknown';

  return (
    <div
      className={`group flex w-52 shrink-0 items-center gap-1 rounded-t-md border border-b-0 pl-2 pr-1 ${
        active
          ? 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950'
          : 'border-transparent bg-transparent hover:bg-gray-200/60 dark:hover:bg-gray-800/60'
      }`}
    >
      <button
        type="button"
        onClick={() => setActiveTab(pr.id)}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
        title={`${pr.repoFullName} #${pr.number} · ${pr.title}`}
        aria-current={active ? 'page' : undefined}
      >
        {pr.authorAvatarUrl != null ? (
          <img
            src={pr.authorAvatarUrl}
            alt={author}
            width={16}
            height={16}
            className="shrink-0 rounded-full"
            style={{ width: 16, height: 16 }}
          />
        ) : (
          <span
            className="flex shrink-0 items-center justify-center rounded-full bg-gray-300 text-[8px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
            style={{ width: 16, height: 16 }}
          >
            {author.slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span
            className={`truncate text-xs font-medium ${
              active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            <span className="text-gray-400">#{pr.number}</span> {pr.title}
          </span>
          <span className="truncate text-[10px] text-gray-500">{author}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => unpin(pr.id)}
        className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        title="Unpin this PR (remove its tab)"
        aria-label={`Unpin PR #${pr.number}`}
      >
        ✕
      </button>
    </div>
  );
}

// The pinned-PR tab strip, shown under the Open-PRs bar once at least one PR is
// pinned. The leftmost "Timeline" tab returns to the standard board; each pinned
// PR is a tab that opens it full-screen (App.tsx renders the overlay). Hidden
// entirely when nothing is pinned, so the default UI is unchanged.
export function PinnedTabsBar(): JSX.Element | null {
  const pinned = usePinnedTabs((s) => s.pinned);
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const showTimeline = usePinnedTabs((s) => s.showTimeline);
  // A timeline-focus is engaged: My Turn Focus Mode, or a PR-isolation overlay.
  const myTurnOnly = useFilters((s) => s.myTurnOnly);
  const focusActive = useFilters((s) => s.focusActive);
  const exitMyTurnFocus = useFilters((s) => s.exitMyTurnFocus);
  const exitFocus = useFilters((s) => s.exitFocus);
  const focusEngaged = myTurnOnly || focusActive;
  // The plain "Timeline" tab is active only on the UN-focused board.
  const timelineActive = activeTab === 'timeline' && !focusEngaged;

  // Show the bar once there's a pinned PR OR a focus to represent as a tab.
  if (pinned.length === 0 && !focusEngaged) return null;

  return (
    // No bottom border on the bar + no `-mb-px` overlap trick: the bar's `overflow-x-auto`
    // clips both axes (CSS overflow spec), which would chop any 1px negative-margin
    // connector. Instead each active tab is a rounded card (open bottom, opaque bg) that
    // reads as connected to the content below on its own.
    <div
      data-testid="pinned-tabs"
      className="flex shrink-0 items-end gap-1 overflow-x-auto bg-gray-100 px-2 pt-1 dark:bg-gray-900"
    >
      {/* `sticky left-0` keeps the Timeline tab reachable however many PRs are pinned —
          tabs scroll under it; its opaque bg (matching the bar) hides them. */}
      <button
        type="button"
        onClick={() => {
          // "Timeline" is the un-focused board: leave any focus, then show it.
          if (focusEngaged) {
            exitMyTurnFocus();
            exitFocus();
          }
          showTimeline();
        }}
        className={`sticky left-0 z-10 flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-medium ${
          timelineActive
            ? 'border-gray-300 bg-white text-blue-600 dark:border-gray-700 dark:bg-gray-950 dark:text-blue-400'
            : 'border-transparent bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800'
        }`}
        title="Return to the full timeline (leaves focus)"
        aria-current={timelineActive ? 'page' : undefined}
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="15" y2="12" />
          <line x1="3" y1="18" x2="18" y2="18" />
        </svg>
        Timeline
      </button>
      {focusEngaged && <FocusTab label={myTurnOnly ? 'My Turn' : 'PR Focus'} />}
      {pinned.map((pr) => (
        <PinnedTab key={pr.id} pr={pr} />
      ))}
    </div>
  );
}
