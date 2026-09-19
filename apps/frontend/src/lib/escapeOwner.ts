// WHO OWNS ESCAPE INSIDE A MODAL.
//
// A modal closes on Escape from a CAPTURE-phase listener on window, so it runs before anything
// inside it and can stop the key reaching the app's global shortcuts. That order is also the
// trap: an open control inside the modal (the Settings time-zone list) wants the same Escape to
// close ITSELF, and a capture listener would close the whole modal first. So the control marks
// itself while it is open, and the modal's handler steps aside when the key came from a marked
// element. One attribute, read in one place — never a per-control flag threaded into the modal.

/** Set on an element while an open control inside a modal owns Escape (closes itself, not the modal). */
export const ESCAPE_OWNER_ATTR = 'data-owns-escape';

/** Duck-typed so it is testable without a DOM. */
export function escapeOwnedByControl(target: EventTarget | null): boolean {
  const closest = (target as { closest?: unknown } | null)?.closest;
  if (typeof closest !== 'function') return false;
  return (closest as (s: string) => unknown).call(target, `[${ESCAPE_OWNER_ATTR}]`) != null;
}
