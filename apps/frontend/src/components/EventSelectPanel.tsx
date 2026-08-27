import { useEffect, useRef, useState } from 'react';
import type { EventCategory, ReviewState } from '@pierre-review/shared';
import {
  ALL_CATEGORIES,
  ALL_REVIEW_STATES,
  DEFAULT_CATEGORIES,
  DEFAULT_REVIEW_STATES,
} from '../store/filters.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { CaretIcon, CloseIcon } from './Icons.js';

// Labels for every category. `lifecycle` and `reviews` are kept here (the Record
// requires all keys) but aren't offered as coarse toggles — lifecycle draws no
// markers, and reviews are filtered by the finer per-verdict toggles below — so
// they never render; see ALL_CATEGORIES.
const CATEGORY_LABELS: Record<EventCategory, string> = {
  lifecycle: 'PR state events',
  reviews: 'Reviews',
  review_comments: 'Review comments',
  pr_comments: 'PR comments',
  commits: 'Commits',
};

// The PR-review verdicts, as their own filter group. Each maps 1:1 to a review
// marker (review_submitted). A small colour dot echoes the timeline glyph colours
// (approve green, changes-requested orange, comment/dismiss grey).
const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  commented: 'Commented',
  dismissed: 'Dismissed',
  pending: 'Pending',
};
const REVIEW_STATE_COLORS: Record<ReviewState, string> = {
  approved: '#22c55e',
  changes_requested: '#f97316',
  commented: '#9ca3af',
  dismissed: '#9ca3af',
  pending: '#9ca3af',
};

// Order-independent equality for the small selection arrays — used to tell when the
// selection deviates from the default baseline (so the trigger badges it).
function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Show/hide dropdown for what the timeline draws as event markers. Two groups: PR-
// review verdicts (Approved / Changes requested / Commented / Dismissed) and the
// other event categories (Review comments, PR comments, Commits). Each is a checkbox;
// toggling is immediate (no Apply). The committed selection lives in the store's
// `reviewStates` + `categories`; the defaults (all verdicts; everything but the noisy
// Commits) are the baseline the deviation badge + the reset measure against.
export function EventSelectPanel({
  categories,
  onToggleCategory,
  onSetCategories,
  reviewStates,
  onToggleReviewState,
  onSetReviewStates,
}: {
  categories: EventCategory[];
  onToggleCategory: (c: EventCategory) => void;
  onSetCategories: (c: EventCategory[]) => void;
  reviewStates: ReviewState[];
  onToggleReviewState: (s: ReviewState) => void;
  onSetReviewStates: (s: ReviewState[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const atDefault =
    sameSet(categories, DEFAULT_CATEGORIES) &&
    sameSet(reviewStates, DEFAULT_REVIEW_STATES);
  const count = categories.length + reviewStates.length;
  const total = ALL_CATEGORIES.length + ALL_REVIEW_STATES.length;

  const reset = (): void => {
    onSetCategories([...DEFAULT_CATEGORIES]);
    onSetReviewStates([...DEFAULT_REVIEW_STATES]);
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
          Events{atDefault ? '' : ` (${count})`}
          <CaretIcon dir="down" />
        </button>
        {!atDefault && (
          <button
            type="button"
            onClick={reset}
            title="Reset event filters to default"
            aria-label="Reset event filters to default"
            className="flex items-center self-stretch py-0.5 pl-0.5 pr-2 opacity-60 hover:opacity-100"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Event types"
          className="absolute left-0 top-full z-[60] mt-1 w-60 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="max-h-80 overflow-y-auto">
            <p className="px-1 pb-0.5 pt-1 text-[11px] uppercase tracking-wide text-gray-400">
              Reviews
            </p>
            {ALL_REVIEW_STATES.map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <input
                  type="checkbox"
                  checked={reviewStates.includes(s)}
                  onChange={() => onToggleReviewState(s)}
                />
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: REVIEW_STATE_COLORS[s] }}
                />
                <span className="text-gray-800 dark:text-gray-100">
                  {REVIEW_STATE_LABELS[s]}
                </span>
              </label>
            ))}

            <div className="my-1 border-t border-gray-200 dark:border-gray-700" />

            {ALL_CATEGORIES.map((c) => (
              <label
                key={c}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <input
                  type="checkbox"
                  checked={categories.includes(c)}
                  onChange={() => onToggleCategory(c)}
                />
                <span className="text-gray-800 dark:text-gray-100">
                  {CATEGORY_LABELS[c]}
                </span>
              </label>
            ))}
          </div>

          {!atDefault && (
            <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
              <span className="text-[11px] text-gray-400">
                {count} of {total} shown
              </span>
              <button
                type="button"
                onClick={reset}
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
