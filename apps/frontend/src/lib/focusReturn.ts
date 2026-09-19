// HAND FOCUS BACK TO WHAT OPENED A MODAL. A modal that moves focus in (Settings lands on the My Turn
// heading) and drops it on <body> on the way out leaves a keyboard reader at the top of the page,
// with their place on the board gone. Capture the opener when the modal mounts, call the returned
// function when it unmounts.
//
// Duck-typed so it is testable without a DOM (the `escapeOwner.ts` precedent).

interface Focusable {
  focus?: (options?: FocusOptions) => void;
  isConnected?: boolean;
}

/**
 * `active` is `document.activeElement` at mount, `body` is `document.body`. The returned function
 * refocuses the opener — unless there was none, it was <body>, or it has left the page since (the
 * avatar menu unmounts as the modal opens), where focusing it would do nothing useful.
 */
export function focusReturner(active: unknown, body: unknown): () => void {
  const el = active as Focusable | null;
  if (el == null || el === body || typeof el.focus !== 'function') return () => {};
  return () => {
    if (el.isConnected === true) el.focus?.({ preventScroll: true });
  };
}
