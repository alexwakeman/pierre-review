// THE ONE OPEN BOARD POPOVER — a chart's figures (ChartPopover) or a Pending "i" (PendingInfo).
//
// ⚠ ONE SLOT FOR BOTH KINDS. Opening one closes whichever was open, so two sets of explanations
// never point at two things at once.
//
// ⚠ A MODAL OPENING OVER THE PAGE CLOSES IT (`closeActivePopover` on mount: Settings, Help,
// InfoModal, the Pending guide). The popovers close on an outside PRESS, and a modal opened from
// the keyboard (Enter on "Customise", on the avatar menu) makes none — so the popover stayed drawn
// above the modal (z-[60] against z-50), covered its first controls, and its capture-phase Escape
// listener, added first, took the Escape the reader meant for the modal.
//
// Pure module state and no DOM, so `test/activePopover.test.ts` can pin it.

let active: (() => void) | null = null;

/**
 * Take the slot: close whichever popover holds it, then hold it with `close`. Returns the release,
 * for the effect cleanup — it frees the slot only if this popover still holds it.
 */
export function claimActivePopover(close: () => void): () => void {
  if (active !== close) active?.();
  active = close;
  return () => {
    if (active === close) active = null;
  };
}

/** Close whichever popover is open. A modal calls it once, on mount. */
export function closeActivePopover(): void {
  active?.();
}
