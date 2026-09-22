import { useEffect } from 'react';
import { useMyTurnDismissToast, useRestoreMyTurn } from '../../hooks/useMyTurnDismiss.js';
import { CloseIcon } from '../Icons.js';

// ── THE WAY BACK FROM A DISMISS ──────────────────────────────────────────────────────────────
//
// ⚠ A PLAIN CARD FOR THE ONE BOTTOM-RIGHT TOAST COLUMN IN `App.tsx`, never its own
// `fixed bottom-4 right-4` element (the column owns the position and `pointer-events-none`; each
// card re-enables its own). The My turn tab's "Dismissed" list is the other way back, for later.

/** Long enough to notice and reach; short enough not to become a second banner. */
const TOAST_MS = 10_000;

export function MyTurnDismissToast(): JSX.Element | null {
  const last = useMyTurnDismissToast((s) => s.last);
  const clear = useMyTurnDismissToast((s) => s.clear);
  const restore = useRestoreMyTurn();

  useEffect(() => {
    if (last == null) return;
    const t = setTimeout(clear, TOAST_MS);
    return () => clearTimeout(t);
  }, [last, clear]);

  if (last == null) return null;

  return (
    <div
      role="status"
      className="pointer-events-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">{last.label}</div>
          <div className="text-[12px] text-gray-800 dark:text-gray-100">
            Dismissed until something new happens on it.
          </div>
          <button
            type="button"
            disabled={restore.isPending}
            onClick={() => restore.mutate(last.target)}
            className="mt-1 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-800 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
          >
            {restore.isPending ? 'Bringing it back…' : 'Undo'}
          </button>
        </div>
        <button
          type="button"
          onClick={clear}
          title="Close"
          aria-label="Close"
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}
