import { useEffect } from 'react';
import { useConflictResolverStore } from '../../store/conflictResolver.js';
import { CloseIcon } from '../Icons.js';
import { REOPEN, closedToast } from './copy.js';

// ── THE WAY BACK ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ A PLAIN CARD FOR THE ONE BOTTOM-RIGHT TOAST COLUMN IN `App.tsx`, never its own
// `fixed bottom-4 right-4` element. Three independent ones were painting over each other at the
// same coordinate; the column owns the position and `pointer-events-none`, and each card
// re-enables its own.
//
// ⚠ IT IS THE ONLY WAY BACK, AND THAT IS WHY IT EXISTS. The resolver has no URL key and no history
// entry (a `popstate` cannot be cancelled, so a deep link would make Back a way to lose work, and
// every address-bar visit to it would spend a clone). Closing therefore has to leave something on
// screen, or a reader who pressed Escape by accident has no route back to twenty minutes of
// decisions that are still sitting in the store.
//
// ⚠ NOTHING IS OFFERED AFTER A COMMIT. `closeConflictResolver` files `lastClosed: null` for
// `reason: 'committed'` — the pins have moved, so reopening would build a different model and the
// offer would be a lie.

/** Long enough to notice and reach; short enough that it is not a second banner. */
const TOAST_MS = 20_000;

export function ClosedResolverToast(): JSX.Element | null {
  const lastClosed = useConflictResolverStore((s) => s.lastClosed);
  const dismiss = useConflictResolverStore((s) => s.dismissClosedResolver);
  const open = useConflictResolverStore((s) => s.openConflictResolver);

  useEffect(() => {
    if (lastClosed == null) return;
    const t = setTimeout(dismiss, TOAST_MS);
    return () => clearTimeout(t);
  }, [lastClosed, dismiss]);

  if (lastClosed == null) return null;

  return (
    <div className="pointer-events-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">
            {lastClosed.target.repoFullName} #{lastClosed.target.prNumber}
          </div>
          <div className="text-[12px] text-gray-800 dark:text-gray-100">
            {closedToast(lastClosed.decidedCount)}
          </div>
          <button
            type="button"
            onClick={() => open(lastClosed.target)}
            className="mt-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:border-gray-400 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
          >
            {REOPEN}
          </button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss"
          aria-label="Dismiss"
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}
