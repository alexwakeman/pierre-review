import { usePinnedTabs, type Tab } from '../store/pinnedTabs.js';

// A single tab chip: fixed width, closable (✕). Clicking the body activates the tab
// (App.tsx renders the matching content — a PrDetail overlay for pr-detail, or an
// isolated Timeline for pr-focus / my-turn). PR tabs show the PR title + author;
// the My-Turn tab is glyph + label. Items 8/10/11: every tab is closable and there
// is no redundant "Timeline" tab (the header Timeline|Inbox pill is the board exit).
function TabChip({ tab }: { tab: Tab }): JSX.Element {
  const active = usePinnedTabs((s) => s.activeTab === tab.key);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const closeTab = usePinnedTabs((s) => s.closeTab);

  const isFocus = tab.kind === 'pr-focus';
  const isMyTurn = tab.kind === 'my-turn';
  const meta = tab.meta;
  const author = meta?.authorDisplayName ?? meta?.authorLogin ?? 'unknown';

  const title = isMyTurn
    ? 'My Turn — your triage inbox, isolated on the timeline'
    : `${meta?.repoFullName ?? ''} #${meta?.number ?? ''} · ${meta?.title ?? ''}${
        isFocus ? ' (focus)' : ''
      }`;
  const closeAria = isMyTurn
    ? 'Close My Turn tab'
    : `Close ${isFocus ? 'focus' : 'detail'} tab for PR #${meta?.number ?? ''}`;

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
        onClick={() => setActiveTab(tab.key)}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
        title={title}
        aria-current={active ? 'page' : undefined}
      >
        {isMyTurn ? (
          <span aria-hidden="true" className="shrink-0 text-amber-500">
            ✓
          </span>
        ) : isFocus ? (
          <span aria-hidden="true" className="shrink-0 text-sky-500">
            ◎
          </span>
        ) : meta?.authorAvatarUrl != null ? (
          <img
            src={meta.authorAvatarUrl}
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
            {isMyTurn ? (
              'My Turn'
            ) : (
              <>
                <span className="text-gray-400">#{meta?.number}</span> {meta?.title}
              </>
            )}
          </span>
          <span className="truncate text-[10px] text-gray-500">
            {isMyTurn ? 'Your triage inbox' : isFocus ? 'PR focus' : author}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => closeTab(tab.key)}
        className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        title="Close this tab"
        aria-label={closeAria}
      >
        ✕
      </button>
    </div>
  );
}

// The tab strip, shown under the Open-PRs bar once at least one persistent tab
// exists (a pinned PR-detail, a PR-focus, or the My-Turn tab). There is no
// "Timeline" tab here — item 11: the header Timeline|Inbox pill is the board
// affordance. Hidden entirely when nothing is open, so the default UI is unchanged.
export function PinnedTabsBar(): JSX.Element | null {
  const tabs = usePinnedTabs((s) => s.tabs);
  if (tabs.length === 0) return null;
  return (
    <div
      data-testid="pinned-tabs"
      className="flex shrink-0 items-end gap-1 overflow-x-auto bg-gray-100 px-2 pt-1 dark:bg-gray-900"
    >
      {tabs.map((t) => (
        <TabChip key={t.key} tab={t} />
      ))}
    </div>
  );
}
