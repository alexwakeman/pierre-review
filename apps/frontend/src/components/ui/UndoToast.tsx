import { UndoIcon } from '../Icons.js';
import { HeaderToast, ToastLineButton } from '../HeaderToasts.js';
import { finalizeUndoOffer, undoLast, useUndoStore } from './undo.js';

// THE UNDO CARD for an optimistic removal (components/ui/undo.ts). ⚠ A card in the ONE header toast
// strip (HeaderToasts.tsx, mounted in App.tsx) — never its own fixed element. Undo stays ON the
// line; the × settles the action now (a deferred write fires).

export function UndoToast(): JSX.Element | null {
  const offer = useUndoStore((s) => s.offer);
  if (offer == null) return null;
  return (
    <HeaderToast
      key={offer.id}
      testId="undo-toast"
      // Wider than the other cards below sm: its summary names WHAT is being undone ("#116 —…"),
      // and a 112px slot left one letter of it beside Undo and the X.
      className="max-sm:w-48"
      tone={offer.tone}
      label={offer.label}
      icon={<UndoIcon size={13} />}
      summary={offer.summary}
      action={
        <ToastLineButton disabled={offer.pending} onClick={undoLast}>
          Undo
        </ToastLineButton>
      }
      onDismiss={finalizeUndoOffer}
      dismissLabel="Dismiss the undo offer"
    />
  );
}
