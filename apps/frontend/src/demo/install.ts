// Wraps window.fetch so every same-origin `/api/*` request is answered by the demo server and never
// reaches the network. Everything else (the app's own assets, fonts, avatars) passes through.

import type { DemoServer } from './server.js';

type FetchFn = typeof fetch;

export function createDemoFetch(server: DemoServer, realFetch: FetchFn, origin: string): FetchFn {
  return async function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = typeof input === 'object' && 'url' in input && !(input instanceof URL) ? input : null;
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, origin);
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/')) {
      return realFetch(input, init);
    }
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    let bodyText: string | null = null;
    const body = init?.body;
    if (typeof body === 'string') bodyText = body;
    else if (body == null && request && method !== 'GET' && method !== 'HEAD') {
      try {
        bodyText = await request.clone().text();
      } catch {
        bodyText = null;
      }
    }
    const signal = init?.signal ?? request?.signal ?? null;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    // Yield once so callers see the same asynchronous ordering as a real request.
    await Promise.resolve();
    return server.handle(method, url.pathname + url.search, bodyText, signal);
  };
}

export function installDemoFetch(server: DemoServer): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = createDemoFetch(server, realFetch, window.location.origin);
}
