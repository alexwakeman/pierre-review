import { useEffect, useRef, useState } from 'react';
import type { PrStatus } from '@pierre-review/shared';
import { ALL_PR_STATUSES, DEFAULT_PR_STATUSES } from '../store/filters.js';
import { useClickOutside } from '../hooks/useClickOutside.js';

const STATUS_LABELS: Record<PrStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

// Order-independent equality for the small status arrays — used to tell when the
// selection deviates from the default baseline (so the trigger badges it).
function sameSet(a: PrStatus[], b: PrStatus[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Show/hide dropdown for the PR statuses. Replaces the old pill row: each status
// is a checkbox; checked = PRs of that status show on the timeline. Toggling is
// immediate (no Apply) — like EventSelectPanel, this is a visibility control. The
// committed selection lives in the store's `prStatuses`; the default (everything
// except the noisy Closed) is the baseline the deviation badge + the reset measure
// against.
export function StatusSelectPanel({
  statuses,
  onToggle,
  onSet,
}: {
  statuses: PrStatus[]; // committed visible statuses
  onToggle: (s: PrStatus) => void; // immediate show/hide of one status
  onSet: (s: PrStatus[]) => void; // bulk set (reset to default)
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const atDefault = sameSet(statuses, DEFAULT_PR_STATUSES);
  const count = statuses.length;

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
      {/* Trigger + (when deviating from the default) a reset-✕. Sibling buttons in
          one pill — never a button nested in a button (that can swallow clicks). */}
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-gray-300 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300 dark:hover:border-gray-500">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 py-0.5 pl-2.5 ${
            atDefault ? 'pr-2.5' : 'pr-1'
          }`}
        >
          Status{atDefault ? '' : ` (${count})`}
          <span aria-hidden className="text-[9px]">
            ▾
          </span>
        </button>
        {!atDefault && (
          <button
            type="button"
            onClick={() => onSet([...DEFAULT_PR_STATUSES])}
            title="Reset statuses to default"
            aria-label="Reset statuses to default"
            className="py-0.5 pl-0.5 pr-2 opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="PR statuses"
          className="absolute left-0 top-full z-[60] mt-1 w-56 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="max-h-72 overflow-y-auto">
            {ALL_PR_STATUSES.map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <input
                  type="checkbox"
                  checked={statuses.includes(s)}
                  onChange={() => onToggle(s)}
                />
                <span className="text-gray-800 dark:text-gray-100">
                  {STATUS_LABELS[s]}
                </span>
              </label>
            ))}
          </div>

          {!atDefault && (
            <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
              <span className="text-[11px] text-gray-400">
                {count} of {ALL_PR_STATUSES.length} shown
              </span>
              <button
                type="button"
                onClick={() => onSet([...DEFAULT_PR_STATUSES])}
                className="text-[11px] text-gray-400 hover:text-gray-600"
              >
                Reset to default
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
