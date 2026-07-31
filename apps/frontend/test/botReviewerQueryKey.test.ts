// The detected-reviewers cache key.
//
// The regression this exists for is silent and off-screen: FOUR surfaces read this route at team
// key 0 to mean "the whole account roster" — the bot colour map (useBotColors), the feed's vendor
// tag (FeedView), ThreadList's vendor filter, and any future account-wide consumer — while the
// per-team Bots → Settings tab reads it SCOPED to one team's repos. The two responses have the
// same TypeScript shape and the same team key, so if the scoped flag is missing from the key the
// narrow listing populates the entry those four read and they quietly lose bots: a reviewer's
// colour reverts to neutral gray and its feed tag disappears, with no error anywhere.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { detectedReviewersQueryKey } from '../src/hooks/useBotTriage.js';

describe('detectedReviewersQueryKey', () => {
  it('scoped and unscoped listings of the SAME team never share a key', () => {
    expect(detectedReviewersQueryKey(3, true)).not.toEqual(detectedReviewersQueryKey(3, false));
  });

  it('the account default is no exception — team 0 scoped ≠ team 0 unscoped', () => {
    // This is the dangerous pair: every account-wide consumer sits at team 0, and the Settings
    // tab's "No team (default)" tab is ALSO team 0 — just scoped to the unteamed repos.
    expect(detectedReviewersQueryKey(0, true)).not.toEqual(detectedReviewersQueryKey(0, false));
  });

  it('every zero-ish team key collapses to the same unscoped entry the four callers share', () => {
    const target = detectedReviewersQueryKey(0, false);
    expect(detectedReviewersQueryKey(undefined, false)).toEqual(target);
    expect(detectedReviewersQueryKey(null, false)).toEqual(target);
    // Defaulted `scoped` — the zero-arg call the account-wide consumers make.
    expect(detectedReviewersQueryKey()).toEqual(target);
  });

  it('different teams never share a key', () => {
    expect(detectedReviewersQueryKey(3, true)).not.toEqual(detectedReviewersQueryKey(4, true));
  });

  it('keeps the "bot-reviewers" prefix so the reclassify invalidation still sweeps every entry', () => {
    // RECLASSIFY_INVALIDATE_KEYS invalidates by the bare prefix, deliberately: editing the team-0
    // default shifts every team that inherits it. A key that renamed the prefix would strand
    // stale rows on every other tab.
    for (const k of [
      detectedReviewersQueryKey(0, false),
      detectedReviewersQueryKey(0, true),
      detectedReviewersQueryKey(7, true),
    ]) {
      expect(k[0]).toBe('bot-reviewers');
    }
  });

  it('namespaces the team slot, so a team id can never alias a bare integer from another axis', () => {
    // Repo ids, team ids and window keys are all independent autoincrements/plain integers.
    expect(detectedReviewersQueryKey(7, true)[1]).toBe('team:7');
  });
});
