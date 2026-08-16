// The persisted filter blob's per-version migrations.
//
// Both existing steps exist for the SAME reason — a DEFAULT FLIPPED on a key that is persisted
// unconditionally, so the stored value is overwhelmingly the old default rather than a choice —
// and both are surgical rather than a wholesale discard, because throwing away a user's whole
// remembered filter bar (repos, range, statuses) to re-assert one default would be theft:
//
//   v2 → v3  bots hidden by default: drop `excludeBots` (a persisted `false` must not pin the old
//            shown-by-default world forever) and `allowedBotIds` (an allow-list picked when
//            excluding was an opt-in choice doesn't carry that intent into an ambient world).
//   v3 → v4  CI failures out of the feed by default: drop `feedCiLens`.
//
// The v1 → v2 rule stays a discard: those blobs' `teamScope`/`repoIds` have no forward
// interpretation (see FILTER_STORAGE_VERSION).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { migratePersistedFilters } from '../src/hooks/useUrlState.js';

describe('migratePersistedFilters', () => {
  // ⚠ THE STEPS CHAIN. A v2 blob must land at the CURRENT version, not at v3 — a per-step early
  // return would strand it one version short, where the caller's version check then discards the
  // whole blob, silently converting a careful migration into the wipe it exists to avoid.
  it('carries a v2 blob all the way forward, dropping every flipped default on the way', () => {
    const out = migratePersistedFilters({
      v: 2,
      repoIds: [4, 9],
      userIds: [12],
      excludeBots: false,
      allowedBotIds: [7],
      feedCiLens: 'feed',
      excludeStale: false,
      preset: '30d',
      customFrom: null,
      customTo: null,
      categories: ['commits'],
      prStatuses: ['open'],
      reviewStates: ['approved'],
      derivedStates: ['untouched'],
    });
    expect(out.v).toBe(4);
    // The two bot keys are gone — every v2 user gets the new hidden-by-default baseline once.
    expect('excludeBots' in out).toBe(false);
    expect('allowedBotIds' in out).toBe(false);
    // …and so is the CI lens, so they get the new quieter feed too.
    expect('feedCiLens' in out).toBe(false);
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

  it('v3 → v4 drops ONLY the CI lens, keeping a deliberate post-v3 bot choice', () => {
    // A user who CHOSE to show bots after the v3 flip must keep that choice — the later step
    // must not re-drop keys the earlier one already settled.
    const out = migratePersistedFilters({
      v: 3,
      excludeBots: false,
      allowedBotIds: [7],
      feedCiLens: 'only',
      preset: '7d',
    });
    expect(out.v).toBe(4);
    expect('feedCiLens' in out).toBe(false);
    expect(out.excludeBots).toBe(false);
    expect(out.allowedBotIds).toEqual([7]);
    expect(out.preset).toBe('7d');
  });

  it('leaves a current v4 blob untouched — including a deliberate feedCiLens', () => {
    const v4 = { v: 4, excludeBots: false, feedCiLens: 'only', preset: '7d' };
    expect(migratePersistedFilters(v4)).toBe(v4);
  });

  it('does not touch pre-v2 blobs (the version check discards them, never a migration)', () => {
    const v1 = { v: 1, teamScope: 'teams:1,2', excludeBots: false };
    expect(migratePersistedFilters(v1)).toBe(v1);
  });
});
