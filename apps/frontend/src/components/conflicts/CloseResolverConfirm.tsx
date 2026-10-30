import { useEffect, useRef } from 'react';
import { CLOSE_ANYWAY, KEEP_WORKING, closeConfirmQuestion } from './copy.js';

// ── "CLOSE AND LOSE THESE?" ──────────────────────────────────────────────────────────────────
//
// ⚠ A BAR, NOT A NESTED DIALOG. The overlay is already `role="dialog" aria-modal="true"`; a second
// modal inside it means two focus traps, and the reader's own Escape — the gesture that opened
// this question — would then need a third rule to say which one it closes.
//
// ⚠ THE SAFE BUTTON TAKES FOCUS, AND A SECOND ESCAPE PICKS IT. Escape is what got the reader here,
// so pressing it again must be the harmless answer; the overlay shell owns that binding and routes
// it to `onKeep` while this is up.
//
// ⚠ IT IS ONLY EVER RAISED BY ESCAPE. The header's Close button closes outright — a deliberate
// press on a control labelled "Close" is not an accident, and the reopen toast is the way back
// from it. The confirm exists for the keystroke that means "get me out of whatever I am in".

export function CloseResolverConfirm({
  decided,
  total,
  onKeep,
  onClose,
}: {
  decided: number;
  total: number;
  onKeep: () => void;
  onClose: () => void;
}): JSX.Element {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  return (
    <div
      role="alertdialog"
      aria-label="Close the conflict resolver?"
      className="flex shrink-0 flex-wrap items-center gap-3 border-t border-ui-line px-4 py-2"
    >
      <span className="text-meta text-ui-ink">
        {closeConfirmQuestion(decided, total)}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          ref={keepRef}
          type="button"
          onClick={onKeep}
          className="rounded-ui bg-ui-raise px-2.5 py-1 text-meta font-medium text-ui-ink hover:bg-ui-hover touch:min-h-10"
        >
          {KEEP_WORKING}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-ui bg-ui-raise px-2.5 py-1 text-meta text-ui-mute hover:bg-ui-hover touch:min-h-10"
        >
          {CLOSE_ANYWAY}
        </button>
      </div>
    </div>
  );
}
