// The persisted filter blob's v2 → v3 migration (bots hidden by default).
//
// v3 is the FIRST per-version migration rather than a wholesale discard: the only change is the
// `excludeBots` default flipping to true, so the rule is surgical — drop exactly the two bot
// keys (`excludeBots`, so a persisted `false` cannot pin the old shown-by-default world forever;
// `allowedBotIds`, whose intent was tied to excluding being an opt-in choice) and carry the rest
// of the user's remembered filter bar forward untouched. The v1 → v2 rule stays a discard: those
// blobs' `teamScope`/`repoIds` have no forward interpretation (see FILTER_STORAGE_VERSION).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { migratePersistedFilters } from '../src/hooks/useUrlState.js';

describe('migratePersistedFilters — v2 → v3', () => {
  it('drops exactly the two bot keys and preserves the rest of the blob', () => {
    const out = migratePersistedFilters({
      v: 2,
      repoIds: [4, 9],
      userIds: [12],
      excludeBots: false,
      allowedBotIds: [7],
      excludeStale: false,
      preset: '30d',
      customFrom: null,
      customTo: null,
      categories: ['commits'],
      prStatuses: ['open'],
      reviewStates: ['approved'],
      derivedStates: ['untouched'],
    });
    expect(out.v).toBe(3);
    // The two bot keys are gone — every v2 user gets the new hidden-by-default baseline once.
    expect('excludeBots' in out).toBe(false);
    expect('allowedBotIds' in out).toBe(false);
    // The remembered filter bar survives — the whole point of migrating instead of discarding.
    expect(out.repoIds).toEqual([4, 9]);
    expect(out.userIds).toEqual([12]);
    expect(out.excludeStale).toBe(false);
    expect(out.preset).toBe('30d');
    expect(out.categories).toEqual(['commits']);
    expect(out.prStatuses).toEqual(['open']);
    expect(out.reviewStates).toEqual(['approved']);
    expect(out.derivedStates).toEqual(['untouched']);
  });

  it('leaves a current v3 blob untouched — including a deliberate excludeBots: false', () => {
    // A user who CHOSE to show bots after the flip must keep that choice on every load.
    const v3 = { v: 3, excludeBots: false, allowedBotIds: [7], preset: '7d' };
    expect(migratePersistedFilters(v3)).toBe(v3);
  });

  it('does not touch pre-v2 blobs (the version check discards them, never a migration)', () => {
    const v1 = { v: 1, teamScope: 'teams:1,2', excludeBots: false };
    expect(migratePersistedFilters(v1)).toBe(v1);
  });
});
