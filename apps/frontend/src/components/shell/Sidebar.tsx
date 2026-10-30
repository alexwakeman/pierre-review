import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActivityRepo, RepoBranchStatus, ThreadStateCounts } from '@pierre-review/shared';
import { useActivity } from '../../hooks/useActivity.js';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { activeWorkspaceBadge, useMyTurnByWorkspace } from '../../hooks/useMyTurnByWorkspace.js';
import { useNotificationToggle } from '../../hooks/useNotificationPref.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useMe, useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { openPrsTabCount } from '../../lib/openPrsTab.js';
import { storyTabLabels } from '../../lib/ticketTab.js';
import { CI_META, DERIVED_STATE_META, relativeTime } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type Tab } from '../../store/pinnedTabs.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { useShell } from '../../store/shell.js';
import { AiUsageMenu } from '../AiUsageMenu.js';
import {
  BellIcon,
  BookIcon,
  BotIcon,
  ChartIcon,
  ChevronIcon,
  CloseIcon,
  FeedIcon,
  KeyboardIcon,
  MagnifierIcon,
  MoonIcon,
  PendingBallIcon,
  PullRequestIcon,
  QuestionIcon,
  SunIcon,
  TicketIcon,
  TimelineIcon,
} from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SyncStatus } from '../SyncStatus.js';
import { UserMenu } from '../UserMenu.js';
import { NeedsYou } from '../WelcomeBackBanner.js';
import { Wordmark } from '../Wordmark.js';
import { WorkspaceSelector } from '../WorkspaceSelector.js';
import { openCommandPalette } from '../ui/commands.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { useIsDesktop } from '../ui/media.js';
import { useEdgeFade } from '../ui/edgeFade.js';
import {
  currentLocation,
  DESTINATIONS,
  goTo,
  GROUP_LABEL,
  type Destination,
  type DestinationId,
  type NavGroup,
} from './nav.js';

// THE SIDEBAR (docs/redesign/DESIGN.md § 1 and § 6). It replaced the top tab row (Activity · This
// Sprint · Timeline), the Activity rail (Open PRs · Pending · Docs · Feed · Reports · Bots
// Monitoring · one row per repo), the FilterBar's workspace pill and search box, the Welcome-back
// strip and the header's right-hand controls. Top to bottom:
//
//   wordmark · workspace picker · "Search or jump ⌘K"
//   Pending · Open pull requests · This Sprint · Timeline          (primary; the phone's bottom bar)
//   Needs you                                                      (other workspaces' My Turn)
//   Library: Docs · Feed      Insights: Reports · Bots Monitoring
//   Open tabs                                                      (phone only; the top bar has them wider)
//   Repositories (collapsible): one row per repo in the workspace
//   foot: sync · AI usage · bell · help · keys · theme · account
//
// ⚠ IT IS RENDERED ONCE AND NEVER UNMOUNTED. `SyncStatus` (the sync round's ONE driver) lives in
// the foot, so below `lg` the closed drawer is `display: none`, not an unmounted tree. Anything it
// needs to show over the page while hidden (the sync dialog) is portalled out.
//
// ⚠ IT DOES NOT FETCH MORE THAN THE OLD RAIL DID, SCREEN FOR SCREEN: the repo rows read the SAME
// `useActivity(workspace, null, null)` / `useBranchStatus()` keys the Activity console reads — and
// only while the Repositories group is open — and the counts read the keys the palette and the
// workspace picker already hold.

const NAV_ICON: Record<DestinationId, (p: { size?: number; className?: string }) => JSX.Element> = {
  attention: PendingBallIcon,
  'open-prs': PullRequestIcon,
  sprint: TicketIcon,
  timeline: TimelineIcon,
  docs: BookIcon,
  feed: FeedIcon,
  insights: ChartIcon,
  bots: BotIcon,
};

/** One sidebar line: icon, words, an optional count. `aria-current="page"` marks where you are. */
function NavItem({
  icon,
  label,
  title,
  count,
  countTitle,
  current,
  onClick,
  kbd,
  testId,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  count?: ReactNode;
  countTitle?: string;
  current: boolean;
  onClick: () => void;
  kbd?: string;
  testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      title={title}
      aria-keyshortcuts={kbd}
      data-testid={testId}
      className={cx(
        'group flex h-8 w-full min-w-0 items-center gap-2.5 rounded-ui px-2 text-left text-body touch:h-11',
        'motion-safe:transition-colors motion-safe:duration-ui-fast',
        current ? 'bg-ui-sel font-medium text-ui-ink' : 'text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
        FOCUS_RING,
        'focus-visible:ring-offset-ui-surface',
      )}
    >
      <span className={cx('flex w-4 shrink-0 justify-center', current ? 'text-ui-ink' : 'text-ui-faint group-hover:text-ui-mute')}>
        {icon}
      </span>
      <span className="nav-label min-w-0 flex-1 truncate">{label}</span>
      {count != null && (
        <span title={countTitle} className={cx('shrink-0 text-meta tabular-nums', current ? 'text-ui-ink' : 'text-ui-faint')}>
          {count}
        </span>
      )}
    </button>
  );
}

function GroupHeading({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mb-1 mt-4 px-2 text-meta text-ui-faint">{children}</p>;
}

/** The destinations, with the two counts the shell owns. */
function Destinations({ location }: { location: ReturnType<typeof currentLocation> }): JSX.Element {
  const aiOn = useAiCapabilities().enabled;
  // Open PRs: NON-DRAFT open PRs, blank (never 0) until it answers or while the previous
  // workspace's placeholder is showing (lib/openPrsTab.ts). The palette reads the same key.
  const openPrsQuery = useWorkspaceOpenPrs();
  const openPrsCount = openPrsTabCount(openPrsQuery.data, openPrsQuery.isPlaceholderData);
  // Pending: THIS workspace's personal My Turn count — the badge that sat on the workspace pill
  // and the Welcome-back strip's chip for it. Same fold, same "+" and the exact pair in the title.
  const { active: activeMyTurn } = useMyTurnByWorkspace();
  const badge = activeWorkspaceBadge(activeMyTurn);
  const workspaceName = activeMyTurn?.name ?? 'this workspace';

  const counts: Partial<Record<DestinationId, { node: ReactNode; title?: string }>> = {};
  if (badge != null) {
    counts.attention = {
      node: (
        <>
          {badge.count}
          {badge.cappedTotal != null && (
            <>
              <span aria-hidden>+</span>
              <span className="sr-only"> of {badge.cappedTotal}</span>
            </>
          )}
          <span className="sr-only"> need you</span>
        </>
      ),
      title:
        activeMyTurn?.cap?.title ??
        (badge.count === 1
          ? `1 item needs you in ${workspaceName} — it is on the Pending board`
          : `${badge.count} items need you in ${workspaceName} — they are on the Pending board`),
    };
  }
  if (openPrsCount != null) counts['open-prs'] = { node: openPrsCount, title: 'Open pull requests, drafts not counted' };

  const groups: NavGroup[] = ['primary', 'library', 'insights'];
  return (
    <nav aria-label="Main">
      {groups.map((g) => {
        const items = DESTINATIONS.filter((d) => d.group === g && (!d.aiOnly || aiOn));
        if (items.length === 0) return null;
        return (
          <div key={g}>
            {GROUP_LABEL[g] != null && <GroupHeading>{GROUP_LABEL[g]}</GroupHeading>}
            <div className="flex flex-col gap-px">
              {items.map((d: Destination) => {
                const Icon = NAV_ICON[d.id];
                const c = counts[d.id];
                return (
                  <NavItem
                    key={d.id}
                    icon={<Icon size={14} />}
                    label={d.label}
                    title={`${d.title} (G then ${d.goKey.toUpperCase()})`}
                    kbd={`g ${d.goKey}`}
                    count={c?.node}
                    countTitle={c?.title}
                    current={location === d.id}
                    onClick={() => goTo(d.id)}
                    testId={`nav-${d.id}`}
                  />
                );
              })}
            </div>
            {g === 'primary' && <NeedsYou onNavigate={() => useShell.getState().setDrawerOpen(false)} />}
          </div>
        );
      })}
    </nav>
  );
}

/** A dynamic tab's words, for the phone drawer's "Open tabs" list (the strip's chips, in one line). */
export function tabWords(tab: Tab): string {
  switch (tab.kind) {
    case 'pr-detail':
      return `#${tab.meta?.number ?? ''} ${tab.meta?.title ?? 'Pull request'}`;
    case 'pr-focus':
      return `#${tab.meta?.number ?? ''} ${tab.meta?.title ?? ''} · PR focus`;
    case 'ticket':
      return storyTabLabels(tab.ticketMeta?.key).chip;
    case 'user-activity':
      return tab.userMeta?.login ?? tab.userMeta?.displayName ?? 'Contributor';
    case 'bot-detail':
      return `${tab.botMeta?.label ?? tab.botMeta?.login ?? 'Bot'} · depth`;
    case 'search':
      return 'Search results';
    case 'metrics-detail':
      return 'Flow metrics';
    case 'bot-prs':
      return 'Bot Drill-Down';
    case 'bot-only-prs':
      return 'Bot-only PRs';
    case 'bot-threads':
      return 'Bot threads';
    case 'theme-threads':
      return 'Theme threads';
    case 'bot-flagging':
      return 'Flagged';
    case 'bot-volume':
      return 'Comments/PR';
    default:
      return 'Tab';
  }
}

/** Phone only: the open tabs (the top bar's strip is md and wider). Activate, close, close all. */
function OpenTabs(): JSX.Element | null {
  const tabs = usePinnedTabs((s) => s.tabs);
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const closeTab = usePinnedTabs((s) => s.closeTab);
  const closeAllTabs = usePinnedTabs((s) => s.closeAllTabs);
  if (tabs.length === 0) return null;
  return (
    <div className="md:hidden" data-testid="sidebar-open-tabs">
      <div className="mb-1 mt-4 flex items-center pl-2 pr-1">
        <p className="min-w-0 flex-1 text-meta text-ui-faint">Open tabs</p>
        <button
          type="button"
          onClick={closeAllTabs}
          className="hit h-10 shrink-0 rounded-ui px-2 text-meta text-ui-mute hover:bg-ui-hover hover:text-ui-ink"
        >
          Close all
        </button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {tabs.map((t) => {
          const words = tabWords(t);
          const on = activeTab === t.key;
          return (
            <li key={t.key} className={cx('flex items-center rounded-ui', on ? 'bg-ui-sel' : 'hover:bg-ui-hover')}>
              <button
                type="button"
                aria-current={on ? 'page' : undefined}
                onClick={() => {
                  setActiveTab(t.key);
                  useShell.getState().setDrawerOpen(false);
                }}
                className={cx('hit h-11 min-w-0 flex-1 truncate px-2 text-left text-body', on ? 'font-medium text-ui-ink' : 'text-ui-mute', FOCUS_RING)}
              >
                {words}
              </button>
              <button
                type="button"
                onClick={() => closeTab(t.key)}
                aria-label={`Close tab ${words}`}
                className={cx('hit flex h-11 w-11 shrink-0 items-center justify-center rounded-ui text-ui-faint hover:text-ui-ink', FOCUS_RING)}
              >
                <CloseIcon size={12} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Repo sort: attention desc → unread → alphabetical (the old rail's order).
function sortRepos(repos: readonly ActivityRepo[]): ActivityRepo[] {
  return [...repos].sort((a, b) => {
    if (b.attentionCount !== a.attentionCount) return b.attentionCount - a.attentionCount;
    if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
    return a.repoFullName.localeCompare(b.repoFullName);
  });
}

interface RepoItem {
  repoId: number;
  fullName: string;
  maintainerCount: number;
  hasUnread: boolean;
  attentionCount: number;
  openPrs: number | null;
  threadTotals: ThreadStateCounts | null;
}

/**
 * One repo, ONE LINE: unread dot · name · a red dot only when its default branch is failing · open
 * PRs. Everything else the old two-line row drew (the attention count, the maintainer shield, the
 * thread-state bar, the branch name and its last commit) is in the row's tooltip and accessible
 * name, and in full on the repo's own page — the row is permanent chrome, so it stays quiet.
 */
function RepoRow({
  r,
  branch,
  current,
}: {
  r: RepoItem;
  branch: RepoBranchStatus | null;
  current: boolean;
}): JSX.Element {
  const short = r.fullName.split('/')[1] ?? r.fullName;
  const owner = r.fullName.split('/')[0] ?? '';
  const failing = branch?.branchName != null && (branch.ciStatus === 'failure' || branch.ciStatus === 'error');
  const facts: string[] = [];
  if (r.openPrs != null) facts.push(`${r.openPrs} open pull request${r.openPrs === 1 ? '' : 's'}`);
  if (r.attentionCount > 0) facts.push(`${r.attentionCount} needing attention`);
  if (r.hasUnread) facts.push('new activity');
  if (r.maintainerCount > 0) facts.push('you have merged here');
  if (r.threadTotals != null) {
    const t = r.threadTotals;
    const parts = (['untouched', 'replied_unresolved', 'likely_addressed', 'resolved'] as const)
      .filter((k) => (t[k] ?? 0) > 0)
      .map((k) => `${t[k]} ${DERIVED_STATE_META[k].label.toLowerCase()}`);
    if (parts.length > 0) facts.push(`threads: ${parts.join(', ')}`);
  }
  if (branch?.branchName != null) {
    facts.push(
      `${branch.branchName}: ${CI_META[branch.ciStatus]?.label ?? 'no CI reported'}${
        branch.lastCommitAt != null ? `, last commit ${relativeTime(branch.lastCommitAt)}` : ''
      }`,
    );
  }
  return (
    <button
      type="button"
      onClick={() => goTo(r.repoId)}
      aria-current={current ? 'page' : undefined}
      title={[r.fullName, ...facts].join('\n')}
      aria-label={[r.fullName, ...facts].join(', ')}
      data-testid="sidebar-repo"
      data-attention={r.attentionCount > 0 ? r.attentionCount : undefined}
      className={cx(
        'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-ui px-2 text-left touch:h-11',
        current ? 'bg-ui-sel text-ui-ink' : 'text-ui-mute hover:bg-ui-hover hover:text-ui-ink',
        FOCUS_RING,
      )}
    >
      <span className="flex w-4 shrink-0 justify-center">
        {r.hasUnread ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ui-accent" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-body">
        {short}
        {owner !== '' && short !== r.fullName && <span className="sr-only"> in {owner}</span>}
      </span>
      {failing && <span aria-hidden data-testid="sidebar-repo-failing" className="h-1.5 w-1.5 shrink-0 rounded-full bg-ui-danger" />}
      <span className="w-6 shrink-0 text-right text-meta tabular-nums text-ui-faint">
        {r.openPrs == null ? '' : r.openPrs > 0 ? r.openPrs : '—'}
      </span>
    </button>
  );
}

/** What a repo row says, behind the ⓘ beside "Repositories" (the rail's legend, kept). */
function ThreadLegend(): JSX.Element {
  return (
    <InfoButton title="Repositories">
      <p>
        Each repo shows its open pull requests on the right. A blue dot means new activity; a red dot means its
        default branch is failing CI.
      </p>
      <p>
        Hover a repo (or open it) for the rest: how many pull requests need attention, whether you have merged there,
        its review threads and its default branch.
      </p>
      <ul className="space-y-1">
        {(['untouched', 'replied_unresolved', 'likely_addressed', 'resolved'] as const).map((k) => (
          <li key={k}>
            <strong className="font-medium">{DERIVED_STATE_META[k].label}</strong>: {DERIVED_STATE_META[k].description}
          </li>
        ))}
      </ul>
    </InfoButton>
  );
}

/** Rows shown before "Show all" — the group must never push the rest of the sidebar out of view. */
const REPO_ROWS_SHOWN = 6;

function Repositories({ location }: { location: ReturnType<typeof currentLocation> }): JSX.Element | null {
  const workspaceId = useFilters((s) => s.workspaceId);
  const open = useShell((s) => s.reposOpen);
  const setOpen = useShell((s) => s.setReposOpen);
  // A repo console that is OPEN keeps the group's data live even when collapsed, so its row can
  // still say where you are.
  const want = open || typeof location === 'number';
  const { data, isFetching } = useActivity(want ? workspaceId : null, null, null);
  const { data: branchData } = useBranchStatus();
  const { data: allRepos } = useRepos();
  const branchByRepo = useMemo(() => new Map((branchData?.repos ?? []).map((r) => [r.repoId, r])), [branchData]);
  const sorted = useMemo(() => sortRepos(data?.repos ?? []), [data?.repos]);
  const [showAll, setShowAll] = useState(false);
  // "generated N ago": re-render every 30s so the stamp stays true without refetching.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (workspaceId == null) return null;
  // Before the aggregate lands: names only, narrowed to this workspace (the old rail's fallback).
  const items: RepoItem[] =
    data != null
      ? sorted.map((r) => ({
          repoId: r.repoId,
          fullName: r.repoFullName,
          maintainerCount: r.maintainerIds.length,
          hasUnread: r.hasUnread,
          attentionCount: r.attentionCount,
          openPrs: r.stats.openPrs,
          threadTotals: r.threadTotals,
        }))
      : (allRepos ?? [])
          .filter((r) => r.workspaceId === workspaceId)
          .map((r) => ({
            repoId: r.id,
            fullName: r.fullName,
            maintainerCount: 0,
            hasUnread: false,
            attentionCount: 0,
            openPrs: null,
            threadTotals: null,
          }));
  if (items.length === 0 && data != null) return null;
  const generatedAt = data?.generatedAt ?? null;

  return (
    <div data-testid="sidebar-repos">
      <div className="mb-1 mt-4 flex items-center gap-0.5 pr-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cx(
            'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-ui px-2 text-left text-meta text-ui-faint hover:text-ui-ink touch:h-10',
            FOCUS_RING,
          )}
        >
          <span className="min-w-0 truncate">Repositories</span>
          {items.length > 0 && <span className="tabular-nums">{items.length}</span>}
          <ChevronIcon dir={open ? 'down' : 'right'} size={10} className="shrink-0" />
        </button>
        {open && generatedAt != null && (
          // The old rail's staleness stamp: when this aggregate was computed (full time in the title).
          <span className="shrink-0 text-meta text-ui-faint" title={`Updated ${new Date(generatedAt).toLocaleString()}`}>
            {relativeTime(generatedAt)}
          </span>
        )}
        <ThreadLegend />
      </div>
      {open && (
        <div className={cx('relative flex flex-col gap-px', isFetching && data != null && 'opacity-70 motion-safe:transition-opacity')}>
          {/* Refetching keeps the last data and says so with a hairline, never a blank. */}
          {isFetching && data != null && (
            <div aria-hidden className="absolute -top-1 left-2 right-2 h-px overflow-hidden bg-ui-line">
              <div className="h-full w-1/3 bg-ui-accent motion-safe:animate-pulse" />
            </div>
          )}
          {(showAll
            ? items
            : items.filter((r, i) => i < REPO_ROWS_SHOWN || r.repoId === location)
          ).map((r) => (
            <RepoRow key={r.repoId} r={r} branch={branchByRepo.get(r.repoId) ?? null} current={location === r.repoId} />
          ))}
          {items.length > REPO_ROWS_SHOWN && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className={cx('flex h-8 w-full items-center rounded-ui pl-[30px] text-left text-meta text-ui-faint hover:bg-ui-hover hover:text-ui-ink touch:h-11', FOCUS_RING)}
            >
              {showAll ? 'Show fewer' : `Show all ${items.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The foot: sync, AI usage, the four small toggles, and the account. */
function Foot({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }): JSX.Element {
  const me = useMe();
  const meUser = me.data?.user ?? null;
  const openSettings = useSettingsModal((s) => s.openSettings);
  const setHelpOpen = useShell((s) => s.setHelpOpen);
  const setShortcutsOpen = useShell((s) => s.setShortcutsOpen);
  const notif = useNotificationToggle();
  const small = cx(
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-11 touch:w-11',
    FOCUS_RING,
    'focus-visible:ring-offset-ui-surface',
  );
  return (
    <div className="flex shrink-0 flex-col gap-px px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2">
      <SyncStatus variant="sidebar" />
      <AiUsageMenu variant="sidebar" />
      <div className="flex items-center gap-0.5 py-1">
        {notif.supported && (
          <button
            type="button"
            onClick={notif.toggle}
            aria-pressed={notif.enabled}
            aria-label="Toggle My Turn notifications"
            title={
              notif.enabled
                ? 'Notifications on — alerts when a new item enters your My Turn. Click to turn off.'
                : 'Turn on browser notifications for new My Turn items'
            }
            className={cx(small, notif.enabled && 'bg-ui-sel text-ui-ink')}
          >
            <BellIcon size={14} filled={notif.enabled} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label="Help"
          title="Help — what is Limn and how to use it"
          className={small}
        >
          <QuestionIcon size={14} />
        </button>
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          aria-keyshortcuts="?"
          className={cx(small, 'touch:hidden')}
        >
          <KeyboardIcon size={15} />
        </button>
        <button
          type="button"
          onClick={toggleDark}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          title="Toggle dark mode"
          className={small}
        >
          {dark ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
      {/* The GitHub user (hidden when `me.user` is null, e.g. offline). */}
      {meUser != null && <UserMenu user={meUser} onOpenSettings={() => openSettings()} />}
    </div>
  );
}

/**
 * The one sidebar. `lg` and wider: a docked column. Narrower: a drawer over the page, opened from
 * the top bar's menu button (or the phone's "More"), closed by a pick, Escape or the scrim.
 */
export function Sidebar({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  const activityRepoId = useFilters((s) => s.activityRepoId);
  const location = currentLocation(activeTab, tabs, activityRepoId);
  const drawerOpen = useShell((s) => s.drawerOpen);
  const setDrawerOpen = useShell((s) => s.setDrawerOpen);
  const desktop = useIsDesktop();
  const asideRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Set when the drawer closes to open another modal (the palette): focus must NOT go back to the
  // menu button behind it — on a phone that kept the keyboard down and typing went nowhere.
  const skipRestoreRef = useRef(false);
  // The docked middle scrolls (a long repo list): its hidden edge fades, so "more below" shows.
  const middleRef = useRef<HTMLDivElement>(null);
  const middleFade = useEdgeFade(middleRef, 'y');
  const drawer = drawerOpen && !desktop;

  // Growing past `lg` with the drawer open docks it; the flag must not linger for the next shrink.
  useEffect(() => {
    if (desktop && drawerOpen) setDrawerOpen(false);
  }, [desktop, drawerOpen, setDrawerOpen]);

  // The drawer is a modal layer: focus moves in, Escape closes it (capture phase, so the global
  // Esc never also fires), focus goes back to the button that opened it.
  useEffect(() => {
    if (!drawer) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    const first = asideRef.current?.querySelector<HTMLElement>('[aria-current="page"], button');
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // An open menu inside the drawer (workspace, account) owns its own Escape first.
      if (asideRef.current?.querySelector('[role="menu"], [role="dialog"]') != null) return;
      e.stopPropagation();
      e.preventDefault();
      setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (skipRestoreRef.current) skipRestoreRef.current = false;
      else openerRef.current?.focus?.();
    };
  }, [drawer, setDrawerOpen]);

  return (
    <>
      {drawer && (
        <div
          aria-hidden
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-[55] bg-ui-scrim/40 motion-safe:animate-ui-fade lg:hidden"
        />
      )}
      <aside
        ref={asideRef}
        aria-label="Sidebar"
        data-testid="sidebar"
        // A dialog only while it is a drawer; a plain landmark when docked.
        role={drawer ? 'dialog' : undefined}
        aria-modal={drawer ? true : undefined}
        className={cx(
          'flex-col bg-ui-surface',
          // Docked at lg+.
          'lg:static lg:z-auto lg:flex lg:w-sidebar lg:shrink-0',
          // A drawer below lg: hidden (never unmounted) until opened.
          drawer
            ? 'fixed inset-y-0 left-0 z-[56] flex w-[min(18rem,86vw)] overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] shadow-2xl shadow-black/40 motion-safe:animate-ui-drawer-in'
            : 'hidden',
        )}
      >
        <div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3">
          <h1 className="min-w-0 flex-1" title="Limn — to depict, to make clear">
            <Wordmark className="text-title" />
          </h1>
          {drawer && (
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
              className={cx('hit flex h-10 w-10 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover', FOCUS_RING)}
            >
              <CloseIcon size={14} />
            </button>
          )}
        </div>
        <div className="shrink-0 px-2 pt-1">
          <WorkspaceSelector />
          <button
            type="button"
            onClick={() => {
              if (drawer) skipRestoreRef.current = true;
              setDrawerOpen(false);
              openCommandPalette();
            }}
            aria-keyshortcuts="Meta+K Control+K /"
            className={cx(
              'mt-1.5 flex h-8 w-full items-center gap-2 rounded-ui bg-ui-raise px-2 text-left text-body text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-11',
              FOCUS_RING,
              'focus-visible:ring-offset-ui-surface',
            )}
          >
            <MagnifierIcon size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Search or jump</span>
          </button>
        </div>
        {/* In the drawer the WHOLE aside scrolls, foot included: a pinned foot left the middle so
            short that Insights' items sat below the fold with nothing saying so. The foot stays at
            the same place in the tree either way (SyncStatus must never remount). */}
        <div
          ref={middleRef}
          style={drawer ? undefined : middleFade}
          className={cx('px-2 pb-3 pt-3', drawer ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain')}
        >
          <Destinations location={location} />
          <OpenTabs />
          <Repositories location={location} />
        </div>
        <Foot dark={dark} toggleDark={toggleDark} />
      </aside>
    </>
  );
}
