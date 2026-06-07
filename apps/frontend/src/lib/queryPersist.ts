import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { get, set, del } from 'idb-keyval';

// IndexedDB-backed React Query persister. The cloud app hydrates bulky PR/thread
// TEXT on demand (it isn't stored server-side, see backend sync/hydrate-detail.ts);
// persisting the detail queries here means an unchanged PR is served from the
// browser on reload / re-open and never re-downloaded. Only `pr` / `thread`
// queries are persisted (see main.tsx's shouldDehydrateQuery) — the lean timeline
// stays a normal in-memory query.
export const queryPersister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => get<string>(key).then((v) => v ?? null),
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
  key: 'pierre-query-cache',
  throttleTime: 1000,
});
