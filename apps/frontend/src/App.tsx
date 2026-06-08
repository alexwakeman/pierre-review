import { useEffect, useRef, useState } from 'react';
import { FilterBar } from './components/FilterBar.js';
import { OpenPrsStrip } from './components/OpenPrsStrip/index.js';
import { Timeline } from './components/Timeline/index.js';
import { DetailPane } from './components/DetailPane.js';
import { ClaudeReviewBanner } from './components/ClaudeReviewBanner.js';
import { SyncStatus } from './components/SyncStatus.js';
import { TimelineSearch } from './components/TimelineSearch.js';
import { HelpModal } from './components/HelpModal.js';
import { ClaudeReviewsModal } from './components/ClaudeReviewsModal.js';
import { SignInGate } from './components/SignInGate.js';
import { useUrlState } from './hooks/useUrlState.js';
import { useLocalStorage } from './hooks/useLocalStorage.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useDetailCacheReconciler } from './hooks/useDetailCache.js';
import { useMe } from './hooks/useTriage.js';
import { useFilters } from './store/filters.js';
import { ApiError, api } from './api/client.js';
import { profileUrl } from './lib/ui.js';

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
  const [reviewsOpen, setReviewsOpen] = useState(false);

  const isCloud = me.data?.deploymentMode === 'cloud';
  // The signed-in GitHub user (local: synthesized from `gh api user`; cloud: the
  // OAuth user). Can be null even when authenticated (e.g. local + offline), so
  // every read below is guarded.
  const meUser = me.data?.user ?? null;
  const claudeReviewEnabled = me.data?.claudeReviewEnabled ?? false;
  const onSignOut = (): void => {
    void api.logout().finally(() => window.location.assign('/'));
  };
  // Drives the focus-mode frame around the timeline + detail pane (the "lens").
  // The Timeline owns the overlay and reports this via the store; it clears on
  // exit. The on-screen exit control (the "Focus mode" pill) now lives in the
  // FilterBar, next to "Clear filters"; Esc and the browser Back button still work.
  const focusActive = useFilters((s) => s.focusActive);

  // Resizable detail pane (Fix 2). Default taller than the old fixed 320px, and
  // the dragged height is remembered across reloads. During a drag we set the
  // height on the DOM node directly (no per-frame React render) and only commit
  // to state — and localStorage — on release.
  const [paneH, setPaneH] = useLocalStorage<number>('pierre:detailPaneHeight', 384);
  const paneRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

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
            title={`Signed in as ${meUser.login}`}
          >
            {meUser.avatarUrl != null ? (
              <img
                src={meUser.avatarUrl}
                alt={meUser.login}
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
                {meUser.login.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span>{meUser.login}</span>
          </a>
        )}
        <div className="ml-auto flex items-center gap-3">
          <TimelineSearch />
          <SyncStatus />
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

      <FilterBar />
      <OpenPrsStrip />

      <main className={`flex min-h-0 flex-1 flex-col${focusActive ? ' focus-frame' : ''}`}>
        <section className="min-h-0 flex-1 overflow-hidden">
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
      </main>
      <ClaudeReviewBanner />
    </div>
  );
}
