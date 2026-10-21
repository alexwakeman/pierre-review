import { useEffect } from 'react';
import { useMyTurnDismissToast, useRestoreMyTurn } from '../../hooks/useMyTurnDismiss.js';
import { PendingBallIcon } from '../Icons.js';
import { HeaderToast, ToastLineButton } from '../HeaderToasts.js';

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
        <ToastLineButton disabled={restore.isPending} onClick={() => restore.mutate(last.target)}>
          {restore.isPending ? 'Bringing it back…' : 'Undo'}
        </ToastLineButton>
      }
      onDismiss={clear}
      dismissLabel="Dismiss the undo offer"
    />
  );
}
