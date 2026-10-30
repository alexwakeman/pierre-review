import { useEffect, useRef, useState } from 'react';
import type { EventCategory, ReviewState } from '@pierre-review/shared';
import {
  ALL_CATEGORIES,
  ALL_REVIEW_STATES,
  DEFAULT_CATEGORIES,
  DEFAULT_REVIEW_STATES,
} from '../store/filters.js';
import { useClickOutside } from '../hooks/useClickOutside.js';
import { CheckboxBox } from './ui/FormControls.js';
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
          Events{atDefault ? '' : ` (${count})`}
          <CaretIcon dir="down" />
        </button>
        {!atDefault && (
          <button
            type="button"
            onClick={reset}
            title="Reset event filters to default"
            aria-label="Reset event filters to default"
            className="flex items-center self-stretch rounded-ui pl-0.5 pr-2 opacity-60 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:px-3"
          >
            <CloseIcon size={11} />
          </button>
        )}
      </span>

      {open && (
        <div
          role="dialog"
          aria-label="Event types"
          className="absolute left-0 top-full z-[60] mt-1 w-60 max-w-[calc(100vw-2rem)] rounded-ui bg-ui-raise p-2 text-ui-ink shadow-xl shadow-black/30 ring-1 ring-ui-line motion-safe:animate-ui-pop max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:mt-0 max-sm:max-h-[75vh] max-sm:w-auto max-sm:max-w-none max-sm:overflow-y-auto max-sm:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        >
          <div className="max-h-80 overflow-y-auto">
            <p className="px-1 pb-0.5 pt-1 text-meta text-ui-faint">
              Reviews
            </p>
            {ALL_REVIEW_STATES.map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-2 rounded-ui px-1 py-1 text-meta hover:bg-ui-hover"
              >
                <CheckboxBox
                  checked={reviewStates.includes(s)}
                  onChange={() => onToggleReviewState(s)}
                />
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: REVIEW_STATE_COLORS[s] }}
                />
                <span className="text-ui-ink">
                  {REVIEW_STATE_LABELS[s]}
                </span>
              </label>
            ))}

            <div className="my-1 border-t border-ui-line" />

            {ALL_CATEGORIES.map((c) => (
              <label
                key={c}
                className="flex cursor-pointer items-center gap-2 rounded-ui px-1 py-1 text-meta hover:bg-ui-hover"
              >
                <CheckboxBox
                  checked={categories.includes(c)}
                  onChange={() => onToggleCategory(c)}
                />
                <span className="text-ui-ink">
                  {CATEGORY_LABELS[c]}
                </span>
              </label>
            ))}
          </div>

          {!atDefault && (
            <div className="mt-2 flex items-center justify-between border-t border-ui-line pt-2">
              <span className="text-meta text-ui-faint">
                {count} of {total} shown
              </span>
              <button
                type="button"
                onClick={reset}
                className="hit text-meta text-ui-faint hover:text-ui-ink"
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
