import { useEffect } from 'react';
import { useMyTurnDismissToast, useRestoreMyTurn } from '../../hooks/useMyTurnDismiss.js';
import { PendingBallIcon } from '../Icons.js';
import { HeaderToast } from '../HeaderToasts.js';

// ── THE WAY BACK FROM A DISMISS ──────────────────────────────────────────────────────────────
//
// ⚠ A CARD IN THE ONE HEADER TOAST STRIP (`HeaderToasts.tsx`, mounted in `App.tsx`), never its
// own `fixed` element. Undo stays ON the one line. The My turn tab's "Dismissed" list is the other way back, for later.

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
    <HeaderToast
      testId="my-turn-dismiss-toast"
      tone="attention"
      label="Dismissed"
      icon={<PendingBallIcon size={13} />}
      summary={`${last.label} — until something new happens on it`}
      action={
        <button
          type="button"
          disabled={restore.isPending}
          onClick={() => restore.mutate(last.target)}
          className="rounded border border-gray-300 px-1.5 py-px text-[11px] text-gray-800 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-100 dark:hover:border-gray-600"
        >
          {restore.isPending ? 'Bringing it back…' : 'Undo'}
        </button>
      }
      onDismiss={clear}
      dismissLabel="Dismiss the undo offer"
    />
  );
}
