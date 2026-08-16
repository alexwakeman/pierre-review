// The Feed's CI-failure LENS — three states cycling off → feed → only → off, and the one feed
// control that persists with the filter bar.
//
// Every other feed*/bot* toggle is transient and URL-silent by deliberate design. This one is a
// standing preference ("show me broken builds"), so it joins FilterDefaults — which is a list
// FOUR separate mechanisms read (persist, restore, reset, and the URL serializer). Each fails
// silently, so each is pinned here:
//
//   • IT SURVIVES A RELOAD. This is the assertion that matters, and the one a round-trip test
//     cannot make. `pickFilterBarState` → `sanitizePersistedFilters` round-trips perfectly while
//     the lens is still forgotten on every reload, because the persisted blob is read ONLY on a
//     BARE url and `writeToUrl` emits `?workspace=<id>` (plus `view=activity`) as soon as the
//     scope resolves — i.e. within a second of every load. The restoration path that actually
//     runs is therefore writeToUrl → readFromUrl, and that is what is asserted below, against the
//     real serializer rather than a re-implementation of it.
//   • IT IS PERSISTED. `pickFilterBarState` must still emit it — the bare-url path (a fresh tab
//     opened straight at /app) is the one the URL cannot serve.
//   • A RETURNING USER'S EXISTING BLOB STILL LOADS, including one holding the LEGACY boolean
//     `feedShowCiFailures`, which is dropped by whitelist.
//   • THE DEFAULT IS 'off' — no CI rows are fetched on a fresh load — and "Clear filters"
//     returns to it. ⚠ This default has FLIPPED TWICE (off → feed → off), and the second flip
//     needed a FILTER_STORAGE_VERSION bump (v3 → v4) that the first did not: `feedCiLens` is
//     persisted UNCONDITIONALLY, so by then every stored blob held a literal 'feed' written by
//     the old default rather than by a user. `filterStorageMigration.test.ts` pins that step.
//
// WHY THREE STATES (the bug this replaced): an include-only toggle is invisible in a busy
// workspace. CI rows are placed chronologically, so with ~23 non-CI events since the newest CI
// failure the first red card lands 23 rows down while the pill's count reads 34 — identical in
// appearance to a dead control. The same code puts it at index 0 in a quiet workspace, which is
// why it looked fine under one scope and broken under another.
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

describe('feedCiLens', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    location.pathname = '/app/';
    location.search = '';
  });

  it("defaults to 'off' — no CI rows are fetched on a fresh load", () => {
    expect(useFilters.getState().feedCiLens).toBe('off');
  });

  // ONE CLICK FROM REST TURNS IT ON. The cycle is unchanged as a cycle — what moved is where it
  // STARTS — so the first click from the default must reach 'feed', not skip straight to 'only'.
  it('cycles off → feed → only → off', () => {
    const cycle = (): string => {
      useFilters.getState().cycleFeedCiLens();
      return useFilters.getState().feedCiLens;
    };
    expect(cycle()).toBe('feed');
    expect(cycle()).toBe('only');
    expect(cycle()).toBe('off');
  });

  it('is PERSISTED with the filter bar', () => {
    expect(pickFilterBarState(state({ feedCiLens: 'only' })).feedCiLens).toBe('only');
    expect(pickFilterBarState(state({ feedCiLens: 'off' })).feedCiLens).toBe('off');
  });

  it('round-trips through the persisted blob', () => {
    const blob = pickFilterBarState(state({ feedCiLens: 'only' }));
    expect(sanitizePersistedFilters(blob).feedCiLens).toBe('only');
  });

  // THE ADDITIVE-KEY GUARANTEE: an older blob (written before this key existed) restores its
  // real filters untouched and simply carries no opinion about CI failures, so the store's
  // default stands. No version bump, no blob discard.
  it('an older blob without the key restores cleanly and asserts nothing about it', () => {
    const out = sanitizePersistedFilters({
      repoIds: [4, 9],
      preset: '30d',
    } as unknown as Partial<FilterState>);
    expect(out).toEqual({ repoIds: [4, 9], preset: '30d' });
    expect('feedCiLens' in out).toBe(false);
  });

  // The LEGACY boolean is dropped rather than migrated, and that is deliberate: its default was
  // `false`, which is what nearly every stored blob holds, so mapping it onto 'off' would
  // preserve the exact invisibility this change exists to fix — for precisely the users who
  // never found the pill.
  it('drops the legacy feedShowCiFailures boolean instead of migrating it', () => {
    const out = sanitizePersistedFilters({
      repoIds: [7],
      feedShowCiFailures: false,
    } as unknown as Partial<FilterState>);
    expect(out).toEqual({ repoIds: [7] });
    expect('feedCiLens' in out).toBe(false);
  });

  // The blob is untrusted (localStorage, hand-editable): a value outside the union must not be
  // seated into a typed field.
  it('rejects a value outside the union', () => {
    const out = sanitizePersistedFilters({
      feedCiLens: 'bogus',
    } as unknown as Partial<FilterState>);
    expect('feedCiLens' in out).toBe(false);
  });

  // It IS in FilterDefaults, so "Clear filters" returns it to the default — the correct reading
  // for a filter-shaped control.
  it('is returned to the default by resetAllFilters', () => {
    useFilters.getState().cycleFeedCiLens();
    expect(useFilters.getState().feedCiLens).toBe('feed');
    useFilters.getState().resetAllFilters();
    expect(useFilters.getState().feedCiLens).toBe('off');
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
// every change, so this is exactly the URL a user's address bar holds a moment after they change
// the lens; readFromUrl is exactly what a reload of that URL hydrates from.
describe('feedCiLens survives a reload (writeToUrl → readFromUrl)', () => {
  beforeEach(() => {
    useFilters.getState().resetAllFilters();
    location.pathname = '/app/';
    location.search = '';
  });

  // ⚠ THE OMITTED VALUE MUST TRACK THE DEFAULT. When the default flipped to 'off', leaving 'off'
  // as the encoded value and 'feed' as the omitted one would have written the default onto every
  // URL while the state that now NEEDS serializing silently vanished — restoring 'feed' never.
  it('encodes only the non-default lenses, and omits the CURRENT default', () => {
    writeToUrl(state({ workspaceId: 5, feedCiLens: 'only' }));
    expect(location.search).toContain('ci=only');
    writeToUrl(state({ workspaceId: 5, feedCiLens: 'feed' }));
    expect(location.search).toContain('ci=1');
    writeToUrl(state({ workspaceId: 5, feedCiLens: 'off' }));
    expect(location.search).not.toContain('ci=');
  });

  // The round trip that the flip could have broken: 'feed' is now the state a reload must carry.
  it('restores the in-feed lens across a reload', () => {
    writeToUrl(state({ workspaceId: 5, feedCiLens: 'feed' }));
    expect(readFromUrl().feedCiLens).toBe('feed');
  });

  // THE REGRESSION. A non-bare URL is the normal case, not the exception — `?workspace=<id>` is
  // emitted always-once-resolved and `view=activity` rides the landing tab — so localStorage is
  // never consulted on a reload and a URL-silent lens is restored precisely never.
  it('restores through a URL that already carries the workspace (the non-bare reload)', () => {
    writeToUrl(state({ workspaceId: 5, feedCiLens: 'only' }));
    // Not a contrived URL: the scope param is what makes the address bar non-bare.
    expect(location.search).toContain('workspace=5');
    const restored = readFromUrl();
    expect(restored.feedCiLens).toBe('only');
    expect(restored.workspaceId).toBe(5);
  });

  it('a URL with no ci param leaves the store default alone', () => {
    location.search = '?workspace=5';
    // Absent ⇒ no opinion: the key is not in the hydrate patch at all, so the default stands
    // rather than being re-asserted over a value some other path set.
    expect('feedCiLens' in readFromUrl()).toBe(false);
  });

  it('reads back each explicit value', () => {
    location.search = '?workspace=5&ci=0';
    expect(readFromUrl().feedCiLens).toBe('off');
    location.search = '?workspace=5&ci=only';
    expect(readFromUrl().feedCiLens).toBe('only');
  });

  // `ci=1` meant "show them" when this was a boolean and still does — which is why it is also
  // what the serializer now emits for 'feed'. Links from BOTH older shapes keep working.
  it('reads a legacy ci=1 link as the in-feed lens', () => {
    location.search = '?workspace=5&ci=1';
    expect(readFromUrl().feedCiLens).toBe('feed');
  });

  // A SHARED LINK MEANS WHAT IT SAYS. The URL is the shareable source of truth: a link that does
  // not name the lens must not pick it up from the recipient's own localStorage — which is
  // structurally guaranteed here, since the hydrate patch simply omits the key.
  it('a shared link without ci= does not inherit the sharer’s lens', () => {
    writeToUrl(state({ workspaceId: 5, feedCiLens: 'off' }));
    expect(readFromUrl().feedCiLens).toBeUndefined();
  });
});
