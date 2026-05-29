import { useEffect, useState } from 'react';
import { FilterBar } from './components/FilterBar.js';
import { OpenPrsStrip } from './components/OpenPrsStrip/index.js';
import { Timeline } from './components/Timeline/index.js';
import { DetailPane } from './components/DetailPane.js';
import { SyncStatus } from './components/SyncStatus.js';
import { useUrlState } from './hooks/useUrlState.js';
import { useKeyboard } from './hooks/useKeyboard.js';

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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <h1 className="text-sm font-semibold">gh-team-monitor</h1>
        <span className="hidden text-xs text-gray-400 sm:inline">
          <kbd>/</kbd> filter · <kbd>j</kbd>/<kbd>k</kbd> cycle PRs · <kbd>esc</kbd> clear
        </span>
        <div className="ml-auto flex items-center gap-3">
          <SyncStatus />
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

      <FilterBar />
      <OpenPrsStrip />

      <main className="flex min-h-0 flex-1 flex-col">
        <section className="min-h-0 flex-1 overflow-hidden">
          <Timeline />
        </section>
        <section className="h-80 shrink-0 overflow-auto border-t border-gray-200 dark:border-gray-800">
          <DetailPane />
        </section>
      </main>
    </div>
  );
}
