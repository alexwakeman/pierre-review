// The agent's live log (components/AgentActivityLog.tsx): the pure parts.
//
// The server sends only a ROLLING WINDOW of the run's log (its last 25 lines, ACTIVITY_LOG_CAP in each
// agent), never the whole run. The panel keeps every line it has seen since it mounted by merging each
// new window onto what it holds, so the expanded log shows more than the window.

/** The most lines the panel keeps (a long run; the oldest go first). */
export const ACTIVITY_KEEP_MAX = 2000;

/**
 * Merges the server's latest window onto the lines already held. The window overlaps the held tail
 * (it slid forward by the lines added since the last poll): the LONGEST overlap is taken, and only the
 * lines after it are appended. A window with no overlap (more than a window's worth of lines arrived
 * between two polls) is appended whole. Idempotent: merging the same window twice adds nothing.
 * Returns `held` itself when nothing changed.
 */
export function mergeActivityWindow(held: readonly string[], window: readonly string[], max = ACTIVITY_KEEP_MAX): readonly string[] {
  if (window.length === 0) return held;
  if (held.length === 0) return window.length > max ? window.slice(-max) : window;
  let overlap = 0;
  for (let k = Math.min(held.length, window.length); k > 0; k--) {
    let match = true;
    const start = held.length - k;
    for (let i = 0; i < k; i++) {
      if (held[start + i] !== window[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      overlap = k;
      break;
    }
  }
  if (overlap === window.length) return held;
  const next = [...held, ...window.slice(overlap)];
  return next.length > max ? next.slice(-max) : next;
}

/** How close to the bottom (px) still counts as "at the bottom" (sub-pixel scroll, zoom). */
export const FOLLOW_SLACK_PX = 8;

/** True when a scroller shows its last line: the log follows new lines only then. */
export function isScrolledToBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = FOLLOW_SLACK_PX): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

/**
 * The expanded log's height: the room from its top to the bottom of the scroll pane it sits in (so it
 * fits on screen as it opens), but at least 60% of the pane (opened low down, the pane scrolls) and
 * never past the pane's own height less a margin, nor below `min`. Null without a pane.
 */
export function expandedLogHeight(paneHeight: number | null, spaceBelow: number | null, min = 240, margin = 24): number | null {
  if (paneHeight == null || paneHeight <= 0) return null;
  const room = spaceBelow != null ? spaceBelow - margin : 0;
  const tallest = paneHeight - 4 * margin;
  return Math.max(min, Math.floor(Math.min(tallest, Math.max(paneHeight * 0.6, room))));
}
