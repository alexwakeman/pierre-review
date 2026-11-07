import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  repoStatusSummary,
  type ActivityRepo,
  type RepoBranchStatus,
  type RepoStatusSummary,
  type ThreadStateCounts,
} from '@pierre-review/shared';
import { useActivity } from '../../hooks/useActivity.js';
import { useBranchStatus } from '../../hooks/useBranchStatus.js';
import { useNavGates } from '../../hooks/useNavGates.js';
import { activeWorkspaceBadge, useMyTurnByWorkspace } from '../../hooks/useMyTurnByWorkspace.js';
import { useNotificationToggle } from '../../hooks/useNotificationPref.js';
import { useRepos } from '../../hooks/useTimeline.js';
import { useMe, useWorkspaceOpenPrs } from '../../hooks/useTriage.js';
import { openPrsTabCount } from '../../lib/openPrsTab.js';
import { storyTabLabels } from '../../lib/ticketTab.js';
import { storyBuildTabLabels } from '../../lib/storyBuildTab.js';
import { CI_META, DERIVED_STATE_META, relativeTime } from '../../lib/ui.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type Tab } from '../../store/pinnedTabs.js';
import { groupTabsByAuthor } from '../../lib/sidebarTabGroups.js';
import { TabContextMenu, useTabChip } from '../PinnedTabsBar.js';
import { useSettingsModal } from '../../store/settingsModal.js';
import { clampSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useShell } from '../../store/shell.js';
import { AiUsageMenu } from '../AiUsageMenu.js';
import { RepoStatusDot } from '../RepoStatusDot.js';
import {
  BellIcon,
  BookIcon,
  BotIcon,
  ChartIcon,
  ChevronIcon,
  CloseIcon,
  PeopleIcon,
  PinIcon,
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
import { Kbd } from '../ui/Kbd.js';
import { modKeyLabel } from '../ui/keys.js';
import { useIsDesktop } from '../ui/media.js';
import { useEdgeFade } from '../ui/edgeFade.js';
import {
  currentLocation,
  shownDestinations,
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
//   Open pull requests · Pending                                   (PINNED: above the scrolling middle)
//   This Sprint · Timeline                                         (primary, with the two above; the phone's bottom bar)
//   Needs you                                                      (other workspaces' My Turn)
//   Library: Docs · Feed      Insights: Reports · Bots Monitoring
//   Repositories (collapsible): the top four repos, "Show all" for the rest
//   Open tabs: every open tab (a PR, a story, a drill-down) — the top bar's strip only shows them
//              from md to lg, where this sidebar is a drawer
//   foot: sync · AI usage · bell · help · keys · theme · account
//
// At lg and wider its right edge drags it wider (SIDEBAR_WIDTH_MIN–MAX, remembered); the middle
// scrolls vertically only, with no visible scrollbar (the edge fade says "more below").
//
// ⚠ IT IS RENDERED ONCE AND NEVER UNMOUNTED. `SyncStatus` (the sync round's ONE driver) lives in
// the foot, so below `lg` the closed drawer is `display: none`, not an unmounted tree. Anything it
// needs to show over the page while hidden (the sync dialog) is portalled out.
//
// ⚠ IT DOES NOT FETCH MORE THAN THE OLD RAIL DID, SCREEN FOR SCREEN: the repo rows read the SAME
// `useActivity(workspace, null, null)` / `useBranchStatus()` keys the Activity console reads — and
// only while the Repositories group is open — and the counts read the keys the palette and the
// workspace picker already hold.

/** The sidebar's icon size, as named (Icons.tsx scales it to 18px — Claude Code desktop's). */
const SIDEBAR_ICON = 14;

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
        // Claude Code desktop's sidebar: every row in full ink, the selection is the ground alone.
        current ? 'bg-ui-sel font-medium text-ui-ink' : 'text-ui-ink hover:bg-ui-hover',
        FOCUS_RING,
        'focus-visible:ring-offset-ui-surface',
      )}
    >
      <span className="flex w-[18px] shrink-0 justify-center text-ui-ink">
        {icon}
      </span>
      <span className="nav-label min-w-0 flex-1 truncate">{label}</span>
      {count != null && (
        <span title={countTitle} className={cx('shrink-0 text-meta tabular-nums', current ? 'text-ui-ink' : 'text-ui-mute')}>
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
/**
 * PINNED: Open pull requests and Pending (in that order) sit ABOVE the scrolling middle, so they stay in reach after
 * scrolling down to the repositories and open tabs. The rest of the primary group (This Sprint,
 * Timeline) scrolls with the other groups. The drawer below lg scrolls as a whole, as before.
 */
const PINNED_DESTINATIONS: ReadonlySet<DestinationId> = new Set<DestinationId>(['attention', 'open-prs']);

function Destinations({
  location,
  part,
}: {
  location: ReturnType<typeof currentLocation>;
  /** `pinned`: only the pinned entries; `rest`: every group without them. */
  part: 'pinned' | 'rest';
}): JSX.Element {
  const gates = useNavGates();
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

  const groups: NavGroup[] = part === 'pinned' ? ['primary'] : ['primary', 'library', 'insights'];
  return (
    <nav aria-label={part === 'pinned' ? 'Main' : 'More'}>
      {groups.map((g) => {
        const items = shownDestinations(gates).filter((d) => d.group === g && PINNED_DESTINATIONS.has(d.id) === (part === 'pinned'));
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
                    icon={<Icon size={SIDEBAR_ICON} />}
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
            {g === 'primary' && part === 'rest' && <NeedsYou onNavigate={() => useShell.getState().setDrawerOpen(false)} />}
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
    case 'story-build':
      return storyBuildTabLabels(tab.ticketMeta?.key).chip;
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

/** One open tab in the sidebar: the strip's icon and words (`useTabChip`), a ✕, a right-click menu. */
function SidebarTabRow({
  tab,
  active,
  onOpenMenu,
}: {
  tab: Tab;
  active: boolean;
  onOpenMenu: (e: React.MouseEvent, key: string) => void;
}): JSX.Element {
  const cfg = useTabChip(tab);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const closeTab = usePinnedTabs((s) => s.closeTab);
  const togglePinTab = usePinnedTabs((s) => s.togglePinTab);
  const pinned = tab.pinned === true;
  // The list sits below the destinations and repos, so a tab just opened can land under the fold
  // of a scroller with no visible bar: bring the active one into view. The repo list often lands
  // AFTER the tab (a reload, a link) and pushes it down, so it is kept in view while the content
  // above settles — for a moment only, so a later "Show all" never yanks the scroll.
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (!active || row == null) return;
    const reveal = (): void => row.scrollIntoView?.({ block: 'nearest' });
    reveal();
    const content = row.closest('[data-sidebar-middle]')?.firstElementChild ?? null;
    if (content == null || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(reveal);
    ro.observe(content);
    const stop = window.setTimeout(() => ro.disconnect(), 2000);
    return () => {
      window.clearTimeout(stop);
      ro.disconnect();
    };
  }, [active]);
  return (
    <li
      ref={rowRef}
      onContextMenu={(e) => onOpenMenu(e, tab.key)}
      className={cx('group flex h-8 items-center rounded-ui touch:h-11', active ? 'bg-ui-sel' : 'hover:bg-ui-hover')}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={cfg.title}
        onClick={() => {
          setActiveTab(tab.key);
          useShell.getState().setDrawerOpen(false);
        }}
        className={cx(
          'flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-ui pl-2 text-left text-body',
          active && 'font-medium',
          'text-ui-ink',
          FOCUS_RING,
        )}
      >
        <span className="flex w-[18px] shrink-0 justify-center text-ui-ink">{cfg.icon}</span>
        <span className="min-w-0 flex-1 truncate">{cfg.label}</span>
      </button>
      {/* A PINNED tab has no ✕: its pin, always shown, unpins it. */}
      {pinned ? (
        <button
          type="button"
          data-tab-pin
          onClick={() => togglePinTab(tab.key)}
          aria-label="Unpin tab"
          title="Pinned. Click to unpin"
          className={cx(
            'mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-11 touch:w-11',
            FOCUS_RING,
          )}
        >
          <PinIcon size={12} />
        </button>
      ) : (
        <button
          type="button"
          data-tab-close
          onClick={() => closeTab(tab.key)}
          aria-label={cfg.closeAria}
          title="Close this tab"
          className={cx(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-ui text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-11 touch:w-11',
            // Shown on the open tab and on hover/focus; always on touch (no hover there).
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch:opacity-100',
            'mr-1',
            FOCUS_RING,
          )}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </li>
  );
}

/** Every open tab, under Repositories, at every width. Activate, ✕ to close, right-click for
 *  Pin / Unpin and Close this / Close other tabs / Close all tabs (the strip's own menu), "Close all"
 *  for touch. PINNED tabs (no ✕, kept by every close-many) sit in a "Pinned" group at the top.
 *  "Group by author" (remembered, `useShell.tabsByAuthor`) puts each PR tab under its author's name:
 *  the reader's own first, then A–Z, then "Other" (`lib/sidebarTabGroups.ts`). This list has no drag
 *  reorder; the top bar's strip keeps its own, ungrouped. */
function OpenTabs(): JSX.Element | null {
  const tabs = usePinnedTabs((s) => s.tabs);
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const closeAllTabs = usePinnedTabs((s) => s.closeAllTabs);
  const byAuthor = useShell((s) => s.tabsByAuthor);
  const setByAuthor = useShell((s) => s.setTabsByAuthor);
  // The reader's login — the key the palette and the account menu already hold (no new fetch).
  const myLogin = useMe().data?.user?.login ?? null;
  const pinnedTabs = useMemo(() => tabs.filter((t) => t.pinned === true), [tabs]);
  const unpinnedTabs = useMemo(() => tabs.filter((t) => t.pinned !== true), [tabs]);
  const groups = useMemo(
    () => (byAuthor ? groupTabsByAuthor(unpinnedTabs, myLogin) : null),
    [byAuthor, unpinnedTabs, myLogin],
  );
  const [menu, setMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null);
  if (tabs.length === 0) return null;
  const openMenu = (e: React.MouseEvent, key: string): void => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, tabKey: key });
  };
  const rows = (list: readonly Tab[]): JSX.Element[] =>
    list.map((t) => <SidebarTabRow key={t.key} tab={t} active={activeTab === t.key} onOpenMenu={openMenu} />);
  return (
    <div data-testid="sidebar-open-tabs">
      <div className="mb-1 mt-4 flex items-center pl-2 pr-1">
        <p className="min-w-0 flex-1 text-meta text-ui-faint">
          Open tabs <span className="tabular-nums">{tabs.length}</span>
        </p>
        <button
          type="button"
          onClick={() => setByAuthor(!byAuthor)}
          aria-pressed={byAuthor}
          aria-label="Group by author"
          title={byAuthor ? 'Stop grouping by author' : 'Group by author'}
          data-testid="sidebar-tabs-by-author"
          className={cx(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-ui hover:bg-ui-hover hover:text-ui-ink touch:h-10 touch:w-10',
            byAuthor ? 'bg-ui-sel text-ui-ink' : 'text-ui-faint',
            FOCUS_RING,
          )}
        >
          <PeopleIcon size={14} />
        </button>
        {unpinnedTabs.length > 0 && (
          <button
            type="button"
            onClick={closeAllTabs}
            title={pinnedTabs.length > 0 ? 'Close all tabs except pinned ones' : undefined}
            className={cx('h-7 shrink-0 rounded-ui px-2 text-meta text-ui-faint hover:bg-ui-hover hover:text-ui-ink touch:h-10', FOCUS_RING)}
          >
            Close all
          </button>
        )}
      </div>
      {pinnedTabs.length > 0 && (
        <div data-testid="sidebar-pinned-tabs" className="mb-2">
          <p id="sidebar-tab-group-pinned" className="truncate px-2 pb-0.5 pt-1 text-meta font-medium text-ui-mute">
            Pinned
          </p>
          <ul
            role="tablist"
            aria-orientation="vertical"
            aria-labelledby="sidebar-tab-group-pinned"
            className="m-0 flex list-none flex-col gap-px p-0"
          >
            {rows(pinnedTabs)}
          </ul>
        </div>
      )}
      {unpinnedTabs.length === 0 ? null : groups == null ? (
        <ul role="tablist" aria-orientation="vertical" aria-label="Open tabs" data-testid="sidebar-tabs" className="m-0 flex list-none flex-col gap-px p-0">
          {rows(unpinnedTabs)}
        </ul>
      ) : (
        // One tablist per author, labelled by the heading above it.
        <div data-testid="sidebar-tabs" className="flex flex-col gap-2">
          {groups.map((g) => (
            <div key={g.key} data-testid="sidebar-tab-group">
              <p id={`sidebar-tab-group-${g.key}`} className="truncate px-2 pb-0.5 pt-1 text-meta font-medium text-ui-mute" title={g.label}>
                {g.label}
              </p>
              <ul
                role="tablist"
                aria-orientation="vertical"
                aria-labelledby={`sidebar-tab-group-${g.key}`}
                className="m-0 flex list-none flex-col gap-px p-0"
              >
                {rows(g.tabs)}
              </ul>
            </div>
          ))}
        </div>
      )}
      {menu != null && (
        <TabContextMenu x={menu.x} y={menu.y} tabKey={menu.tabKey} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/** The docked sidebar's right edge: drag (or arrow keys) to resize, double-click to reset. */
function ResizeHandle(): JSX.Element {
  const width = useShell((s) => s.sidebarWidth);
  const setWidth = useShell((s) => s.setSidebarWidth);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-testid="sidebar-resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = width;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        setDragging(true);
        const move = (ev: PointerEvent): void => setWidth(startW + ev.clientX - startX, false);
        const up = (ev: PointerEvent): void => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          setDragging(false);
          setWidth(clampSidebarWidth(startW + ev.clientX - startX));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          setWidth(width + (e.key === 'ArrowRight' ? 16 : -16));
        }
      }}
      className={cx(
        // A 10px hit area centred on the edge (easy to grab); the line it shows stays 2px. z-30: the
        // page's board layer is `absolute z-20` and would otherwise swallow the half over the page.
        'absolute inset-y-0 -right-[5px] z-30 hidden w-2.5 cursor-col-resize touch-none select-none lg:block',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-ui-accent after:opacity-0 after:motion-safe:transition-opacity',
        'hover:after:opacity-70 focus-visible:outline-none focus-visible:after:opacity-100',
        dragging && 'after:opacity-100',
      )}
    />
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
  attentionCount: number;
  openPrs: number | null;
  threadTotals: ThreadStateCounts | null;
  /** The red and blue dots (shared `repoStatusSummary`), null before the aggregate lands. */
  status: RepoStatusSummary | null;
  branchFacts: { name: string; ci: string; lastCommitAt: string | null } | null;
}

/**
 * One repo, ONE LINE: the two status dots · name · open PRs. The dots sit in ONE fixed-width slot
 * at the left, red always in the first place and blue in the second, so they line up down the list
 * whatever a row carries. What each means is the shared `repoStatusSummary` — the SAME fold the
 * status panel at the top of the repo view lists line by line, so opening the repo explains its
 * dots. Everything else (thread states, maintainers, the default branch) is in the row's tooltip
 * and accessible name, and in full on the repo's own page — the row is permanent chrome.
 */
function RepoRow({ r, current }: { r: RepoItem; current: boolean }): JSX.Element {
  const short = r.fullName.split('/')[1] ?? r.fullName;
  const owner = r.fullName.split('/')[0] ?? '';
  const st = r.status;
  const facts: string[] = [];
  if (st?.attentionWords != null) facts.push(st.attentionWords);
  if (st?.newWords != null) facts.push(st.newWords);
  if (r.openPrs != null) facts.push(`${r.openPrs} open pull request${r.openPrs === 1 ? '' : 's'}`);
  if (r.maintainerCount > 0) facts.push('you have merged here');
  if (r.threadTotals != null) {
    const t = r.threadTotals;
    const parts = (['untouched', 'replied_unresolved', 'likely_addressed', 'resolved'] as const)
      .filter((k) => (t[k] ?? 0) > 0)
      .map((k) => `${t[k]} ${DERIVED_STATE_META[k].label.toLowerCase()}`);
    if (parts.length > 0) facts.push(`threads: ${parts.join(', ')}`);
  }
  if (r.branchFacts != null) {
    facts.push(
      `${r.branchFacts.name}: ${r.branchFacts.ci}${
        r.branchFacts.lastCommitAt != null ? `, last commit ${relativeTime(r.branchFacts.lastCommitAt)}` : ''
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
      data-attention={st?.attention ? 'true' : undefined}
      data-new={st?.hasNew ? 'true' : undefined}
      className={cx(
        'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-ui px-2 text-left touch:h-11',
        current ? 'bg-ui-sel text-ui-ink' : 'text-ui-ink hover:bg-ui-hover',
        FOCUS_RING,
      )}
    >
      {/* THE DOT SLOT: fixed width, two fixed places (red, then blue). An absent dot leaves its
          place empty, so every row's dots — and every row's name — start on the same line. */}
      <span className="grid w-[18px] shrink-0 grid-cols-2 place-items-center" data-testid="sidebar-repo-dots">
        <span className="flex h-2 w-2 items-center justify-center">
          {st?.attention && (
            <RepoStatusDot tone="attention" title={st.attentionWords ?? undefined} testId="sidebar-repo-attention" />
          )}
        </span>
        <span className="flex h-2 w-2 items-center justify-center">
          {st?.hasNew && <RepoStatusDot tone="new" title={st.newWords ?? undefined} testId="sidebar-repo-new" />}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-body">
        {short}
        {owner !== '' && short !== r.fullName && <span className="sr-only"> in {owner}</span>}
      </span>
      <span className="w-6 shrink-0 text-right text-meta tabular-nums text-ui-mute">
        {r.openPrs == null ? '' : r.openPrs > 0 ? r.openPrs : '—'}
      </span>
    </button>
  );
}

/** What a repo row says, behind the ⓘ beside "Repositories" (the rail's legend, kept). */
function ThreadLegend(): JSX.Element {
  return (
    <InfoButton title="Repositories">
      <p>Each repo shows its open pull requests on the right, and up to two dots on the left.</p>
      <ul className="space-y-1">
        <li className="flex items-baseline gap-2">
          <RepoStatusDot tone="attention" className="relative -top-px" />
          <span>
            <strong className="font-medium">Red: needs attention.</strong> A pull request is waiting for your review,
            the default branch is failing CI, or a ready pull request is failing CI or has merge conflicts.
          </span>
        </li>
        <li className="flex items-baseline gap-2">
          <RepoStatusDot tone="new" className="relative -top-px" />
          <span>
            <strong className="font-medium">Blue: new to you.</strong> Someone else commented, reviewed or pushed on a
            pull request you have opened before, since you last opened it. Opening that pull request clears it.
          </span>
        </li>
      </ul>
      <p>Open a repo to see each of these listed at the top, with links to the pull requests.</p>
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

/** The default branch's line in a repo row's tooltip, or null before it has been branch-synced. */
function branchFactsOf(b: RepoBranchStatus | undefined): RepoItem['branchFacts'] {
  if (b?.branchName == null) return null;
  return { name: b.branchName, ci: CI_META[b.ciStatus]?.label ?? 'no CI reported', lastCommitAt: b.lastCommitAt };
}

/** Rows shown before "Show all" — the group must never push the rest of the sidebar out of view. */
const REPO_ROWS_SHOWN = 4;

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
  const statusByRepo = useMemo(
    () => new Map(sorted.map((r) => [r.repoId, repoStatusSummary(r, branchByRepo.get(r.repoId) ?? null)])),
    [sorted, branchByRepo],
  );
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
          attentionCount: r.attentionCount,
          openPrs: r.stats.openPrs,
          threadTotals: r.threadTotals,
          status: statusByRepo.get(r.repoId) ?? null,
          branchFacts: branchFactsOf(branchByRepo.get(r.repoId)),
        }))
      : (allRepos ?? [])
          .filter((r) => r.workspaceId === workspaceId)
          .map((r) => ({
            repoId: r.id,
            fullName: r.fullName,
            maintainerCount: 0,
            attentionCount: 0,
            openPrs: null,
            threadTotals: null,
            status: null,
            branchFacts: branchFactsOf(branchByRepo.get(r.id)),
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
            <RepoRow key={r.repoId} r={r} current={location === r.repoId} />
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
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-ui text-ui-ink hover:bg-ui-hover touch:h-11 touch:w-11',
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
            <BellIcon size={SIDEBAR_ICON} filled={notif.enabled} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label="Help"
          title="Help — what is Limn and how to use it"
          className={small}
        >
          <QuestionIcon size={SIDEBAR_ICON} />
        </button>
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          aria-keyshortcuts="?"
          className={cx(small, 'touch:hidden')}
        >
          <KeyboardIcon size={SIDEBAR_ICON} />
        </button>
        <button
          type="button"
          onClick={toggleDark}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          title="Toggle dark mode"
          className={small}
        >
          {dark ? <SunIcon size={SIDEBAR_ICON} /> : <MoonIcon size={SIDEBAR_ICON} />}
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
  const sidebarWidth = useShell((s) => s.sidebarWidth);

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
        // Docked: the reader's width (dragged by the right edge).
        style={desktop ? { width: sidebarWidth } : undefined}
        className={cx(
          // type-compact: the sidebar keeps the original type scale (index.css).
          'type-compact flex-col bg-ui-surface',
          // Docked at lg+ (relative: the resize handle sits on its right edge).
          'lg:relative lg:z-auto lg:flex lg:shrink-0',
          // A drawer below lg: hidden (never unmounted) until opened.
          drawer
            ? 'fixed inset-y-0 left-0 z-[56] flex w-[min(18rem,86vw)] overflow-y-auto overflow-x-hidden overscroll-contain pt-[env(safe-area-inset-top)] shadow-2xl shadow-black/40 motion-safe:animate-ui-drawer-in'
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
              'mt-1.5 flex h-8 w-full items-center gap-2.5 rounded-ui bg-ui-raise px-2 text-left text-body text-ui-ink hover:bg-ui-hover touch:h-11',
              FOCUS_RING,
              'focus-visible:ring-offset-ui-surface',
            )}
          >
            <span className="flex w-[18px] shrink-0 justify-center">
              <MagnifierIcon size={SIDEBAR_ICON} />
            </span>
            <span className="min-w-0 flex-1 truncate">Search or jump</span>
            <Kbd>{`${modKeyLabel()}K`}</Kbd>
          </button>
          <div className="pt-3" data-testid="sidebar-pinned">
            <Destinations location={location} part="pinned" />
          </div>
        </div>
        {/* In the drawer the WHOLE aside scrolls, foot included: a pinned foot left the middle so
            short that Insights' items sat below the fold with nothing saying so. The foot stays at
            the same place in the tree either way (SyncStatus must never remount). */}
        <div
          ref={middleRef}
          data-sidebar-middle
          style={drawer ? undefined : middleFade}
          // Vertical only, and no visible scrollbar: the edge fade says there is more.
          // ⚠ `relative` is LOAD-BEARING: it makes this scroller the containing block of the
          // `sr-only` spans (position:absolute) in the tab rows. Without it they resolve against the
          // aside, sit at their in-list y (thousands of px with many tabs), escape this clip and
          // stretch the DOCUMENT's scroll range, so a wheel over Open PRs scrolled the whole shell —
          // sidebar included — up the page (pinned by e2e/shell-scroll.spec.ts).
          className={cx('relative px-2 pb-3 pt-1', drawer ? 'shrink-0' : 'scrollbar-hidden min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain')}
        >
          <div>
            <Destinations location={location} part="rest" />
            <Repositories location={location} />
            <OpenTabs />
          </div>
        </div>
        <Foot dark={dark} toggleDark={toggleDark} />
        {!drawer && <ResizeHandle />}
      </aside>
    </>
  );
}
