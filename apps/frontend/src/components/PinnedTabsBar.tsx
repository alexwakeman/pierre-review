import { usePinnedTabs, type Tab } from '../store/pinnedTabs.js';
import { MagnifierIcon } from './Icons.js';

// A single closable tab chip (pr-detail / pr-focus): fixed width, closable (✕). Clicking
// the body activates the tab (App.tsx renders the matching content). PR tabs show the PR
// title + author; a focus tab is marked with a magnifier icon + "PR focus" subtitle.
const MetricsIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="20" x2="4" y2="12" />
    <line x1="10" y1="20" x2="10" y2="6" />
    <line x1="16" y1="20" x2="16" y2="14" />
    <line x1="20" y1="20" x2="20" y2="9" />
  </svg>
);

function TabChip({ tab }: { tab: Tab }): JSX.Element {
  const active = usePinnedTabs((s) => s.activeTab === tab.key);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const closeTab = usePinnedTabs((s) => s.closeTab);

  // The metrics drill-down is a non-PR, singleton tab — render a compact chip (no PR meta).
  if (tab.kind === 'metrics-detail') {
    return (
      <div
        role="presentation"
        className={`group flex shrink-0 items-center gap-1 rounded-t-md border border-b-0 pl-2 pr-1 ${
          active
            ? 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950'
            : 'border-transparent bg-transparent hover:bg-gray-200/60 dark:hover:bg-gray-800/60'
        }`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onClick={() => setActiveTab(tab.key)}
          className="flex items-center gap-1.5 py-1.5 text-left"
          title="Flow metrics — drill-down"
        >
          <span aria-hidden="true" className="shrink-0 text-violet-500">
            {MetricsIcon}
          </span>
          <span
            className={`text-xs font-medium ${
              active ? 'text-violet-600 dark:text-violet-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            Flow metrics
          </span>
        </button>
        <button
          type="button"
          onClick={() => closeTab(tab.key)}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Close this tab"
          aria-label="Close flow-metrics tab"
        >
          ✕
        </button>
      </div>
    );
  }

  const isFocus = tab.kind === 'pr-focus';
  const meta = tab.meta;
  const author = meta?.authorDisplayName ?? meta?.authorLogin ?? 'unknown';

  const title = `${meta?.repoFullName ?? ''} #${meta?.number ?? ''} · ${meta?.title ?? ''}${
    isFocus ? ' (focus)' : ''
  }`;
  const closeAria = `Close ${isFocus ? 'focus' : 'detail'} tab for PR #${meta?.number ?? ''}`;

  return (
    <div
      role="presentation"
      className={`group flex w-52 shrink-0 items-center gap-1 rounded-t-md border border-b-0 pl-2 pr-1 ${
        active
          ? 'border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950'
          : 'border-transparent bg-transparent hover:bg-gray-200/60 dark:hover:bg-gray-800/60'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setActiveTab(tab.key)}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
        title={title}
      >
        {isFocus ? (
          <span aria-hidden="true" className="shrink-0 text-sky-500">
            <MagnifierIcon size={14} />
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
            <span className="text-gray-400">#{meta?.number}</span> {meta?.title}
          </span>
          <span className="truncate text-[10px] text-gray-500">
            {isFocus ? 'PR focus' : author}
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

// A permanent, NON-closable tab (Activity / Timeline). These live at the head of the strip
// as first-class tabs so the two core views read the same as the dynamic PR tabs — one
// clear place to switch, no separate header toggle (reduces confusion).
function FixedChip({
  active,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: JSX.Element;
  label: string;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-xs font-semibold ${
        active
          ? 'border-gray-300 bg-white text-blue-600 dark:border-gray-700 dark:bg-gray-950 dark:text-blue-400'
          : 'border-transparent bg-transparent text-gray-600 hover:bg-gray-200/60 dark:text-gray-300 dark:hover:bg-gray-800/60'
      }`}
    >
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      {label}
    </button>
  );
}

const ActivityIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);
const TimelineIcon = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="14" y2="12" />
    <line x1="4" y1="17" x2="18" y2="17" />
  </svg>
);

// The tab strip: Activity + Timeline are permanent, non-closable tabs at the head (the two
// core views — no separate header toggle); the dynamic pinned tabs (pr-detail / pr-focus)
// follow and are closable. Always shown, so switching views has one home.
export function PinnedTabsBar(): JSX.Element {
  const tabs = usePinnedTabs((s) => s.tabs);
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const showTimeline = usePinnedTabs((s) => s.showTimeline);
  return (
    <div
      data-testid="pinned-tabs"
      role="tablist"
      aria-label="Views"
      // Fixed min-height so the strip never shrinks when the (taller, two-line) PR tabs are
      // all closed — the Activity/Timeline chips alone are shorter, which otherwise made the
      // bar jump height. min-h pins it to the with-PR-tabs height.
      className="flex min-h-[42px] shrink-0 items-end gap-1 overflow-x-auto bg-gray-100 px-2 pt-1 dark:bg-gray-900"
    >
      <FixedChip
        active={activeTab === 'activity'}
        onClick={() => setActiveTab('activity')}
        icon={ActivityIcon}
        label="Activity"
        title="Activity — per-repo triage console"
      />
      <FixedChip
        active={activeTab === 'timeline'}
        onClick={showTimeline}
        icon={TimelineIcon}
        label="Timeline"
        title="Timeline — the activity board"
      />
      {tabs.map((t) => (
        <TabChip key={t.key} tab={t} />
      ))}
    </div>
  );
}
