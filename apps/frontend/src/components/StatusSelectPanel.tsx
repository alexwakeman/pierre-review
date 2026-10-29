import { useEffect, useRef, useState } from 'react';
import type { PrStatus } from '@pierre-review/shared';
import { ALL_PR_STATUSES, DEFAULT_PR_STATUSES } from '../store/filters.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { CheckboxBox } from './ui/FormControls.js';
import { CaretIcon, CloseIcon } from './Icons.js';

const STATUS_LABELS: Record<PrStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

// Stale is HIDDEN by default (excludeStale = true), so the "Show stale PRs" checkbox
// is UNCHECKED by default. This is the baseline the deviation badge + reset measure
// against, alongside the status default.
const DEFAULT_EXCLUDE_STALE = true;
const STALE_TOOLTIP =
  'A stale PR is an open PR with no commits, comments or reviews in the selected ' +
  'time range. Unchecked hides them; check to include them.';

// Order-independent equality for the small status arrays — used to tell when the
// selection deviates from the default baseline (so the trigger badges it).
function sameSet(a: PrStatus[], b: PrStatus[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Show/hide dropdown for the PR statuses, plus the stale-PR toggle (moved here from
// its own filter chip). Each status is a checkbox (checked = PRs of that status
// show); below a divider, "Show stale PRs" includes open PRs with no recent activity
// (off by default). Toggling is immediate (no Apply). The committed selection lives
// in the store's `prStatuses` + `excludeStale`; the defaults (everything but Closed;
// stale hidden) are the baseline the deviation badge + the reset measure against.
export function StatusSelectPanel({
  statuses,
  onToggle,
  onSet,
  excludeStale,
  onExcludeStaleChange,
}: {
  statuses: PrStatus[]; // committed visible statuses
  onToggle: (s: PrStatus) => void; // immediate show/hide of one status
  onSet: (s: PrStatus[]) => void; // bulk set (reset to default)
  excludeStale: boolean; // true = stale open PRs hidden
  onExcludeStaleChange: (v: boolean) => void; // set the stale filter
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const atDefault =
    sameSet(statuses, DEFAULT_PR_STATUSES) && excludeStale === DEFAULT_EXCLUDE_STALE;
  // Count "shown" items across both groups: the visible statuses plus stale-when-
  // shown. Total is the four statuses + the stale row.
  const count = statuses.length + (excludeStale ? 0 : 1);
  const total = ALL_PR_STATUSES.length + 1;

  const reset = (): void => {
    onSet([...DEFAULT_PR_STATUSES]);
    onExcludeStaleChange(DEFAULT_EXCLUDE_STALE);
  };

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
      <span className="inline-flex items-center whitespace-nowrap rounded-ui bg-ui-raise text-body text-ui-mute hover:text-ui-ink">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`inline-flex h-7 items-center gap-1 rounded-ui pl-2.5 touch:h-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${
            atDefault ? 'pr-2.5' : 'pr-1'
          }`}
        >
          Status{atDefault ? '' : ` (${count})`}
          <CaretIcon dir="down" />
        </button>
        {!atDefault && (
          <button
            type="button"
            onClick={reset}
            title="Reset statuses to default"
            aria-label="Reset statuses to default"
            className="flex items-center self-stretch rounded-ui pl-0.5 pr-2 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:px-3"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="PR statuses"
          className="absolute left-0 top-full z-[60] mt-1 w-60 max-w-[calc(100vw-2rem)] rounded-ui bg-ui-raise p-2 text-ui-ink shadow-xl shadow-black/30 ring-1 ring-ui-line motion-safe:animate-ui-pop max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:mt-0 max-sm:max-h-[75vh] max-sm:w-auto max-sm:max-w-none max-sm:overflow-y-auto max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        >
          <div className="max-h-72 overflow-y-auto">
            {ALL_PR_STATUSES.map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-meta hover:bg-ui-hover"
              >
                <CheckboxBox
                  checked={statuses.includes(s)}
                  onChange={() => onToggle(s)}
                />
                <span className="text-ui-ink">
                  {STATUS_LABELS[s]}
                </span>
              </label>
            ))}

            <div className="my-1 border-t border-ui-line" />

            <label
              title={STALE_TOOLTIP}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-meta hover:bg-ui-hover"
            >
              <CheckboxBox
                checked={!excludeStale}
                onChange={() => onExcludeStaleChange(!excludeStale)}
              />
              <span className="text-ui-ink">Show stale PRs</span>
            </label>
          </div>

          {!atDefault && (
            <div className="mt-2 flex items-center justify-between border-t border-ui-line pt-2">
              <span className="text-meta text-ui-faint">
                {count} of {total} shown
              </span>
              <button
                type="button"
                onClick={reset}
                className="text-meta text-ui-faint hover:text-ui-ink"
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
