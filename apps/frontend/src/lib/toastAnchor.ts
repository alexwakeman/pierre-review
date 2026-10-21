// Where an expanded header toast sits (components/HeaderToasts.tsx). Pure, so it can be tested.
//
// ⚠ IT ANCHORS AT THE CARD'S TOP-LEFT. The expanded panel's top-left corner lands exactly on the
// collapsed card's top-left and the panel grows RIGHT and DOWN only, so the line the reader clicked
// stays where it was. Only when the wider panel would run past the viewport's right gutter does it
// shift left — by just enough. (It used to grow leftwards from the slot's right edge; that rule
// existed for hover-to-expand, which is gone.)

/** The narrowest an expanded panel gets — a slot is narrower than its rows need. */
export const TOAST_PANEL_MIN_W = 320;
/** Space kept clear between an expanded panel and the viewport's edges. */
export const TOAST_GUTTER = 8;
/** The tallest an expanded panel gets; past it the panel scrolls inside itself. A notification
 *  is not a board — it never covers the whole page. */
export const TOAST_PANEL_MAX_H = 448;

export interface ToastPanelBox {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function anchorToastPanel(
  slot: { top: number; left: number; width: number },
  viewportWidth: number,
  viewportHeight: number,
): ToastPanelBox {
  const width = Math.max(
    0,
    Math.min(Math.max(slot.width, TOAST_PANEL_MIN_W), viewportWidth - TOAST_GUTTER * 2),
  );
  let left = slot.left;
  if (left + width > viewportWidth - TOAST_GUTTER) left = viewportWidth - TOAST_GUTTER - width;
  left = Math.max(TOAST_GUTTER, left);
  return {
    top: slot.top,
    left,
    width,
    maxHeight: Math.max(120, Math.min(TOAST_PANEL_MAX_H, viewportHeight - slot.top - TOAST_GUTTER)),
  };
}
