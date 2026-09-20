import { useEffect } from 'react';

// ── WHO OWNS `Escape` INSIDE THE RESOLVER ────────────────────────────────────────────────────
//
// ⚠ REGISTRATION ORDER IS NOT A MECHANISM, AND THREE POPOVERS WERE BETTING ON IT. Same-target,
// same-phase listeners fire in the order they were ADDED, and the overlay shell's Escape handler
// is added on MOUNT — long before any popover opens — so its `stopImmediatePropagation()` ran
// first and no later `window` capture listener ever saw the key. Pressing Escape on the file
// menu, the compare-base popup or the "what is left to decide" list therefore closed the WHOLE
// RESOLVER (or raised the "close and lose these decisions?" bar over a still-open popover), and
// the header comments on two of those files asserted the opposite in so many words.
// `stopImmediatePropagation` at the window capture stage also kills floating-ui's own
// `useDismiss` escape listener, which is on `document` and never reached.
//
// So the shell ASKS instead of racing: one module-level count of open resolver popovers, which
// the shell's handler checks before it does anything. The innermost thing open gets the key,
// which is what Escape means everywhere else in the app.
//
// ⚠ THE COUNT AND THE LISTENER ARE THE SAME EFFECT. Split them and a popover could be counted
// without having a handler to run — the key would then reach nothing at all, which is worse than
// the bug it replaces.

let openLayers = 0;

/** Is anything inside the resolver open on top of the panes? Read by the shell's Escape handler
 *  and by nothing else. */
export function resolverPopoverOpen(): boolean {
  return openLayers > 0;
}

/**
 * Give this popover the Escape key while it is open, and tell the shell it exists.
 *
 * ⚠ IT STILL CALLS `stopImmediatePropagation`. The app's global `useKeyboard` treats Escape as
 * "leave the current tab → the board"; the shell's handler is what normally stops that, and the
 * shell stands aside for this one, so this handler has to stop it instead.
 */
export function useResolverPopoverEscape(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    openLayers += 1;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      openLayers -= 1;
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);
}
