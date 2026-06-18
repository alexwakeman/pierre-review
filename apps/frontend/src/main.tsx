import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import App from './App.js';
import { queryPersister } from './lib/queryPersist.js';
import 'highlight.js/styles/github-dark.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// Ask the browser to keep our storage durable (best-effort — see OPFS/IndexedDB
// eviction caveats). The persisted detail cache is disposable: on a miss it just
// re-hydrates from the server.
void navigator.storage?.persist?.();

// Opt-in performance probe: add `?perf` to the URL to log fps / longtasks / a
// timeline DOM census (see lib/perfProbe.ts). Dynamically imported so it never
// ships in a normal session.
if (new URLSearchParams(window.location.search).has('perf')) {
  void import('./lib/perfProbe.js').then((m) => m.startPerfProbe());
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

// One week; bump `buster` to invalidate the whole persisted cache on a deploy that
// changes the detail shape.
const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

createRoot(rootEl).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        maxAge: PERSIST_MAX_AGE,
        buster: 'pierre-detail-v2',
        // Persist ONLY the on-demand detail queries (the bulky hydrated text), not
        // the lean timeline/triage feeds which should always come fresh from the API.
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => {
            const k = q.queryKey[0];
            return (
              (k === 'pr' || k === 'thread' || k === 'pr-files') &&
              q.state.status === 'success'
            );
          },
        },
      }}
    >
      <App />
    </PersistQueryClientProvider>
  </StrictMode>,
);
