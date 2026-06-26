import { useRef, useState } from 'react';
import { useSavedViews } from '../hooks/useSavedViews.js';
import { useClickOutside } from '../hooks/useClickOutside.js';

// "Views ▾" dropdown in the filter bar: save the current filter set under a name
// and switch between saved views in one click. Each row carries apply (the name),
// overwrite (↻ — re-save THIS view with the current filters; disabled when it already
// matches), and delete (✕). Snapshots only the filter bar (see useSavedViews);
// applying replaces the board's filters. The active view is remembered across reloads
// (useSavedViews persists its name; useUrlState restores it on a bare load). Disabled
// during focus, like Clear filters — you reshape the board after leaving the lens.
export function SavedViews({ disabled }: { disabled: boolean }): JSX.Element {
  const { views, activeName, save, remove, apply } = useSavedViews();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, () => setOpen(false), open);

  const commitSave = (): void => {
    if (!name.trim()) return;
    save(name);
    setName('');
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title={
          disabled
            ? 'Exit focus mode to change filters'
            : activeName != null
              ? `Active view: ${activeName}`
              : 'Saved filter views'
        }
        className={`inline-flex max-w-[12rem] items-center whitespace-nowrap rounded border px-2 py-0.5 text-xs transition ${
          disabled
            ? 'cursor-not-allowed border-gray-300 text-gray-600 opacity-45 dark:border-gray-700 dark:text-gray-300'
            : activeName != null
              ? 'border-blue-400 text-blue-700 hover:border-blue-500 dark:border-blue-600 dark:text-blue-300'
              : 'border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-800 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:text-gray-100'
        }`}
      >
        {activeName != null ? (
          <>
            <span className="shrink-0">Views:&nbsp;</span>
            <span className="min-w-0 truncate font-medium">{activeName}</span>
            <span className="shrink-0">&nbsp;▾</span>
          </>
        ) : (
          <>Views{views.length > 0 ? ` (${views.length})` : ''} ▾</>
        )}
      </button>

      {open && !disabled && (
        <div className="absolute right-0 top-full z-[60] mt-1 w-60 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {views.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-gray-500">No saved views yet.</div>
          ) : (
            <div className="max-h-60 overflow-auto">
              {views.map((v) => {
                const isActive = v.name === activeName;
                return (
                <div
                  key={v.name}
                  className={`flex items-center gap-1 rounded ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-900/20'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      apply(v);
                      setOpen(false);
                    }}
                    title={isActive ? `"${v.name}" is active` : `Apply "${v.name}"`}
                    className={`flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-xs ${
                      isActive ? 'font-medium text-blue-700 dark:text-blue-300' : ''
                    }`}
                  >
                    <span aria-hidden className="w-3 shrink-0 text-blue-500">
                      {isActive ? '✓' : ''}
                    </span>
                    <span className="min-w-0 truncate">{v.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => save(v.name)}
                    disabled={isActive}
                    title={
                      isActive
                        ? `"${v.name}" already matches the current filters`
                        : `Overwrite "${v.name}" with the current filters`
                    }
                    aria-label={`Overwrite view ${v.name} with current filters`}
                    className="px-1.5 py-1.5 text-xs text-gray-400 hover:text-blue-500 disabled:cursor-default disabled:opacity-30 disabled:hover:text-gray-400"
                  >
                    ↻
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(v.name)}
                    title={`Delete "${v.name}"`}
                    aria-label={`Delete view ${v.name}`}
                    className="px-2 py-1.5 text-xs text-gray-400 hover:text-red-500"
                  >
                    ✕
                  </button>
                </div>
                );
              })}
            </div>
          )}

          <div className="mt-1 flex items-center gap-1 border-t border-gray-200 pt-1.5 dark:border-gray-800">
            <input
              type="text"
              value={name}
              placeholder="Save current as…"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSave();
              }}
              className="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-1.5 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700"
            />
            <button
              type="button"
              onClick={commitSave}
              disabled={!name.trim()}
              className="shrink-0 rounded border border-blue-400 px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-40 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
