import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FilterBar } from './components/FilterBar.js';
import { PrDetail } from './components/PrDetail.js';
import { Timeline } from './components/Timeline/index.js';
import { TimelineList } from './components/Timeline/TimelineList.js';
import { useIsDesktop, useIsPhone, useTimelineListCapable } from './components/ui/media.js';
import { usePageToastSlot } from './components/ui/PageHeader.js';
import { useTimelineLayout } from './store/timelineLayout.js';
import { ActivityView } from './components/Activity/index.js';
import { SprintTabView } from './components/Sprint/SprintTabView.js';
import { MetricsDetail } from './components/Activity/MetricsDetail.js';
import { BotPrsDetail } from './components/Activity/BotPrsDetail.js';
import { BotOnlyPrsDetail } from './components/Activity/BotOnlyPrsDetail.js';
import { BotThreadsDetail } from './components/Activity/BotThreadsDetail.js';
import { BotFlaggingDetail } from './components/Activity/BotFlaggingDetail.js';
import { BotVolumeDetail } from './components/Activity/BotVolumeDetail.js';
import { UserActivityDetail } from './components/Activity/UserActivityDetail.js';
import { TicketTabView } from './components/Ticket/TicketTabView.js';
import { BotDetailPanel } from './components/Activity/BotDetailPanel.js';
import { ThemeThreadsDetail } from './components/Activity/ThemeThreadsDetail.js';
import { SearchResultsTab } from './components/Search/SearchResultsTab.js';
import { DetailPane } from './components/DetailPane.js';
import { ClaudeReviewBanner } from './components/ClaudeReviewBanner.js';
import { AiFixBanner } from './components/AiFixBanner.js';
import { AutoMergeBanner } from './components/AutoMergeBanner.js';
import { GlobalLoadingBar } from './components/GlobalLoadingBar.js';
import { HeaderToastStrip } from './components/HeaderToasts.js';
import { AiBudgetToast } from './components/AiBudget.js';
import { HelpModal } from './components/HelpModal.js';
import { SettingsModal } from './components/settings/SettingsModal.js';
import { useSettingsModal } from './store/settingsModal.js';
import { ConflictResolverOverlay } from './components/conflicts/ConflictResolverOverlay.js';
import { ClosedResolverToast } from './components/conflicts/ClosedResolverToast.js';
import { DependencyMergeToast } from './components/Activity/DependencyMergeAll.js';
import { AuthNoticeBanner } from './components/AuthNoticeBanner.js';
import { useUrlState } from './hooks/useUrlState.js';
import { useLocalStorage } from './hooks/useLocalStorage.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useDetailCacheReconciler } from './hooks/useDetailCache.js';
import { useClaudeReviewActiveSync } from './hooks/useClaudeReview.js';
import { useMyTurnNotifications } from './hooks/useMyTurnNotifications.js';
import { useNotificationPref, notificationsSupported } from './hooks/useNotificationPref.js';
import { useMe } from './hooks/useTriage.js';
import { useFilters } from './store/filters.js';
import { boardSlotMode, isFixedView, usePinnedTabs, type TimelineMode } from './store/pinnedTabs.js';
import { ApiError, api } from './api/client.js';
import { Wordmark } from './components/Wordmark';
import { CommandPalette } from './components/ui/CommandPalette.js';
import { UndoToast } from './components/ui/UndoToast.js';
import { useShellCommands } from './hooks/useShellCommands.js';
import { Sidebar } from './components/shell/Sidebar.js';
import { TopBar } from './components/shell/TopBar.js';
import { BottomBar } from './components/shell/BottomBar.js';
import { ShortcutsSheet } from './components/shell/ShortcutsSheet.js';
import { useShell } from './store/shell.js';
import { useWorkspaceShell } from './components/WorkspaceSelector.js';
import { WorkspaceManagerModal } from './components/Activity/WorkspaceManager.js';

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(
    () => (localStorage.getItem('theme') ?? 'dark') !== 'light',
  );
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);
  // Stable, so the ⌘K command list built from it is not rebuilt on every render.
  const toggle = useCallback(() => setDark((d) => !d), []);
  return [dark, toggle];
}

export default function App(): JSX.Element {
  // All hooks run unconditionally (rules-of-hooks) before we branch on the me state for the
  // return value.
  const me = useMe();
  useUrlState();
  useKeyboard();
  // Invalidate persisted PR/thread detail when the lean feed shows a newer
  // updatedAt, so hydrated text refetches exactly once on change (no-op for
  // unchanged PRs).
  useDetailCacheReconciler();
  // A Claude review that starts or ends anywhere refetches that PR's review (the tab pill). ONE
  // passive observer of the polled active list; it fetches nothing itself.
  useClaudeReviewActiveSync();
  const [dark, toggleDark] = useDarkMode();
  // Help and the key sheet open from the sidebar foot, ⌘K and `?`, so their state is the shell's.
  const helpOpen = useShell((s) => s.helpOpen);
  const setHelpOpen = useShell((s) => s.setHelpOpen);
  const shortcutsOpen = useShell((s) => s.shortcutsOpen);
  const setShortcutsOpen = useShell((s) => s.setShortcutsOpen);
  const openHelp = useCallback(() => setHelpOpen(true), [setHelpOpen]);
  const closeHelp = useCallback(() => setHelpOpen(false), [setHelpOpen]);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [setShortcutsOpen]);
  // The workspace scope keeper, first-run's "Manage repos & workspaces" and the manager itself —
  // they lived inside the workspace picker, which is now in a sidebar that can be display:none.
  const { managerOpen, closeManager } = useWorkspaceShell();
  // ⌘K reaches every destination, every Settings tab and every open PR (components/ui/commands.ts).
  useShellCommands({ toggleTheme: toggleDark, openHelp });
  // The Settings modal opens from the avatar menu AND from Pending's "Customise" link, so its
  // state lives in a store. `closeSettings` is a zustand action — referentially STABLE, which
  // SettingsModal needs: it registers its capture-phase Escape handler in an effect keyed on
  // `onClose`, and an inline arrow re-registered it on every App render.
  const settingsOpen = useSettingsModal((s) => s.open);
  const settingsFocus = useSettingsModal((s) => s.focus);
  const closeSettings = useSettingsModal((s) => s.closeSettings);

  // Opt-in browser notifications for new My Turn items + completed Claude reviews. Shared pref
  // (the Claude-review banner reads it too); the watcher fires only while granted + enabled. The
  // bell itself is in the sidebar foot (useNotificationToggle).
  const [notifEnabled] = useNotificationPref();
  useMyTurnNotifications(notifEnabled && notificationsSupported());

  // Item 7: the detail pane exists only once a PR is selected on the board; no
  // selection → the Timeline takes the full height.
  const selectedPrId = useFilters((s) => s.selectedPrId);
  const selectedThreadId = useFilters((s) => s.selectedThreadId);

  // The main area is ONE axis (`activeTab`): the shared board, the Activity console, or
  // one of the persistent tabs (pr-detail / pr-focus). Exactly one <Timeline> is ever
  // mounted — the "board slot" below — whose `mode` is derived from the active tab.
  // pr-detail + Activity are overlays OVER the warm full board; pr-focus REPLACES the
  // board slot with its own isolated Timeline instance (keyed remount).
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const tabs = usePinnedTabs((s) => s.tabs);
  // THE TOAST SEAT: at ≥ lg with no pinned tabs the top bar would hold nothing but the toast strip,
  // so it collapses and the ONE strip moves (a portal, never a copy) to the end of the page header's
  // title row (components/ui/PageHeader.tsx). Below lg it stays in the top bar, which a SidePanel
  // sheet starts under, so an Undo raised from the sheet stays reachable.
  const isDesktop = useIsDesktop();
  const pageToastSlot = usePageToastSlot();
  const toastsInPage = isDesktop && tabs.length === 0 && pageToastSlot != null;
  const activeTabObj = !isFixedView(activeTab)
    ? (tabs.find((t) => t.key === activeTab) ?? null) // stale/closed key → full board
    : null;
  const inboxActive = activeTab === 'activity';
  // This Sprint — a FIXED tab beside Activity (it was an Activity rail line), its own overlay.
  const sprintActive = activeTab === 'sprint';
  const prDetailId = activeTabObj?.kind === 'pr-detail' ? activeTabObj.prId : null;
  const metricsActive = activeTabObj?.kind === 'metrics-detail';
  const botPrsActive = activeTabObj?.kind === 'bot-prs';
  const botOnlyActive = activeTabObj?.kind === 'bot-only-prs';
  const botThreadsActive = activeTabObj?.kind === 'bot-threads';
  const botFlaggingActive = activeTabObj?.kind === 'bot-flagging';
  const botVolumeActive = activeTabObj?.kind === 'bot-volume';
  const themeThreadsActive = activeTabObj?.kind === 'theme-threads';
  const searchActive = activeTabObj?.kind === 'search';
  const userActivityActive = activeTabObj?.kind === 'user-activity';
  const botDetailActive = activeTabObj?.kind === 'bot-detail';
  const ticketActive = activeTabObj?.kind === 'ticket';
  // null = the full board. The ONE resolver the FilterBar also reads (store/pinnedTabs.ts), so the
  // bar's Focus controls and this slot can never disagree about a stale key.
  const boardMode: TimelineMode | null = boardSlotMode(activeTab, tabs);
  // A full-main overlay (a pr-detail PR, the Activity console, or a drill-down: metrics /
  // bot-PRs) covers the warm full board. Drives the `inert` a11y treatment. pr-focus is NOT
  // an overlay — it replaces the board slot, so it doesn't set this.
  //
  // Note the axis: these are TABS. The Activity console's own RAIL entries — Open PRs, Pending, Feed,
  // Bots, Reports (store value `'insights'`), and each repo — are not tabs and get no branch
  // here; they are `filters.activityRepoId` values rendered inside <ActivityView/>, which is
  // already covered by `inboxActive`. (The "Compare workspaces" rail line is gone —
  // there is no cross-workspace comparison and no TabKind for it.)
  const overlayActive =
    prDetailId != null ||
    inboxActive ||
    sprintActive ||
    metricsActive ||
    botPrsActive ||
    botOnlyActive ||
    botThreadsActive ||
    botFlaggingActive ||
    botVolumeActive ||
    themeThreadsActive ||
    searchActive ||
    userActivityActive ||
    botDetailActive ||
    ticketActive;
  // The detail pane is shown at the bottom of a PR FOCUS tab's Timeline (the tab's own PR is
  // selected). The SHARED board has no pane: a bar click opens the PR popover there
  // (components/Timeline/PrPopover.tsx), whose "Open details" opens the PR's own tab.
  const paneVisible = selectedPrId != null && !overlayActive && boardMode != null;
  // A phone: the shared board reads as a list by default, and the detail pane is a full-screen sheet.
  const phone = useIsPhone();
  const phoneLayout = useTimelineLayout((s) => s.phone);
  // …and so may a touch tablet below lg (useTimelineListCapable).
  const listCapable = useTimelineListCapable();
  const phoneTimelineList = listCapable && phoneLayout === 'list' && boardMode == null;

  // Resizable detail pane (Fix 2). Default taller than the old fixed 320px, and
  // the dragged height is remembered across reloads. During a drag we set the
  // height on the DOM node directly (no per-frame React render) and only commit
  // to state — and localStorage — on release.
  const [paneH, setPaneH] = useLocalStorage<number>('pierre:detailPaneHeight', 384);
  const paneRef = useRef<HTMLElement>(null);
  const timelineSectionRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // A11y: when a pinned PR is shown full-screen, the timeline + detail pane sit behind
  // an opaque overlay. Mark them `inert` so keyboard / screen-reader users don't tab
  // into hidden content (the overlay's controls become the only focusable ones in the
  // main area). `inert` isn't typed in this @types/react version, so set it imperatively.
  useEffect(() => {
    for (const el of [timelineSectionRef.current, paneRef.current]) {
      if (!el) continue;
      if (overlayActive) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
  }, [overlayActive]);

  // (The browser-Back handler used to live here, reading store flags and never looking at the
  // URL. It is now `useUrlState`'s single `popstate` listener, which re-applies the popped URL to
  // both stores — one history authority instead of two fighting over one event.)

  // Item 7: when the detail pane mounts/unmounts (a PR is selected/cleared), the
  // board-slot Timeline's flex height changes — nudge vis to recompute it.
  useEffect(() => {
    window.dispatchEvent(new Event('resize'));
  }, [paneVisible]);

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = {
      startY: e.clientY,
      startH: paneRef.current?.offsetHeight ?? paneH,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || !paneRef.current) return;
    const max = window.innerHeight * 0.7;
    const next = Math.min(Math.max(d.startH + (d.startY - e.clientY), 160), max);
    paneRef.current.style.height = `${next}px`;
    window.dispatchEvent(new Event('resize')); // keep vis filling the rest live
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current || !paneRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setPaneH(paneRef.current.offsetHeight); // commit + persist
  };

  // Initial load: minimal centered dark splash until /api/me settles (a failed /api/me falls
  // through to the app with `meUser` null).
  //
  // ⚠ `isPending`, NOT `isLoading`. While PersistQueryClientProvider restores the IndexedDB cache
  // the query is pending but NOT fetching (`isLoading` false), so the app rendered once, then the
  // fetch started, `isLoading` flipped true and the splash REPLACED THE WHOLE TREE ~1s after every
  // load — remounting the shell and losing anything the reader had already opened (the ⌘K palette
  // reappeared empty, the first keys typed into it were lost).
  if (me.data == null && me.isPending) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-ui-raise">
        <Wordmark className="text-4xl text-ui-ink" />
      </div>
    );
  }

  // The ONE header toast strip (components/HeaderToasts.tsx), in the slim top bar (or, at ≥ lg with no tabs, the page header). Every toast in
  // the app is a one-line card in here — never an independent `fixed` element, never a second
  // strip. Order = left to right: the Undo card, the agent runs, the one-shot results, then the ambient loading bar.
  const toasts = (
    <HeaderToastStrip>
      {/* Undo for an optimistic row removal (components/ui/undo.ts). FIRST, not last: it lives a
          few seconds and is the one card a reader must reach NOW — at the end of the strip a merge
          pill or a run pushed it past the bar's clipped right edge (768px), Undo out of reach. */}
      <UndoToast />
      <ClaudeReviewBanner />
      {/* Agentic AI-Fix runs started this session — the progress UI for a fix started outside the
          AI Fix tab. */}
      <AiFixBanner />
      {/* Automatic Claude runs paused by the reader's spend budget. */}
      <AiBudgetToast />
      {/* The way back into a conflict resolver the reader closed with decisions still in the store.
          The resolver has no URL and no history entry, so this card is the ONLY route back. */}
      <ClosedResolverToast />
      {/* Undo for the My Turn entry just dismissed from the Pending board. */}
      {/* The outcome of Pending → Dependencies' "Merge or arm all". */}
      <DependencyMergeToast />
      {/* "Merge when ready" — what is armed and what just landed (the old header's merge pill). */}
      <AutoMergeBanner />
      {/* Ambient heavy-work indicator (backfills + ML bot-comment scoring). Non-dismissible. */}
      <GlobalLoadingBar />
    </HeaderToastStrip>
  );

  return (
    <div className="flex h-full flex-col">
      <AuthNoticeBanner notices={me.data?.authNotices ?? []} />
      {/* THE SHELL (docs/redesign/DESIGN.md § 1): one sidebar, one slim top bar, the page. The
          sidebar is rendered ONCE and never unmounted (SyncStatus, the sync round's driver, lives in
          its foot); below lg it is a drawer, below md the phone also gets the bottom bar. */}
      <div className="flex min-h-0 flex-1">
        <Sidebar dark={dark} toggleDark={toggleDark} />
        <div className="flex min-w-0 flex-1 flex-col bg-ui-bg">
          <TopBar toasts={toastsInPage ? null : toasts} collapsed={toastsInPage} />
          {toastsInPage && pageToastSlot != null && createPortal(toasts, pageToastSlot)}
          {/* The Timeline's board filters (and a PR Focus tab's two) — nothing on other views. */}
          <FilterBar />
          {/* `relative` anchors the full-main overlays (pr-detail / Activity) below. `overflow-clip`: a
              page wider than a phone scrolls inside its own box, never the document (no scroll
              container is created, so no descendant scrollIntoView can push the shell off-screen). */}
          <main className="relative flex min-h-0 flex-1 flex-col overflow-clip">
            {/* The one board-slot Timeline. `mode` absent = the shared board; an isolate
                mode = a PR's own timeline — each a keyed remount so vis tears down cleanly
                (never reconfigured in place). */}
            <section ref={timelineSectionRef} className="relative min-h-0 flex-1 overflow-hidden">
              {boardMode == null ? (
                <Timeline key="board" />
              ) : (
                <Timeline key={`focus:${boardMode.prId}`} mode={boardMode} />
              )}
              {/* A phone reads the shared board as a LIST by default (the board stays mounted
                  underneath, warm, one tap away) — components/Timeline/TimelineList.tsx. */}
              {phoneTimelineList && <TimelineList />}
            </section>

            {/* The resize handle + detail pane: a PR Focus tab only (its PR is selected on boot).
                The shared board takes the full height — its PRs open as a popover, then a tab. */}
            {paneVisible && !phone && (
              <>
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize detail pane"
                  onPointerDown={onResizeDown}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeUp}
                  title="Drag to resize"
                  // A finger needs 40px: on touch the handle is a 40px band with a grabber pill.
                  className="group flex h-1 shrink-0 cursor-row-resize touch-none items-center justify-center bg-ui-surface transition-colors hover:bg-ui-accent-fill touch:h-10 touch:hover:bg-ui-surface"
                >
                  <span aria-hidden className="hidden h-1 w-10 rounded-full bg-ui-faint touch:block" />
                </div>
                <section
                  ref={paneRef}
                  style={{ height: paneH }}
                  className="shrink-0 overflow-auto"
                >
                  <DetailPane />
                </section>
              </>
            )}
            {/* A PHONE: the selected PR's detail is a FULL-SCREEN sheet over the board (Back clears
                the selection, as Esc and the × do), not a 384px strip under a 390px-wide canvas. */}
            {paneVisible && phone && (
              <section
                ref={paneRef}
                aria-label="Pull request detail"
                className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-ui-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] motion-safe:animate-ui-sheet-up"
              >
                <DetailPane sheet />
              </section>
            )}

            {/* A pr-detail PR shown full-screen: an overlay covering the board (which stays
                mounted underneath for instant, state-preserving return). Keyed by id so
                switching tabs remounts a fresh PrDetail. */}
            {prDetailId != null && (
              <div
                data-testid="pinned-pr-overlay"
                className="absolute inset-0 z-20 bg-ui-bg"
              >
                <PrDetail
                  key={prDetailId}
                  prId={prDetailId}
                  // A feed thread click opens this tab AND selects the thread — deep-link the
                  // Changes tab's threads to it (only when the selection is for THIS PR).
                  selectedThreadId={selectedPrId === prDetailId ? selectedThreadId : null}
                  placement="fullscreen"
                />
              </div>
            )}

            {/* The Activity triage console — a sibling full-main overlay over the board (which
                stays mounted underneath, like the pr-detail overlay). Never co-renders with
                a pr-detail PR. */}
            {inboxActive && (
              <div
                data-testid="activity-overlay"
                // ⚠ `overflow-clip`, NOT `overflow-hidden`. `hidden` still creates a scroll
                // CONTAINER — it only removes the scrollbar — so a descendant's `scrollIntoView`
                // can write a scrollTop onto this box and the user has no gesture to undo it: the
                // Pending board and the rail sit permanently pushed off the top. `clip` creates no
                // scroll container at all, so that scrollTop is unwritable. The Activity pane owning
                // its own containing block (see Activity/index.tsx) removes the phantom scroll range
                // that made this reachable; this removes the mechanism itself, for every future
                // descendant that scrolls something into view.
                className="absolute inset-0 z-20 overflow-clip bg-ui-bg"
              >
                <ActivityView />
              </div>
            )}

            {/* This Sprint — a fixed tab, a sibling full-main overlay over the board like Activity.
                The overlay is the scroll box (useRememberedScroll restores each sub-tab's position). */}
            {sprintActive && (
              <div
                data-testid="sprint-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <SprintTabView />
              </div>
            )}

            {/* The flow-metric drill-down — a sibling full-main overlay over the board. */}
            {metricsActive && (
              <div
                data-testid="metrics-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <MetricsDetail />
              </div>
            )}

            {/* The bot-vendor PR drill-down — a sibling full-main overlay over the board. */}
            {botPrsActive && (
              <div
                data-testid="bot-prs-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <BotPrsDetail />
              </div>
            )}

            {/* The bot-only-PRs drill-down — a sibling full-main overlay over the board. */}
            {botOnlyActive && (
              <div
                data-testid="bot-only-prs-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <BotOnlyPrsDetail />
              </div>
            )}

            {/* The resolvable-bot-threads review & resolve — a sibling full-main overlay. */}
            {botThreadsActive && (
              <div
                data-testid="bot-threads-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <BotThreadsDetail />
              </div>
            )}
            {/* The ML-strip drill-down ("what the bots are flagging") — a sibling full-main overlay.
                Its own scroll pane is what the list's auto-load sentinel roots its IntersectionObserver
                on (lib/scrollParent.ts), so `overflow-auto` here is load-bearing, not cosmetic. */}
            {botFlaggingActive && (
              <div
                data-testid="bot-flagging-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <BotFlaggingDetail />
              </div>
            )}
            {/* The merged PRs behind the ROI table's "bot comments per PR" column — a sibling
                full-main overlay. `overflow-auto` is load-bearing here too: it is the scroll pane the
                list's auto-load sentinel roots its IntersectionObserver on (lib/scrollParent.ts). */}
            {botVolumeActive && (
              <div
                data-testid="bot-volume-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <BotVolumeDetail />
              </div>
            )}
            {themeThreadsActive && (
              <div
                data-testid="theme-threads-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <ThemeThreadsDetail />
              </div>
            )}
            {/* One contributor's activity feed — a sibling full-main overlay. Keyed on the tab so
                switching between two people's tabs remounts the feed rather than reusing state. */}
            {userActivityActive && (
              <div
                key={activeTab}
                data-testid="user-activity-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <UserActivityDetail />
              </div>
            )}
            {/* One review bot's depth analytics — a sibling full-main overlay. Keyed on the tab so
                switching between two bots' tabs remounts the panel rather than reusing state. */}
            {botDetailActive && (
              <div
                key={activeTab}
                data-testid="bot-detail-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <BotDetailPanel />
              </div>
            )}
            {/* One ticket's pull requests (the ticket tab) — a sibling full-main overlay. Keyed on the
                tab so switching between two tickets' tabs remounts the view. */}
            {ticketActive && (
              <div
                key={activeTab}
                data-testid="ticket-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <TicketTabView />
              </div>
            )}
            {/* Cross-repo search results (scoped to the active workspace) — a sibling full-main
                overlay. */}
            {searchActive && (
              <div
                data-testid="search-overlay"
                className="absolute inset-0 z-20 overflow-auto bg-ui-bg"
              >
                <SearchResultsTab />
              </div>
            )}
          </main>
          <BottomBar />
        </div>
      </div>

      {helpOpen && <HelpModal onClose={closeHelp} />}
      {shortcutsOpen && <ShortcutsSheet onClose={closeShortcuts} />}
      <CommandPalette />
      {settingsOpen && <SettingsModal focus={settingsFocus} onClose={closeSettings} />}
      {/* "Manage repos & workspaces": opened from the workspace menu, ⌘K, the empty-workspace note,
          and once for a zero-repo account (useWorkspaceShell). */}
      {managerOpen && <WorkspaceManagerModal onClose={closeManager} />}
      {/* The merge-conflict resolver, mounted HERE and not inside PrDetail: it opens from three
          places (the pane's Conflicts row, the expanded merge panel, the Pending board) and must
          not unmount when the pane behind it closes. It renders null until something opens it —
          `store/conflictResolver.ts` holds the target — so this costs one selector read. */}
      <ConflictResolverOverlay />
    </div>
  );
}
