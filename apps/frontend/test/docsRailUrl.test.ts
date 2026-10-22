// The Docs rail line's link — `?activityRepo=docs` — round-trips through the REAL serializer.
// `writeToUrl` rebuilds the query string from a fixed whitelist, so a rail value that is emitted but
// not parsed (or the reverse) is silently useless; both halves are pinned in one trip.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend docsRailUrl
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters, type FilterState } from '../src/store/filters.js';
import { usePinnedTabs } from '../src/store/pinnedTabs.js';

const location = { pathname: '/app/', search: '' };
(globalThis as unknown as { window: unknown }).window = {
  location,
  history: {
    replaceState: (_state: unknown, _title: string, url: string): void => {
      const [path, qs] = String(url).split('?');
      location.pathname = path ?? '/app/';
      location.search = qs ? `?${qs}` : '';
    },
  },
};

const { readFromUrl, writeToUrl } = await import('../src/hooks/useUrlState.js');

const state = (over: Partial<FilterState>): FilterState => ({ ...useFilters.getState(), ...over });

describe('the Docs rail link', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    location.pathname = '/app/';
    location.search = '';
    usePinnedTabs.setState({ activeTab: 'activity' });
  });

  it('round-trips activityRepo=docs', () => {
    writeToUrl(state({ activityRepoId: 'docs' }));
    expect(location.search).toContain('activityRepo=docs');
    expect(readFromUrl().activityRepoId).toBe('docs');
  });

  it('never emits a deep link key — the quote included (one-shot)', () => {
    location.search = '?activityRepo=docs&doc=a&section=01-x.md&anchor=h&quote=some%20words';
    writeToUrl(state({ activityRepoId: 'docs' }));
    expect(location.search).toContain('activityRepo=docs');
    for (const k of ['doc=', 'section=', 'anchor=', 'quote=']) expect(location.search).not.toContain(k);
  });

  it('selecting it from another rail line is a real switch', () => {
    useFilters.setState({ activityRepoId: 'feed' });
    useFilters.getState().setActivityRepo('docs');
    expect(useFilters.getState().activityRepoId).toBe('docs');
  });
});
