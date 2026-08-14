// The "Show CI failures" feed toggle — the ONE feed toggle that persists with the filter bar.
//
// Every other feed*/bot* toggle is transient and URL-silent by deliberate design. This one is a
// standing preference ("show me broken builds"), so it joins FilterDefaults — which is a list
// FOUR separate mechanisms read (persist, restore, reset, and the URL serializer). Each fails
// silently, so each is pinned here:
//
//   • IT SURVIVES A RELOAD. This is the assertion that matters, and the one a round-trip test
//     cannot make. `pickFilterBarState` → `sanitizePersistedFilters` round-trips perfectly while
//     the toggle is still forgotten on every reload, because the persisted blob is read ONLY on a
//     BARE url and `writeToUrl` emits `?workspace=<id>` (plus `view=activity`) as soon as the
//     scope resolves — i.e. within a second of every load. The restoration path that actually
//     runs is therefore writeToUrl → readFromUrl, and that is what is asserted below, against the
//     real serializer rather than a re-implementation of it.
//   • IT IS PERSISTED. `pickFilterBarState` must still emit it — the bare-url path (a fresh tab
//     opened straight at /app) is the one the URL cannot serve.
//   • A RETURNING USER'S EXISTING BLOB STILL LOADS. The key is ADDITIVE, so NO
//     FILTER_STORAGE_VERSION bump was needed — an older v3 blob simply lacks it and
//     `sanitizePersistedFilters` skips it by whitelist. A bump WITHOUT a matching
//     `migratePersistedFilters` entry would DISCARD the user's whole remembered filter bar
//     (repos, range, statuses) just to introduce one boolean; this test is what pins that the
//     cheap path really does work.
//   • IT IS OFF BY DEFAULT, and stays off after "Clear filters".
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import {
  pickFilterBarState,
  sanitizePersistedFilters,
  useFilters,
  type FilterState,
} from '../src/store/filters.js';

// A minimal `window` for the serializer: it reads location.pathname/search and writes through
// history.replaceState. Installed before the module under test is imported (the import is
// dynamic for exactly that reason — useUrlState touches `window` only inside these two
// functions, but pinning the order costs nothing and documents the dependency).
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

/** A FilterState snapshot with the fields under test overridden — never the live store. */
function state(over: Partial<FilterState>): FilterState {
  return { ...useFilters.getState(), ...over };
}

describe('feedShowCiFailures', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    location.pathname = '/app/';
    location.search = '';
  });

  it('is OFF on a fresh store', () => {
    expect(useFilters.getState().feedShowCiFailures).toBe(false);
  });

  it('toggles', () => {
    useFilters.getState().toggleFeedShowCiFailures();
    expect(useFilters.getState().feedShowCiFailures).toBe(true);
    useFilters.getState().toggleFeedShowCiFailures();
    expect(useFilters.getState().feedShowCiFailures).toBe(false);
  });

  it('is PERSISTED with the filter bar', () => {
    expect(pickFilterBarState(state({ feedShowCiFailures: true })).feedShowCiFailures).toBe(true);
    expect(pickFilterBarState(state({ feedShowCiFailures: false })).feedShowCiFailures).toBe(
      false,
    );
  });

  it('round-trips through the persisted blob', () => {
    const blob = pickFilterBarState(state({ feedShowCiFailures: true }));
    expect(sanitizePersistedFilters(blob).feedShowCiFailures).toBe(true);
  });

  // THE ADDITIVE-KEY GUARANTEE: an older blob (written before this key existed) restores its
  // real filters untouched and simply carries no opinion about CI failures, so the store's
  // `false` default stands. No version bump, no blob discard.
  it('an older blob without the key restores cleanly and asserts nothing about it', () => {
    const out = sanitizePersistedFilters({
      repoIds: [4, 9],
      preset: '30d',
    } as unknown as Partial<FilterState>);
    expect(out).toEqual({ repoIds: [4, 9], preset: '30d' });
    expect('feedShowCiFailures' in out).toBe(false);
  });

  // It IS in FilterDefaults, so "Clear filters" clears it — the correct reading for a
  // filter-shaped toggle, and the reason it is documented as such rather than left implicit.
  it('is cleared by resetAllFilters', () => {
    useFilters.getState().toggleFeedShowCiFailures();
    expect(useFilters.getState().feedShowCiFailures).toBe(true);
    useFilters.getState().resetAllFilters();
    expect(useFilters.getState().feedShowCiFailures).toBe(false);
  });

  // The other feed toggles must NOT have been dragged along: they stay transient, so "Clear
  // filters" leaves them alone and they never round-trip through the blob.
  it('does not drag the transient feed toggles into the persisted slice', () => {
    const picked = pickFilterBarState(state({}));
    expect('feedShowCommits' in picked).toBe(false);
    expect('feedBotLens' in picked).toBe(false);
    expect('feedMyTurnOnly' in picked).toBe(false);
  });
});

// ⚠ THE RELOAD PATH, against the real serializer. The store's own subscription runs writeToUrl on
// every change, so this is exactly the URL a user's address bar holds a moment after they flip
// the toggle; readFromUrl is exactly what a reload of that URL hydrates from.
describe('feedShowCiFailures survives a reload (writeToUrl → readFromUrl)', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    location.pathname = '/app/';
    location.search = '';
  });

  it('emits ci=1 when on, and nothing when off (the default stays out of the URL)', () => {
    writeToUrl(state({ workspaceId: 5, feedShowCiFailures: true }));
    expect(location.search).toContain('ci=1');
    writeToUrl(state({ workspaceId: 5, feedShowCiFailures: false }));
    expect(location.search).not.toContain('ci=');
  });

  // THE REGRESSION. A non-bare URL is the normal case, not the exception — `?workspace=<id>` is
  // emitted always-once-resolved and `view=activity` rides the landing tab — so localStorage is
  // never consulted on a reload and a URL-silent toggle is restored precisely never.
  it('restores through a URL that already carries the workspace (the non-bare reload)', () => {
    writeToUrl(state({ workspaceId: 5, feedShowCiFailures: true }));
    // Not a contrived URL: the scope param is what makes the address bar non-bare.
    expect(location.search).toContain('workspace=5');
    const restored = readFromUrl();
    expect(restored.feedShowCiFailures).toBe(true);
    expect(restored.workspaceId).toBe(5);
  });

  it('a URL with no ci param leaves the store default alone', () => {
    location.search = '?workspace=5';
    // Absent ⇒ no opinion: the key is not in the hydrate patch at all, so `false` stands rather
    // than being re-asserted over a value some other path set.
    expect('feedShowCiFailures' in readFromUrl()).toBe(false);
  });

  it('honours an explicit ci=0 (symmetry with bots=/stale=)', () => {
    location.search = '?workspace=5&ci=0';
    expect(readFromUrl().feedShowCiFailures).toBe(false);
    location.search = '?workspace=5&ci=1';
    expect(readFromUrl().feedShowCiFailures).toBe(true);
  });

  // A SHARED LINK MEANS WHAT IT SAYS. The URL is the shareable source of truth: a link that does
  // not name the toggle must not pick it up from the recipient's own localStorage — which is
  // structurally guaranteed here, since the hydrate patch simply omits the key.
  it('a shared link without ci= does not inherit the sharer’s toggle', () => {
    writeToUrl(state({ workspaceId: 5, feedShowCiFailures: false }));
    expect(readFromUrl().feedShowCiFailures).toBeUndefined();
  });
});
