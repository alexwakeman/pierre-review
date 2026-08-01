// The detected-reviewers cache key.
//
// The regression this exists for is silent and off-screen: THREE surfaces read this route with NO
// scope to mean "the whole account roster" — the bot colour map (useBotColors), the feed's vendor
// tag (FeedView) and ThreadList's resolve-eligibility map — while the Bots → Settings list reads
// it NARROWED to the repos in view. The two responses have the same TypeScript shape, so if the
// scope is missing from the key the narrow listing populates the entry those three read and they
// quietly lose bots: a reviewer's colour reverts to neutral gray and its feed tag disappears, with
// no error anywhere.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { detectedReviewersQueryKey } from '../src/hooks/useBotTriage.js';

describe('detectedReviewersQueryKey', () => {
  it('a repo-scoped listing never shares a key with the account-wide one', () => {
    expect(detectedReviewersQueryKey(undefined, [4])).not.toEqual(detectedReviewersQueryKey());
  });

  it('a team-scoped listing never shares a key with the account-wide one', () => {
    expect(detectedReviewersQueryKey('3')).not.toEqual(detectedReviewersQueryKey());
  });

  it('every "no scope" spelling collapses to the one entry the three callers share', () => {
    const target = detectedReviewersQueryKey();
    expect(detectedReviewersQueryKey(undefined, null)).toEqual(target);
    expect(detectedReviewersQueryKey(undefined, [])).toEqual(target);
    // 'all' IS the default scope on the wire, so it must not open a second cache entry.
    expect(detectedReviewersQueryKey('all')).toEqual(target);
  });

  it('different repo scopes never share a key', () => {
    expect(detectedReviewersQueryKey(undefined, [4])).not.toEqual(
      detectedReviewersQueryKey(undefined, [9]),
    );
  });

  it('repo id order does not open a second entry (the same set is one key)', () => {
    expect(detectedReviewersQueryKey(undefined, [9, 4])).toEqual(
      detectedReviewersQueryKey(undefined, [4, 9]),
    );
  });

  // A repo scope is the more specific selection and WINS on the wire (api.botReviewers drops
  // `scope` when repoIds are present), so the key must not vary with the scope it ignored — two
  // keys for one request would double-fetch and split the cache.
  it('a repo scope wins over a team scope, exactly as the request does', () => {
    expect(detectedReviewersQueryKey('3', [4])).toEqual(detectedReviewersQueryKey('9', [4]));
  });

  it('keeps the "bot-reviewers" prefix so the reclassify invalidation still sweeps every entry', () => {
    // RECLASSIFY_INVALIDATE_KEYS invalidates by the bare prefix, deliberately: an identity or
    // price edit is account-wide, so every scoped entry must refetch too.
    for (const k of [
      detectedReviewersQueryKey(),
      detectedReviewersQueryKey('3'),
      detectedReviewersQueryKey(undefined, [7]),
    ]) {
      expect(k[0]).toBe('bot-reviewers');
    }
  });

  it('namespaces the scope slot, so a repo id can never alias a numeric team id', () => {
    // Repo ids and team ids are independent autoincrements, so both are bare integer strings.
    expect(detectedReviewersQueryKey('7')[1]).toBe('scope:7');
    expect(detectedReviewersQueryKey(undefined, [7])[1]).toBe('repo:7');
    expect(detectedReviewersQueryKey('7')).not.toEqual(detectedReviewersQueryKey(undefined, [7]));
  });
});
