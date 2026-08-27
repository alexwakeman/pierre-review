import { useEffect, useRef, useState } from 'react';
import { DERIVED_STATES, type DerivedState } from '@pierre-review/shared';
import { DERIVED_STATE_META } from '../lib/ui.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { CaretIcon, CloseIcon } from './Icons.js';

// Show/hide dropdown for the derived thread-state ("Threads") filter. Replaces the
// old pill row: each thread state is a checkbox; checking it narrows the board to
// PRs that have at least one review thread in that state (the states OR together).
// Unlike the Events / Status panels — whose default is a non-empty visible subset —
// the DEFAULT here is EMPTY: no states checked = no thread filtering, every PR
// shows. So "at default" is simply an empty selection, and the deviation badge /
// reset-✕ appear once any state is checked. The committed selection lives in the
// store's `derivedStates`; toggling is immediate (no Apply), like the other panels.
export function ThreadStateSelectPanel({
  derivedStates,
  onToggle,
  onClear,
}: {
  derivedStates: DerivedState[]; // committed filter states (empty = no filtering)
  onToggle: (s: DerivedState) => void; // immediate add/remove of one state
  onClear: () => void; // clear the filter back to "all threads"
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = derivedStates.length > 0;
  const count = derivedStates.length;

  // Outside-click dismiss via the shared hook. Escape stays INLINE: it must
  // stopPropagation() so it doesn't bubble to the global keyboard handler (which
  // would clear the selection), so it can't be folded into the mousedown hook.
  useClickOutside(rootRef, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger + (when the filter is active) a clear-✕. Sibling buttons in one
          pill — never a button nested in a button (that can swallow clicks). */}
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-gray-300 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 py-0.5 pl-2.5 ${
            active ? 'pr-1' : 'pr-2.5'
          }`}
        >
          Threads{active ? ` (${count})` : ''}
          <CaretIcon dir="down" />
        </button>
        {active && (
          <button
            type="button"
            onClick={onClear}
            title="Clear the thread-state filter"
            aria-label="Clear the thread-state filter"
            className="flex items-center self-stretch py-0.5 pl-0.5 pr-2 opacity-60 hover:opacity-100"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Thread states"
          className="absolute left-0 top-full z-[60] mt-1 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <p className="px-1 pb-1.5 text-[11px] leading-snug text-gray-400">
            Show only PRs with a review thread that is:
          </p>
          <div className="max-h-72 overflow-y-auto">
            {DERIVED_STATES.map((s) => {
              const meta = DERIVED_STATE_META[s];
              return (
                <label
                  key={s}
                  title={meta.description}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={derivedStates.includes(s)}
                    onChange={() => onToggle(s)}
                  />
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.color }}
                  />
                  <span className="text-gray-800 dark:text-gray-100">
                    {meta.label}
                  </span>
                </label>
              );
            })}
          </div>

          {active && (
            <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
              <span className="text-[11px] text-gray-400">
                {count} selected
              </span>
              <button
                type="button"
                onClick={onClear}
                className="text-[11px] text-gray-400 hover:text-gray-600"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
