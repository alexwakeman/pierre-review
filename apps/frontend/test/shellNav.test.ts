// THE SHELL'S NAVIGATION (components/shell/nav.ts): the sidebar, the phone's bottom bar, the `g` keys
// and ⌘K all go through `goTo`, and the sidebar's highlight is `currentLocation`. These pin that a
// shell click lands on EXACTLY the store state the old tab row / Activity rail produced — so every
// URL the app emitted before the redesign still means the same view (`?activityRepo=attention` is
// Pending, `'insights'` is Reports) — and that the `g` chord is a two-key sequence with a timeout.
//
// Run: ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { beforeEach, describe, expect, it } from 'vitest';
import { useFilters } from '../src/store/filters.js';
import { usePinnedTabs } from '../src/store/pinnedTabs.js';
import { useShell } from '../src/store/shell.js';
import {
  currentLocation,
  DESTINATIONS,
  GO_CHORD_MS,
  GO_KEYS,
  goTo,
  resolveGoChord,
} from '../src/components/shell/nav.js';

beforeEach(() => {
  usePinnedTabs.setState({ activeTab: 'timeline', tabs: [] });
  useFilters.setState({ activityRepoId: 'open-prs' });
  useShell.setState({ drawerOpen: false });
});

describe('the destinations', () => {
  it('keeps the store values the URL carries: Pending is attention, Reports is insights', () => {
    const byLabel = Object.fromEntries(DESTINATIONS.map((d) => [d.label, d.id]));
    expect(byLabel['Pending']).toBe('attention');
    expect(byLabel['Reports']).toBe('insights');
    expect(byLabel['Bots Monitoring']).toBe('bots');
  });

  it('puts the four primaries first, in the order of the bottom bar', () => {
    expect(DESTINATIONS.filter((d) => d.group === 'primary').map((d) => d.id)).toEqual([
      'attention',
      'open-prs',
      'sprint',
      'timeline',
    ]);
  });

  it('gives every destination its own g-key', () => {
    const keys = DESTINATIONS.map((d) => d.goKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(GO_KEYS).toMatchObject({ p: 'attention', o: 'open-prs', s: 'sprint', t: 'timeline', r: 'insights', b: 'bots', d: 'docs' });
  });

  it('only marks Docs as AI-only', () => {
    expect(DESTINATIONS.filter((d) => d.aiOnly).map((d) => d.id)).toEqual(['docs']);
  });
});

describe('goTo', () => {
  it('an Activity destination sets the rail value, then shows Activity', () => {
    goTo('attention');
    expect(useFilters.getState().activityRepoId).toBe('attention');
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
  });

  it('a repo opens its console', () => {
    goTo(42);
    expect(useFilters.getState().activityRepoId).toBe(42);
    expect(usePinnedTabs.getState().activeTab).toBe('activity');
  });

  it('This Sprint and the Timeline are the fixed views, and leave the rail value alone', () => {
    useFilters.setState({ activityRepoId: 'feed' });
    goTo('sprint');
    expect(usePinnedTabs.getState().activeTab).toBe('sprint');
    goTo('timeline');
    expect(usePinnedTabs.getState().activeTab).toBe('timeline');
    expect(useFilters.getState().activityRepoId).toBe('feed');
  });

  it('closes the phone drawer', () => {
    useShell.setState({ drawerOpen: true });
    goTo('feed');
    expect(useShell.getState().drawerOpen).toBe(false);
  });
});

describe('currentLocation', () => {
  it('reads Activity through its rail value, defaulting to Open PRs', () => {
    expect(currentLocation('activity', [], 'attention')).toBe('attention');
    expect(currentLocation('activity', [], null)).toBe('open-prs');
    expect(currentLocation('activity', [], 7)).toBe(7);
  });

  it('names the fixed views', () => {
    expect(currentLocation('timeline', [], 'attention')).toBe('timeline');
    expect(currentLocation('sprint', [], 'attention')).toBe('sprint');
  });

  it('is nowhere in the sidebar on a live dynamic tab, and the board on a stale one', () => {
    expect(currentLocation('pr-detail:5', [{ key: 'pr-detail:5' }], 'attention')).toBeNull();
    expect(currentLocation('pr-detail:5', [], 'attention')).toBe('timeline');
  });
});

describe('resolveGoChord', () => {
  it('g arms, and a known letter within the window goes', () => {
    const a = resolveGoChord(null, 'g', 1000);
    expect(a).toEqual({ go: null, armedAt: 1000, handled: true });
    expect(resolveGoChord(a.armedAt, 'p', 1500)).toEqual({ go: 'attention', armedAt: null, handled: true });
  });

  it('an unknown second key ends the chord and is not swallowed', () => {
    expect(resolveGoChord(1000, 'x', 1100)).toEqual({ go: null, armedAt: null, handled: false });
  });

  it('a late letter is just a letter', () => {
    expect(resolveGoChord(1000, 'p', 1000 + GO_CHORD_MS + 1)).toEqual({ go: null, armedAt: null, handled: false });
  });

  it('a lone letter does nothing', () => {
    expect(resolveGoChord(null, 'p', 1000)).toEqual({ go: null, armedAt: null, handled: false });
  });
});
