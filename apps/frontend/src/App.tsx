import { useEffect, useRef, useState } from 'react';
import { FilterBar } from './components/FilterBar.js';
import { PinnedTabsBar } from './components/PinnedTabsBar.js';
import { PrDetail } from './components/PrDetail.js';
import { Timeline } from './components/Timeline/index.js';
import { ActivityView } from './components/Activity/index.js';
import { MetricsDetail } from './components/Activity/MetricsDetail.js';
import { BotPrsDetail } from './components/Activity/BotPrsDetail.js';
import { OpenPrsDetail } from './components/Activity/OpenPrsDetail.js';
import { BotOnlyPrsDetail } from './components/Activity/BotOnlyPrsDetail.js';
import { BotThreadsDetail } from './components/Activity/BotThreadsDetail.js';
import { UserActivityDetail } from './components/Activity/UserActivityDetail.js';
import { ThemeThreadsDetail } from './components/Activity/ThemeThreadsDetail.js';
import { SearchResultsTab } from './components/Search/SearchResultsTab.js';
import { DetailPane } from './components/DetailPane.js';
import { ClaudeReviewBanner } from './components/ClaudeReviewBanner.js';
import { AutoMergeBanner } from './components/AutoMergeBanner.js';
import { SyncStatus } from './components/SyncStatus.js';
import { WelcomeBackBanner } from './components/WelcomeBackBanner.js';
import { HelpModal } from './components/HelpModal.js';
import { SettingsModal } from './components/settings/SettingsModal.js';
import { useHasProSettings } from './hooks/useProSettings.js';
import { SignInGate } from './components/SignInGate.js';
import { AuthNoticeBanner } from './components/AuthNoticeBanner.js';
import { UserMenu } from './components/UserMenu.js';
import { useUrlState } from './hooks/useUrlState.js';
import { useLocalStorage } from './hooks/useLocalStorage.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useDetailCacheReconciler } from './hooks/useDetailCache.js';
import { useMyTurnNotifications } from './hooks/useMyTurnNotifications.js';
import { useNotificationPref } from './hooks/useNotificationPref.js';
import { useMe } from './hooks/useTriage.js';
import { useFilters } from './store/filters.js';
import { usePinnedTabs, type TimelineMode } from './store/pinnedTabs.js';
import { ApiError, api } from './api/client.js';
import { initAnalytics, trackPageView } from './lib/analytics.js';
import { CookieBanner } from './components/CookieBanner.js';
import { Wordmark } from './components/Wordmark';

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(
    () => (localStorage.getItem('theme') ?? 'dark') !== 'light',
  );
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

export default function App(): JSX.Element {
  // Auth gate (cloud mode only). In local mode /api/me never 401s, so `me` just
  // resolves to a `deploymentMode: 'local'` payload and the branches below are
  // inert — the app renders exactly as before. All hooks run unconditionally
  // (rules-of-hooks) before we branch on the me state for the return value.
  const me = useMe();
  useUrlState();
  useKeyboard();
  // Invalidate persisted PR/thread detail when the lean feed shows a newer
  // updatedAt, so cloud-hydrated text refetches exactly once on change (no-op for
  // unchanged PRs). Harmless in local mode.
  useDetailCacheReconciler();
  const [dark, toggleDark] = useDarkMode();
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The config modal (and its avatar-menu entry) only exist when there's a Pro setting to show.
  const hasProSettings = useHasProSettings();

  // Opt-in browser notifications for new My Turn items + completed Claude reviews.
  // Shared pref (the Claude-review banner reads it too); the watcher fires only
  // while granted + enabled.
  const [notifEnabled, setNotifEnabled] = useNotificationPref();
  const notifSupported = typeof window !== 'undefined' && 'Notification' in window;
  useMyTurnNotifications(notifEnabled && notifSupported);
  const toggleNotifs = (): void => {
    if (!notifSupported) return;
    if (notifEnabled) {
      setNotifEnabled(false);
      return;
    }
    if (Notification.permission === 'granted') {
      setNotifEnabled(true);
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => setNotifEnabled(p === 'granted'));
    }
  };

  const isCloud = me.data?.deploymentMode === 'cloud';
  // The signed-in GitHub user (local: synthesized from `gh api user`; cloud: the
  // OAuth user). Can be null even when authenticated (e.g. local + offline), so
  // every read below is guarded.
  const meUser = me.data?.user ?? null;
  const onSignOut = (): void => {
    // Drop pinned tabs so they don't leak to the next user on a shared browser.
    usePinnedTabs.getState().clear();
    void api.logout().finally(() => window.location.assign('/'));
  };
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
  const activeTabObj =
    activeTab !== 'timeline' && activeTab !== 'activity'
      ? tabs.find((t) => t.key === activeTab) ?? null // stale/closed key → full board
      : null;
  const inboxActive = activeTab === 'activity';
  const prDetailId = activeTabObj?.kind === 'pr-detail' ? activeTabObj.prId : null;
  const metricsActive = activeTabObj?.kind === 'metrics-detail';
  const botPrsActive = activeTabObj?.kind === 'bot-prs';
  const openPrsActive = activeTabObj?.kind === 'open-prs';
  const botOnlyActive = activeTabObj?.kind === 'bot-only-prs';
  const botThreadsActive = activeTabObj?.kind === 'bot-threads';
  const themeThreadsActive = activeTabObj?.kind === 'theme-threads';
  const searchActive = activeTabObj?.kind === 'search';
  const userActivityActive = activeTabObj?.kind === 'user-activity';
  const boardMode: TimelineMode | null =
    activeTabObj?.kind === 'pr-focus'
      ? { kind: 'isolate', prId: activeTabObj.prId }
      : null; // full board
  // A full-main overlay (a pr-detail PR, the Activity console, or a drill-down: metrics /
  // bot-PRs) covers the warm full board. Drives the `inert` a11y treatment. pr-focus is NOT
  // an overlay — it replaces the board slot, so it doesn't set this.
  //
  // Note the axis: these are TABS. The Activity console's own RAIL entries — Insights, Feed,
  // Bots, Compare workspaces, Needs attention, and each repo — are not tabs and get no branch
  // here; they are `filters.activityRepoId` values rendered inside <ActivityView/>, which is
  // already covered by `inboxActive`. Compare workspaces in particular is a rail line
  // (`activityRepoId === 'compare'`), NOT a drill-down tab: there is no 'compare' TabKind and
  // nothing to add to this list for it.
  const overlayActive =
    prDetailId != null ||
    inboxActive ||
    metricsActive ||
    botPrsActive ||
    openPrsActive ||
    botOnlyActive ||
    botThreadsActive ||
    themeThreadsActive ||
    searchActive ||
    userActivityActive;
  // The detail pane is shown at the bottom of any board-slot Timeline (shared or
  // pr-focus) once a PR is selected there.
  const paneVisible = selectedPrId != null && !overlayActive;

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

  // Item 4: the single browser-Back handler. Opening a tab from the Activity pushes one
  // {pierreTab} history entry (see store/pinnedTabs.ts openTab). {pierreTab} is now the
  // ONLY pushState in the app, so any popstate while armed means the browser popped that
  // entry → return to the Activity. Mounted once; reads only our own store, so it survives
  // every tab remount.
  useEffect(() => {
    const onPop = (): void => usePinnedTabs.getState().navigateBack();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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

  // Cloud only: keep this tenant "active" so the backend scheduler keeps syncing
  // their repos while a tab is open (the server stamps accounts.lastActiveAt on this
  // request; the cron only syncs accounts active within syncActiveWindowMinutes). The
  // user chose "any open tab", so this fires on a plain interval rather than gating on
  // visibility — a backgrounded tab's timer is throttled to ≥1/min by the browser,
  // still well inside the ~15-min window. This covers an idle-but-open tab whose React
  // Query polling has paused; normal traffic already stamps. No-op in local mode.
  useEffect(() => {
    if (!isCloud) return;
    const ping = (): void => {
      // Raw fetch (not React Query) so it always hits the network and re-stamps.
      void api.me().catch(() => {
        /* transient / offline / expired session — the next tick retries */
      });
    };
    const id = window.setInterval(ping, 3 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [isCloud]);

  // Google Analytics — CLOUD ONLY, and CONSENT-GATED. Gated on isCloud so local installs never
  // load gtag or phone home; `initAnalytics` additionally no-ops without a build-time VITE_GA_ID
  // AND a stored consent grant, so this call is safe to make unconditionally here (it re-arms
  // analytics for someone who consented on a previous visit, and does nothing otherwise). The
  // first-time grant is wired straight from CookieBanner. See lib/analytics.ts + lib/consent.ts.
  useEffect(() => {
    if (!isCloud) return;
    initAnalytics();
    trackPageView();
  }, [isCloud]);

  // Signed-out cloud visitor → show the sign-in gate; never mount the timeline.
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <SignInGate />;
  }
  // Initial load: minimal centered dark splash until /api/me settles. Once it
  // has data (local always; cloud when signed in) we fall through to the app.
  if (me.isLoading && !me.data) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-gray-950">
        <Wordmark className="text-4xl text-gray-100" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AuthNoticeBanner notices={me.data?.authNotices ?? []} />
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <h1 title="Limn — to depict, to make clear">
          <Wordmark />
        </h1>
        <div className="ml-auto flex items-center gap-3">
          <SyncStatus />
          {notifSupported && (
            <button
              type="button"
              onClick={toggleNotifs}
              aria-pressed={notifEnabled}
              className={`rounded border px-2 py-0.5 text-xs hover:border-gray-400 dark:hover:border-gray-500 ${
                notifEnabled
                  ? 'border-blue-400 text-blue-600 dark:border-blue-600 dark:text-blue-400'
                  : 'border-gray-300 dark:border-gray-700'
              }`}
              title={
                notifEnabled
                  ? 'Notifications on — alerts when a new item enters your My Turn. Click to turn off.'
                  : 'Turn on browser notifications for new My Turn items'
              }
              aria-label="Toggle My Turn notifications"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill={notifEnabled ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs font-semibold hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
            title="Help — what is Limn and how to use it"
            aria-label="Help"
          >
            ?
          </button>
          <button
            type="button"
            onClick={toggleDark}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
            title="Toggle dark mode"
          >
            {dark ? '☀' : '☾'}
          </button>
          {/* Signed-in user — a subtle button at the far right opening an account menu
              (Open Profile on GitHub · Sign Out). Sign Out is cloud-only (local has no
              session), so the standalone header sign-out button is gone. */}
          {meUser != null && (
            <UserMenu
              user={meUser}
              canSignOut={isCloud}
              onSignOut={onSignOut}
              onOpenSettings={hasProSettings ? () => setSettingsOpen(true) : null}
            />
          )}
        </div>
      </header>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      <WelcomeBackBanner />
      <FilterBar />
      <PinnedTabsBar />

      {/* `relative` anchors the full-main overlays (pr-detail / Activity) below. */}
      <main className="relative flex min-h-0 flex-1 flex-col">
        {/* The one board-slot Timeline. `mode` absent = the shared board; an isolate
            mode = a PR's own timeline — each a keyed remount so vis tears down cleanly
            (never reconfigured in place). */}
        <section ref={timelineSectionRef} className="min-h-0 flex-1 overflow-hidden">
          {boardMode == null ? (
            <Timeline key="board" />
          ) : (
            <Timeline key={`focus:${boardMode.prId}`} mode={boardMode} />
          )}
        </section>

        {/* Item 7: the resize handle + detail pane exist only once a PR is selected on
            the board. No selection → the Timeline takes the full height. */}
        {paneVisible && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize detail pane"
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              title="Drag to resize"
              className="h-1 shrink-0 cursor-row-resize bg-gray-200 transition-colors hover:bg-blue-400 dark:bg-gray-800 dark:hover:bg-blue-500"
            />
            <section
              ref={paneRef}
              style={{ height: paneH }}
              className="shrink-0 overflow-auto"
            >
              <DetailPane />
            </section>
          </>
        )}

        {/* A pr-detail PR shown full-screen: an overlay covering the board (which stays
            mounted underneath for instant, state-preserving return). Keyed by id so
            switching tabs remounts a fresh PrDetail. */}
        {prDetailId != null && (
          <div
            data-testid="pinned-pr-overlay"
            className="absolute inset-0 z-20 bg-white dark:bg-gray-950"
          >
            <PrDetail
              key={prDetailId}
              prId={prDetailId}
              // A feed thread click opens this tab AND selects the thread — deep-link the
              // Threads tab to it (only when the selection is for THIS PR).
              selectedThreadId={selectedPrId === prDetailId ? selectedThreadId : null}
            />
          </div>
        )}

        {/* The Activity triage console — a sibling full-main overlay over the board (which
            stays mounted underneath, like the pr-detail overlay). Never co-renders with
            a pr-detail PR. */}
        {inboxActive && (
          <div
            data-testid="activity-overlay"
            className="absolute inset-0 z-20 overflow-hidden bg-white dark:bg-gray-950"
          >
            <ActivityView />
          </div>
        )}

        {/* The flow-metric drill-down — a sibling full-main overlay over the board. */}
        {metricsActive && (
          <div
            data-testid="metrics-overlay"
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
          >
            <MetricsDetail />
          </div>
        )}

        {/* The bot-vendor PR drill-down — a sibling full-main overlay over the board. */}
        {botPrsActive && (
          <div
            data-testid="bot-prs-overlay"
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
          >
            <BotPrsDetail />
          </div>
        )}

        {/* The sortable all-open-PRs drill-down — a sibling full-main overlay over the board. */}
        {openPrsActive && (
          <div
            data-testid="open-prs-overlay"
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
          >
            <OpenPrsDetail />
          </div>
        )}

        {/* The bot-only-PRs drill-down — a sibling full-main overlay over the board. */}
        {botOnlyActive && (
          <div
            data-testid="bot-only-prs-overlay"
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
          >
            <BotOnlyPrsDetail />
          </div>
        )}

        {/* The resolvable-bot-threads review & resolve — a sibling full-main overlay. */}
        {botThreadsActive && (
          <div
            data-testid="bot-threads-overlay"
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
          >
            <BotThreadsDetail />
          </div>
        )}
        {themeThreadsActive && (
          <div
            data-testid="theme-threads-overlay"
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
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
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
          >
            <UserActivityDetail />
          </div>
        )}
        {/* Cross-repo search results (scoped to the active workspace) — a sibling full-main
            overlay. */}
        {searchActive && (
          <div
            data-testid="search-overlay"
            className="absolute inset-0 z-20 overflow-auto bg-white dark:bg-gray-950"
          >
            <SearchResultsTab />
          </div>
        )}
      </main>
      <ClaudeReviewBanner />
      <AutoMergeBanner />
      {/* Analytics consent. Renders only in cloud, only when a GA4 id was configured at build
          time, and only until the user has chosen — see components/CookieBanner.tsx. */}
      <CookieBanner enabled={isCloud} />
    </div>
  );
}
