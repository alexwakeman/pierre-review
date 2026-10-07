import type { TicketRef, TrackerProvider } from '@pierre-review/shared';
import { githubAdapter } from './github/adapter.js';
import { jiraAdapter } from './jira/adapter.js';
import { linearAdapter } from './linear/adapter.js';
import type { TrackerAdapter } from './types.js';

// ONE ADAPTER PER PROVIDER (./types.ts is the seam). Jira, GitHub Issues and Linear all read
// tickets. A stored value naming a provider with no adapter reads as "no tracker".
const ADAPTERS: Partial<Record<TrackerProvider, TrackerAdapter>> = {
  jira: jiraAdapter,
  github: githubAdapter,
  linear: linearAdapter,
};

/** The adapter for a provider, or null when none is implemented. */
export function maybeAdapterFor(provider: TrackerProvider | string | null | undefined): TrackerAdapter | null {
  if (provider == null) return null;
  return ADAPTERS[provider as TrackerProvider] ?? null;
}

export function adapterFor(provider: TrackerProvider): TrackerAdapter {
  const a = maybeAdapterFor(provider);
  if (a == null) throw new Error(`no tracker adapter for ${provider}`);
  return a;
}

/** Providers that READ tickets (have a reader) — the worker's population. */
export function readingProviders(): TrackerProvider[] {
  return (Object.keys(ADAPTERS) as TrackerProvider[]).filter((p) => ADAPTERS[p]?.reader != null);
}

// The browse link for one key — the provider's own template. baseUrl is the workspace's stored base
// URL (already trimmed of a trailing slash by the store).
export function ticketUrl(provider: TrackerProvider, baseUrl: string, key: string): string {
  return adapterFor(provider).browseUrl(baseUrl, key);
}

export function buildTicketRefs(provider: TrackerProvider, baseUrl: string, keys: string[]): TicketRef[] {
  return keys.map((key) => ({ key, url: ticketUrl(provider, baseUrl, key), provider }));
}
