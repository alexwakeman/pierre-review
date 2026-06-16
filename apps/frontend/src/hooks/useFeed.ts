import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { loadFeed, mergeFeed } from '../lib/feedStore.js';
import { useFeedStore } from '../store/feed.js';

// Background activity-feed sync. Loads the persisted IndexedDB feed on mount (instant,
// before the first network round-trip), then polls /api/feed and merges each batch into
// the append-only store (dedupe by id, prune >14d). Mounted ONCE at App level so the
// feed accumulates regardless of which tab/PR is open; the freshness ceiling is the
// backend's 5-minute sync, so a 60s poll is plenty. Components read the result via
// useFeedStore.
export function useFeedSync(): void {
  const setEvents = useFeedStore((s) => s.setEvents);

  useEffect(() => {
    void loadFeed().then(setEvents);
  }, [setEvents]);

  const { data } = useQuery({
    queryKey: ['feed'],
    queryFn: api.feed,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!data) return;
    void mergeFeed(data.events).then(setEvents);
  }, [data, setEvents]);
}
