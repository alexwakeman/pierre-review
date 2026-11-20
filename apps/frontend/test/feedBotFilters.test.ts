import { describe, expect, it } from 'vitest';
import { feedSearch } from '../src/hooks/useConsolidatedFeed.js';
import { freshFilterDefaults, pickFilterBarState, useFilters } from '../src/store/filters.js';

// ── The Feed's Bots-side chip rows: severity and bot type ─────────────────────────────────────
//
// SERVER-side (`severities` / `botRoles` on GET /api/activity/feed), so the request carries them,
// and only on the Bots side. TRANSIENT like every feed toggle: no FILTER_STORAGE_VERSION bump.
//
// ⚠ THIS SUITE DOES NOT RUN IN CI AND IS NOT TYPECHECKED. Run it by hand:
//     ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/feedBotFilters.test.ts

// Captured before any test touches the singleton store.
const DEFAULTS = {
  roles: useFilters.getState().feedBotRoles,
  severities: useFilters.getState().feedBotSeverities,
};

describe('the Bots side defaults', () => {
  it('opens on Review bots, every severity', () => {
    expect(DEFAULTS.roles).toEqual(['review']);
    expect(DEFAULTS.severities).toEqual([]);
  });

  it('is transient: not a persisted filter default', () => {
    expect('feedBotRoles' in freshFilterDefaults()).toBe(false);
    expect('feedBotSeverities' in freshFilterDefaults()).toBe(false);
    const picked = pickFilterBarState(useFilters.getState()) as Record<string, unknown>;
    expect('feedBotRoles' in picked).toBe(false);
    expect('feedBotSeverities' in picked).toBe(false);
  });

  it('turning the last chip off lands on empty (every one), never an all-off selection', () => {
    const s = useFilters.getState();
    s.toggleFeedBotRole('review');
    expect(useFilters.getState().feedBotRoles).toEqual([]);
    s.toggleFeedBotRole('dependency');
    s.toggleFeedBotRole('review');
    expect(useFilters.getState().feedBotRoles).toEqual(['dependency', 'review']);
    s.toggleFeedBotSeverity('unscored');
    expect(useFilters.getState().feedBotSeverities).toEqual(['unscored']);
    s.toggleFeedBotSeverity('unscored');
    expect(useFilters.getState().feedBotSeverities).toEqual([]);
  });
});

describe('feedSearch', () => {
  it('sends the chip rows on the Bots side only, and omits an empty row', () => {
    const bots = new URLSearchParams(feedSearch(3, null, null, 'bots', null, false, ['critical', 'unscored'], ['review']));
    expect(bots.get('severities')).toBe('critical,unscored');
    expect(bots.get('botRoles')).toBe('review');
    const empty = new URLSearchParams(feedSearch(3, null, null, 'bots', null, false, [], []));
    expect(empty.has('severities')).toBe(false);
    expect(empty.has('botRoles')).toBe(false);
    const people = new URLSearchParams(feedSearch(3, null, null, 'humans', null, false, ['critical'], ['review']));
    expect(people.has('severities')).toBe(false);
    expect(people.has('botRoles')).toBe(false);
  });
});
