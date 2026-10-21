import { useEffect } from 'react';
import { useConflictResolverStore } from '../../store/conflictResolver.js';
import { ConflictIcon } from '../Icons.js';
import { HeaderToast, ToastLineButton } from '../HeaderToasts.js';
import { REOPEN, closedToast } from './copy.js';

// ── THE WAY BACK ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ A CARD IN THE ONE HEADER TOAST STRIP (`HeaderToasts.tsx`, mounted in `App.tsx`), never its
// own `fixed` element. Reopen stays ON the card's one line — the only way back must not hide
// behind a hover.
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

  const where = `${lastClosed.target.repoFullName} #${lastClosed.target.prNumber}`;
  return (
    <HeaderToast
      testId="closed-resolver-toast"
      tone="conflicts"
      label={where}
      icon={<ConflictIcon size={13} />}
      summary={closedToast(lastClosed.decidedCount)}
      action={
        <ToastLineButton onClick={() => open(lastClosed.target)}>{REOPEN}</ToastLineButton>
      }
      onDismiss={dismiss}
      dismissLabel={`Dismiss the reopen offer for ${where}`}
    />
  );
}
