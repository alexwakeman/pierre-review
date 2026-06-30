import { useEffect, useRef, useState } from 'react';
import { FilterBar } from './components/FilterBar.js';
import { OpenPrsStrip } from './components/OpenPrsStrip/index.js';
import { PinnedTabsBar } from './components/PinnedTabsBar.js';
import { PrDetail } from './components/PrDetail.js';
import { Timeline } from './components/Timeline/index.js';
import { InboxView } from './components/Inbox/index.js';
import { DetailPane } from './components/DetailPane.js';
import { ClaudeReviewBanner } from './components/ClaudeReviewBanner.js';
import { SyncStatus } from './components/SyncStatus.js';
import { TimelineSearch } from './components/TimelineSearch.js';
import { InsightsModal } from './components/InsightsModal.js';
import { WelcomeBackBanner } from './components/WelcomeBackBanner.js';
import { HelpModal } from './components/HelpModal.js';
import { ClaudeReviewsModal } from './components/ClaudeReviewsModal.js';
import { SignInGate } from './components/SignInGate.js';
import { useUrlState } from './hooks/useUrlState.js';
import { useLocalStorage } from './hooks/useLocalStorage.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useDetailCacheReconciler } from './hooks/useDetailCache.js';
import { useMyTurnNotifications } from './hooks/useMyTurnNotifications.js';
import { useNotificationPref } from './hooks/useNotificationPref.js';
import { useMe } from './hooks/useTriage.js';
import { useFilters } from './store/filters.js';
import { usePinnedTabs } from './store/pinnedTabs.js';
import { ApiError, api } from './api/client.js';
import { profileUrl } from './lib/ui.js';
import { initAnalytics, trackPageView } from './lib/analytics.js';

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

// Header segmented control switching the main area between the Timeline board and
// the Inbox triage console (always-on core, NOT feature-flagged). The two share the
// pinnedTabs `activeTab` axis: "Inbox" sets it to 'inbox' (rendering the full-main
// overlay); "Timeline" calls showTimeline() (which every timeline-nav action already
// calls, so the board is always the exit). A pinned-PR tab counts as the board side
// here — the Timeline segment reads active whenever the Inbox isn't showing.
function TabSwitcher(): JSX.Element {
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const showTimeline = usePinnedTabs((s) => s.showTimeline);
  const setActiveTab = usePinnedTabs((s) => s.setActiveTab);
  const inboxActive = activeTab === 'inbox';
  const seg = (active: boolean): string =>
    `rounded px-2 py-0.5 text-xs font-semibold ${
      active
        ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-700 dark:text-blue-400'
        : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
    }`;
  return (
    <div
      className="flex items-center gap-0.5 rounded border border-gray-300 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800"
      role="tablist"
      aria-label="Main view"
    >
      <button
        type="button"
        role="tab"
        aria-selected={!inboxActive}
        onClick={showTimeline}
        className={seg(!inboxActive)}
        title="Timeline — the activity board"
      >
        Timeline
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={inboxActive}
        onClick={() => setActiveTab('inbox')}
        className={seg(inboxActive)}
        title="Inbox — per-repo triage console"
      >
        Inbox
      </button>
    </div>
  );
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
  const [reviewsOpen, setReviewsOpen] = useState(false);

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
  const claudeReviewEnabled = me.data?.claudeReviewEnabled ?? false;
  const onSignOut = (): void => {
    // Drop pinned tabs so they don't leak to the next user on a shared browser.
    usePinnedTabs.getState().clear();
    void api.logout().finally(() => window.location.assign('/'));
  };
  // Drives the focus-mode frame around the timeline + detail pane (the "lens").
  // The Timeline owns the overlay and reports this via the store; it clears on
  // exit. The on-screen exit control (the "Focus mode" pill) now lives in the
  // FilterBar, next to "Clear filters"; Esc and the browser Back button still work.
  const focusActive = useFilters((s) => s.focusActive);
  // My Turn Focus Mode also frames the board (isolated to your inbox) and shows its
  // own exit pill in the FilterBar; same frame so the "you're in a focus" cue is one.
  const myTurnOnly = useFilters((s) => s.myTurnOnly);
  const insightsOpen = useFilters((s) => s.insightsOpen);
  const setInsightsOpen = useFilters((s) => s.setInsightsOpen);

  // Pinned-PR tabs (under the Open-PRs strip). When a PR tab is active the main
  // area shows that PR full-screen — rendered as an overlay OVER the timeline +
  // detail pane (which stay mounted underneath, so returning to the board is
  // instant and preserves all vis-timeline state). Guarded against an active id
  // that's no longer pinned.
  const activeTab = usePinnedTabs((s) => s.activeTab);
  const pinned = usePinnedTabs((s) => s.pinned);
  const activePinnedId =
    typeof activeTab === 'number' && pinned.some((p) => p.id === activeTab)
      ? activeTab
      : null;
  const inboxActive = activeTab === 'inbox';
  // Either full-main overlay (a pinned PR or the Inbox) covers the timeline + detail
  // pane: they share one `activeTab` axis, so never both at once. Drives the `inert`
  // a11y treatment and suppresses the focus-frame lens (which would draw underneath).
  const overlayActive = activePinnedId != null || inboxActive;

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
  // main area). `inert` isn't typed in this @types/react version, so set it
  // imperatively — same pattern as OpenPrsStrip's collapsed panel.
  useEffect(() => {
    for (const el of [timelineSectionRef.current, paneRef.current]) {
      if (!el) continue;
      if (overlayActive) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }
  }, [overlayActive]);

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

  // Google Analytics — CLOUD ONLY. Init once the signed-in cloud app mounts and
  // record one page view ("someone opened the app"). Gated on isCloud so local
  // installs never load gtag or phone home (see lib/analytics.ts). No-op until a
  // VITE_GA_ID is supplied at build time (the same id the landing uses).
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
        <span className="brand-title text-4xl text-gray-100">Pierre</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <h1 className="brand-title" title="Pierre — a play on “PR”">
          Pierre
        </h1>
        {meUser != null && (
          <a
            href={profileUrl(meUser.login)}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:underline dark:text-gray-300"
            title={
              meUser.displayName != null
                ? `Signed in as ${meUser.displayName} (@${meUser.login})`
                : `Signed in as ${meUser.login}`
            }
          >
            {meUser.avatarUrl != null ? (
              <img
                src={meUser.avatarUrl}
                alt={meUser.displayName ?? meUser.login}
                width={20}
                height={20}
                className="shrink-0 rounded-full"
                style={{ width: 20, height: 20 }}
              />
            ) : (
              <span
                className="flex shrink-0 items-center justify-center rounded-full bg-gray-300 text-[9px] font-semibold text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                style={{ width: 20, height: 20 }}
              >
                {(meUser.displayName ?? meUser.login).slice(0, 2).toUpperCase()}
              </span>
            )}
            <span>{meUser.displayName ?? meUser.login}</span>
          </a>
        )}
        <TabSwitcher />
        <div className="ml-auto flex items-center gap-3">
          <TimelineSearch />
          <SyncStatus />
          <button
            type="button"
            onClick={() => setInsightsOpen(true)}
            className="flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs font-semibold hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
            title="Insights — per-repo PR stats (open / merged / stalled / review load)"
            aria-label="Insights"
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
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            Insights
          </button>
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
          {claudeReviewEnabled && (
            <button
              type="button"
              onClick={() => setReviewsOpen(true)}
              className="flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs font-semibold hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
              title="Claude reviews — history of agentic PR reviews"
              aria-label="Claude reviews"
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
                <path d="M9 2h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1z" />
                <path d="M9 4h6" />
                <path d="M9 11h6" />
                <path d="M9 15h4" />
              </svg>
              Claude Reviews
            </button>
          )}
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs font-semibold hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
            title="Help — what is Pierre and how to use it"
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
          {isCloud && (
            <button
              type="button"
              onClick={onSignOut}
              className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
              title="Sign out"
              aria-label="Sign out"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <InsightsModal open={insightsOpen} onClose={() => setInsightsOpen(false)} />
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {/* Only mount when the feature is enabled — the trigger button is already
          gated, and this ensures the modal never fetches /api/claude-reviews
          (which doesn't exist when the feature is off, e.g. cloud). */}
      {claudeReviewEnabled && (
        <ClaudeReviewsModal
          open={reviewsOpen}
          onClose={() => setReviewsOpen(false)}
        />
      )}

      <WelcomeBackBanner />
      <FilterBar />
      <OpenPrsStrip />
      <PinnedTabsBar />

      {/* `relative` anchors the full-screen pinned-PR overlay below. The focus-frame
          lens is suppressed while a PR tab is active (it would draw under the overlay). */}
      <main
        className={`relative flex min-h-0 flex-1 flex-col${
          !overlayActive && (focusActive || myTurnOnly) ? ' focus-frame' : ''
        }`}
      >
        <section ref={timelineSectionRef} className="min-h-0 flex-1 overflow-hidden">
          <Timeline />
        </section>
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

        {/* A pinned PR shown full-screen: an overlay covering the timeline + detail
            pane (both stay mounted underneath for instant, state-preserving return).
            Keyed by id so switching tabs remounts a fresh PrDetail. */}
        {activePinnedId != null && (
          <div
            data-testid="pinned-pr-overlay"
            className="absolute inset-0 z-20 bg-white dark:bg-gray-950"
          >
            <PrDetail key={activePinnedId} prId={activePinnedId} selectedThreadId={null} />
          </div>
        )}

        {/* The Inbox triage console — a sibling full-main overlay over the timeline +
            detail pane (which stay mounted underneath, like the pinned-PR overlay, so
            returning to the board is instant). Never co-renders with a pinned PR. */}
        {inboxActive && (
          <div
            data-testid="inbox-overlay"
            className="absolute inset-0 z-20 overflow-hidden bg-white dark:bg-gray-950"
          >
            <InboxView />
          </div>
        )}
      </main>
      <ClaudeReviewBanner />
    </div>
  );
}
