import { useEffect, useRef, useState } from 'react';
import { FilterBar } from './components/FilterBar.js';
import { OpenPrsStrip } from './components/OpenPrsStrip/index.js';
import { Timeline } from './components/Timeline/index.js';
import { DetailPane } from './components/DetailPane.js';
import { ClaudeReviewBanner } from './components/ClaudeReviewBanner.js';
import { SyncStatus } from './components/SyncStatus.js';
import { TimelineSearch } from './components/TimelineSearch.js';
import { HelpModal } from './components/HelpModal.js';
import { useUrlState } from './hooks/useUrlState.js';
import { useLocalStorage } from './hooks/useLocalStorage.js';
import { useKeyboard } from './hooks/useKeyboard.js';
import { useFilters } from './store/filters.js';

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
  useUrlState();
  useKeyboard();
  const [dark, toggleDark] = useDarkMode();
  const [helpOpen, setHelpOpen] = useState(false);
  // Surfaced as a subtle header badge so it's clear we're in the PR-focus view
  // mode. The Timeline owns the overlay and reports this; it clears on exit.
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <h1 className="brand-title" title="Pierre — a play on “PR”">
          Pierre
        </h1>
        {focusActive && (
          <span
            className="focus-indicator"
            title="You're in PR focus mode — Esc, the browser Back button, or Exit focus to leave"
          >
            <span className="focus-indicator-dot" aria-hidden="true" />
            Focus mode
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <TimelineSearch />
          <SyncStatus />
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
        </div>
      </header>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      <FilterBar />
      <OpenPrsStrip />

      <main className="flex min-h-0 flex-1 flex-col">
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
