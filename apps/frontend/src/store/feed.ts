import { create } from 'zustand';
import type { FeedEvent } from '@pierre-review/shared';

// Shared state for the watched-repo activity Feed: the merged event list (kept in sync
// by useFeedSync at App level) plus the "last viewed" instant used to mark new entries.
// Separate from the filters store so it can update on the background poll without
// re-rendering the whole filter surface.
const SEEN_KEY = 'pierre:feedSeenAt';

function readSeen(): number {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

interface FeedState {
  events: FeedEvent[];
  // Epoch ms the Feed was last viewed; entries newer than this are "new".
  seenAt: number;
  setEvents: (events: FeedEvent[]) => void;
  markSeen: () => void;
}

export const useFeedStore = create<FeedState>((set) => ({
  events: [],
  seenAt: readSeen(),
  setEvents: (events) => set({ events }),
  markSeen: () => {
    const now = Date.now();
    try {
      localStorage.setItem(SEEN_KEY, String(now));
    } catch {
      // non-fatal — the badge just won't persist across reloads
    }
    set({ seenAt: now });
  },
}));

// How many feed entries are newer than the last view (drives the Feed tab badge).
export const selectNewCount = (s: FeedState): number =>
  s.events.reduce((n, e) => (Date.parse(e.occurredAt) > s.seenAt ? n + 1 : n), 0);
