import { useEffect, useRef, useState } from 'react';
import { DERIVED_STATES, type DerivedState } from '@pierre-review/shared';
import { DERIVED_STATE_META } from '../lib/ui.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { CheckboxBox } from './ui/FormControls.js';
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
      <span className="inline-flex items-center whitespace-nowrap rounded-ui bg-ui-raise text-body text-ui-mute hover:text-ui-ink">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex h-7 items-center gap-1 rounded-ui pl-2.5 touch:h-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${
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
            className="flex items-center self-stretch rounded-ui pl-0.5 pr-2 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:px-3"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Thread states"
          className="absolute left-0 top-full z-[60] mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-ui bg-ui-raise p-2 text-ui-ink shadow-xl shadow-black/30 ring-1 ring-ui-line motion-safe:animate-ui-pop max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:mt-0 max-sm:max-h-[75vh] max-sm:w-auto max-sm:max-w-none max-sm:overflow-y-auto max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        >
          <p className="px-1 pb-1.5 text-meta leading-snug text-ui-faint">
            Show only PRs with a review thread that is:
          </p>
          <div className="max-h-72 overflow-y-auto">
            {DERIVED_STATES.map((s) => {
              const meta = DERIVED_STATE_META[s];
              return (
                <label
                  key={s}
                  title={meta.description}
                  className="flex cursor-pointer items-center gap-2 rounded-ui px-1 py-1 text-meta hover:bg-ui-hover"
                >
                  <CheckboxBox
                    checked={derivedStates.includes(s)}
                    onChange={() => onToggle(s)}
                  />
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.color }}
                  />
                  <span className="text-ui-ink">
                    {meta.label}
                  </span>
                </label>
              );
            })}
          </div>

          {active && (
            <div className="mt-2 flex items-center justify-between border-t border-ui-line pt-2">
              <span className="text-meta text-ui-faint">
                {count} selected
              </span>
              <button
                type="button"
                onClick={onClear}
                className="hit text-meta text-ui-faint hover:text-ui-ink"
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
