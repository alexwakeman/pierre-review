import type { EventType } from '@pierre-review/shared';
import { useFilters } from '../store/filters.js';

// A small "Show" link that recenters the timeline on a specific event marker
// (and keeps the PR selected). Shared by the Threads tab, PR comments, and the
// Activity feed so they all look and behave identically. Font size is inherited
// from the surrounding row so it blends with whatever meta line it sits in.
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
  return (
    <button
      type="button"
      onClick={() => showEventOnTimeline(prId, at, event)}
      className={`shrink-0 font-medium text-blue-500 hover:underline ${className}`}
      title={title}
    >
      Show
    </button>
  );
}
