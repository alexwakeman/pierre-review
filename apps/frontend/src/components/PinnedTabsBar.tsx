import { usePinnedTabs, type Tab } from '../store/pinnedTabs.js';
import { useFilters } from '../store/filters.js';
import { useRepos } from '../hooks/useTimeline.js';
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
// A git-pull-request glyph for the all-open-PRs drill-down chip.
const OpenPrsIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="6" y1="9" x2="6" y2="15" />
    <circle cx="18" cy="18" r="3" />
    <path d="M18 15V9a3 3 0 0 0-3-3h-3" />
  </svg>
);

function TabChip({ tab }: { tab: Tab }): JSX.Element {
  const active = usePinnedTabs((s) => s.activeTab === tab.key);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const closeTab = usePinnedTabs((s) => s.closeTab);
  // Repo-scoped drill-down chips (bot-only-prs / bot-threads / open-prs) show the repo name so a
  // per-repo tab is easy to track. These hooks run UNCONDITIONALLY (before the kind branches) to
  // satisfy the Rules of Hooks — TabChip renders for every tab; only the branches below use them.
  const botOnlyRepoId = useFilters((s) => s.botOnlyFocusRepoId);
  const botThreadsRepoId = useFilters((s) => s.botThreadsFocusRepoId);
  const themeThreadsSeed = useFilters((s) => s.themeThreadsSeed);
  const searchSeed = useFilters((s) => s.searchSeed);
  const openPrsScope = useFilters((s) => s.openPrsScope);
  const { data: repos } = useRepos();
  const repoName = (id: number | null): string | null =>
    id != null ? ((repos ?? []).find((r) => r.id === id)?.fullName ?? `repo ${id}`) : null;

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

  // The bot-vendor PR drill-down is a non-PR, singleton tab — a compact chip (no PR meta).
  if (tab.kind === 'bot-prs') {
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
          title="Bot PRs — the PRs a review bot touched"
        >
          <span aria-hidden="true" className="shrink-0">
            🤖
          </span>
          <span
            className={`text-xs font-medium ${
              active ? 'text-violet-600 dark:text-violet-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            Bot PRs
          </span>
        </button>
        <button
          type="button"
          onClick={() => closeTab(tab.key)}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Close this tab"
          aria-label="Close bot-PRs tab"
        >
          ✕
        </button>
      </div>
    );
  }

  // The all-open-PRs drill-down is a non-PR, singleton tab — a compact chip (no PR meta). A
  // repo/group scope surfaces its name so a scoped tab is easy to track ('feed' shows none).
  if (tab.kind === 'open-prs') {
    const scopeName =
      typeof openPrsScope === 'number'
        ? repoName(openPrsScope)
        : openPrsScope != null && typeof openPrsScope === 'object'
          ? openPrsScope.label
          : null;
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
          title={`Open PRs — sortable drill-down${scopeName ? ` · ${scopeName}` : ''}`}
        >
          <span aria-hidden="true" className="shrink-0 text-sky-500">
            {OpenPrsIcon}
          </span>
          <span
            className={`max-w-[12rem] truncate text-xs font-medium ${
              active ? 'text-sky-600 dark:text-sky-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            Open PRs{scopeName ? ` · ${scopeName}` : ''}
          </span>
        </button>
        <button
          type="button"
          onClick={() => closeTab(tab.key)}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Close this tab"
          aria-label="Close open-PRs tab"
        >
          ✕
        </button>
      </div>
    );
  }

  // The bot-only-PRs drill-down is a non-PR, singleton tab — a compact chip (no PR meta). A
  // per-repo scope (opened from the per-repo Bots tab) surfaces its repo name.
  if (tab.kind === 'bot-only-prs') {
    const scopeName = repoName(botOnlyRepoId);
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
          title={`Bot-only PRs — only a bot reviewed these${scopeName ? ` · ${scopeName}` : ''}`}
        >
          <span aria-hidden="true" className="shrink-0">
            🤖
          </span>
          <span
            className={`max-w-[12rem] truncate text-xs font-medium ${
              active ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            Bot-only PRs{scopeName ? ` · ${scopeName}` : ''}
          </span>
        </button>
        <button
          type="button"
          onClick={() => closeTab(tab.key)}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Close this tab"
          aria-label="Close bot-only-PRs tab"
        >
          ✕
        </button>
      </div>
    );
  }

  // The resolvable-bot-threads review & resolve is a non-PR, singleton tab — a compact chip. A
  // per-repo scope (opened from the per-repo Bots tab) surfaces its repo name.
  if (tab.kind === 'bot-threads') {
    const scopeName = repoName(botThreadsRepoId);
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
          title={`Bot threads — review & resolve the likely-addressed backlog${scopeName ? ` · ${scopeName}` : ''}`}
        >
          <span aria-hidden="true" className="shrink-0">
            🧹
          </span>
          <span
            className={`max-w-[12rem] truncate text-xs font-medium ${
              active ? 'text-sky-600 dark:text-sky-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            Bot threads{scopeName ? ` · ${scopeName}` : ''}
          </span>
        </button>
        <button
          type="button"
          onClick={() => closeTab(tab.key)}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Close this tab"
          aria-label="Close bot-threads tab"
        >
          ✕
        </button>
      </div>
    );
  }

  // The theme-threads drill-down — the review threads / PR comments a theme groups. Labelled with
  // the theme's title (from the transient seed).
  if (tab.kind === 'theme-threads') {
    const themeTitle = themeThreadsSeed?.theme.title ?? 'Theme threads';
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
          title={`Theme threads — ${themeTitle}`}
        >
          <span aria-hidden="true" className="shrink-0">
            🧵
          </span>
          <span
            className={`max-w-[12rem] truncate text-xs font-medium ${
              active ? 'text-sky-600 dark:text-sky-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            {themeTitle}
          </span>
        </button>
        <button
          type="button"
          onClick={() => closeTab(tab.key)}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Close this tab"
          aria-label="Close theme-threads tab"
        >
          ✕
        </button>
      </div>
    );
  }

  // The cross-team search-results drill-down — labelled with the query (from the transient seed).
  if (tab.kind === 'search') {
    const q = searchSeed ?? '';
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
          title={q ? `Search — “${q}”` : 'Search'}
        >
          <span aria-hidden="true" className="shrink-0 text-gray-500">
            <MagnifierIcon size={13} />
          </span>
          <span
            className={`max-w-[12rem] truncate text-xs font-medium ${
              active ? 'text-sky-600 dark:text-sky-400' : 'text-gray-600 dark:text-gray-300'
            }`}
          >
            {q ? `“${q}”` : 'Search'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => closeTab(tab.key)}
          className="shrink-0 self-center rounded px-1 py-0.5 text-xs leading-none text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          title="Close this tab"
          aria-label="Close search tab"
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
      // Fixed min-height so the strip never shrinks when the (taller, two-line) PR tabs are all
      // closed. `items-stretch` makes EVERY tab fill the strip's full height, so the single-line
      // chips (Activity / Timeline / drill-downs) and the two-line PR tabs come out the SAME
      // height with vertically-centred content — no ragged tops or misaligned text.
      className="flex min-h-[42px] shrink-0 items-stretch gap-1 overflow-x-auto bg-gray-100 px-2 pt-1 dark:bg-gray-900"
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
