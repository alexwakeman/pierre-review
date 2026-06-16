import { get, set } from 'idb-keyval';
import type { FeedEvent } from '@pierre-review/shared';

// The append-only, browser-resident activity feed. Backed by IndexedDB (idb-keyval,
// the same lib as lib/queryPersist.ts). The backend /api/feed returns the last 14d of
// watched-repo events; we union those into this store by event id (events are
// immutable — an id never changes), keep it sorted newest-first, and PRUNE anything
// older than 14 days on every read/merge so the store can't grow unbounded.
const FEED_KEY = 'pierre:feed';
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const newestFirst = (a: FeedEvent, b: FeedEvent): number =>
  b.occurredAt.localeCompare(a.occurredAt);

function prune(events: FeedEvent[], now: number): FeedEvent[] {
  const floor = now - WINDOW_MS;
  return events.filter((e) => {
    const t = Date.parse(e.occurredAt);
    return Number.isFinite(t) && t >= floor;
  });
}

// Load the persisted feed (pruned + sorted). Best-effort: any IndexedDB error yields
// an empty feed (the next /api/feed merge repopulates it).
export async function loadFeed(): Promise<FeedEvent[]> {
  try {
    const stored = (await get<FeedEvent[]>(FEED_KEY)) ?? [];
    return prune(stored, Date.now()).sort(newestFirst);
  } catch {
    return [];
  }
}

// Merge a freshly-fetched batch into the store: union by id (existing entries are kept
// as-is — immutable), prune entries older than 14 days, persist, and return the merged
// list newest-first.
export async function mergeFeed(incoming: FeedEvent[]): Promise<FeedEvent[]> {
  let stored: FeedEvent[] = [];
  try {
    stored = (await get<FeedEvent[]>(FEED_KEY)) ?? [];
  } catch {
    stored = [];
  }
  const byId = new Map<number, FeedEvent>();
  for (const e of stored) byId.set(e.id, e);
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  const merged = prune([...byId.values()], Date.now()).sort(newestFirst);
  try {
    await set(FEED_KEY, merged);
  } catch {
    // Storage full / unavailable — keep the in-memory list; next merge retries.
  }
  return merged;
}
