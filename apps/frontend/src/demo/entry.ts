// THE DEMO ENTRY. The demo build (`vite build --mode demo`) swaps index.html's `/src/main.tsx` for
// this file, so the normal build never sees any of it. It installs the in-browser API, clears the
// persisted query cache (a reload must start from the recording again), mounts the notice bar,
// and only then loads the real app.

import { del } from 'idb-keyval';
import { isDemoRecording } from './recording.js';
import { DemoServer } from './server.js';
import { installDemoFetch } from './install.js';
import { mountDemoBanner } from './banner.js';
import './demo.css';

async function boot(): Promise<void> {
  const mod = (await import('virtual:limn-demo-recording')) as { default: unknown };
  if (!isDemoRecording(mod.default)) throw new Error('The demo recording is missing or malformed.');
  const server = new DemoServer(mod.default);
  installDemoFetch(server);
  // For anyone checking a recording from the console: `__limnDemo.log` lists every request.
  (window as unknown as { __limnDemo: DemoServer }).__limnDemo = server;
  try {
    // The app persists PR detail to IndexedDB (main.tsx). In the demo that would carry this
    // session's simulated writes across a reload.
    await del('pierre-query-cache');
  } catch {
    /* no IndexedDB: nothing was persisted either */
  }
  mountDemoBanner();
  await import('../main.js');
}

void boot();
