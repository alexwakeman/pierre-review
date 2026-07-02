import { createContext, useContext } from 'react';
import type { EventType } from '@pierre-review/shared';
import { useFilters } from '../store/filters.js';
import { usePinnedTabs, type TabMeta } from '../store/pinnedTabs.js';
import { MagnifierIcon } from './Icons.js';

// The PR whose detail is currently open, so a per-thread / per-comment "Show" can open
// that PR's own isolated FOCUS tab (item 11). Provided by PrDetail; null elsewhere (then
// the button falls back to centring on the shared board).
export const PrFocusMetaContext = createContext<TabMeta | null>(null);

// A small magnifying-glass "Show" button next to a thread / PR comment. With a PR-focus
// meta in context (inside PrDetail) it opens that PR's isolated focus tab and highlights
// this event's marker there; without one it centres the event on the shared board. Shared
// so both look and behave identically.
export function ShowOnTimeline({
  prId,
  at,
  event,
  title = 'Show this on the timeline',
  className = '',
}: {
  prId: number;
  at: string;
  event: { type: EventType; refId: number | null };
  title?: string;
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
