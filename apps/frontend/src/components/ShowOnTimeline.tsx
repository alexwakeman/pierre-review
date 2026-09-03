import { createContext, useContext } from 'react';
import type { EventType } from '@pierre-review/shared';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../store/pinnedTabs.js';
import { MagnifierIcon } from './Icons.js';

// The PR whose detail is currently open, so a per-thread / per-comment "Show" can open
// that PR's own isolated FOCUS tab (item 11). Provided by PrDetail; null elsewhere (then
// the button falls back to centring on the shared board).
export const PrFocusMetaContext = createContext<TabMeta | null>(null);

// A "show this moment on a timeline" control next to a thread / PR comment / activity
// entry. With a PR-focus meta in context (inside PrDetail) it opens that PR's ISOLATED
// focus tab and highlights this event's marker there; without one it centres the event
// on the shared board. Shared so every such control behaves identically.
//
// Two renderings, ONE behaviour: the default is a compact magnifying-glass icon button
// (dense headers — thread cards, comment rows); passing `label` renders a text link
// instead, for rows that already read as a list of actions ("Timeline view" ·
// "Open on GitHub"). The label is the ONLY difference — do not fork the onClick.
export function ShowOnTimeline({
  prId,
  at,
  event,
  title = 'Show this on the timeline',
  label,
  className = '',
}: {
  prId: number;
  at: string;
  event: { type: EventType; refId: number | null };
  title?: string;
  // Render as a text link with this wording instead of the magnifier icon.
  label?: string;
  className?: string;
}): JSX.Element {
  const showEventOnTimeline = useFilters((s) => s.showEventOnTimeline);
  const focusEventInTab = useFilters((s) => s.focusEventInTab);
  const openPrFocusTab = usePinnedTabs((s) => s.openPrFocusTab);
  const focusMeta = useContext(PrFocusMetaContext);

  const onClick = (): void => {
    if (focusMeta != null && focusMeta.id === prId) {
      // Item 11: open the PR's own isolated focus tab, then drive its boot to centre +
      // glow this event's marker. A review_comment's refId IS its thread id → pre-select
      // the thread so the focus tab's detail pane opens on it.
      const threadId = event.type === 'review_comment' ? event.refId : null;
      openPrFocusTab(focusMeta);
      focusEventInTab(prId, at, event, threadId);
    } else {
      showEventOnTimeline(prId, at, event);
    }
  };

  if (label != null) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`shrink-0 text-blue-500 hover:underline ${className}`}
        title={title}
      >
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded p-0.5 text-blue-500 hover:text-blue-600 ${className}`}
      title={title}
      aria-label={title}
    >
      <MagnifierIcon size={13} />
    </button>
  );
}
