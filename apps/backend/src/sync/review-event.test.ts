import { describe, expect, it } from 'vitest';
import { isSubstantiveReview, lifecycleTransitions } from './upsert.js';

// A review earns its own `review_submitted` timeline marker only when it's a
// decision or carries a summary body — otherwise it's GitHub's empty wrapper
// around inline comments and would duplicate the review_comment markers.
describe('isSubstantiveReview', () => {
  it('suppresses an empty "commented" review (the inline-comment wrapper)', () => {
    expect(isSubstantiveReview('commented', null)).toBe(false);
    expect(isSubstantiveReview('commented', '')).toBe(false);
    expect(isSubstantiveReview('commented', '   ')).toBe(false);
    expect(isSubstantiveReview('commented', undefined)).toBe(false);
  });

  it('keeps a "commented" review that has a real summary body', () => {
    expect(isSubstantiveReview('commented', 'Looks good overall, a few notes.')).toBe(true);
  });

  it('keeps review decisions regardless of body', () => {
    expect(isSubstantiveReview('approved', null)).toBe(true);
    expect(isSubstantiveReview('changes_requested', '')).toBe(true);
    expect(isSubstantiveReview('dismissed', null)).toBe(true);
    expect(isSubstantiveReview('pending', null)).toBe(true);
  });
});

// draft→ready and reopened have no discrete GitHub event; sync derives them by
// comparing the PR's prior persisted row against the incoming one.
describe('lifecycleTransitions', () => {
  it('emits pr_ready_for_review on a draft → ready flip', () => {
    expect(
      lifecycleTransitions({ isDraft: true, state: 'open' }, { isDraft: false, state: 'open' }),
    ).toEqual(['pr_ready_for_review']);
  });

  it('emits pr_reopened on a closed → open flip', () => {
    expect(
      lifecycleTransitions({ isDraft: false, state: 'closed' }, { isDraft: false, state: 'open' }),
    ).toEqual(['pr_reopened']);
  });

  it('emits nothing on a PR first seen (no prior row), even if open/ready', () => {
    expect(lifecycleTransitions(null, { isDraft: false, state: 'open' })).toEqual([]);
    expect(lifecycleTransitions(null, { isDraft: true, state: 'open' })).toEqual([]);
  });

  it('emits nothing when nothing transitioned', () => {
    expect(
      lifecycleTransitions({ isDraft: false, state: 'open' }, { isDraft: false, state: 'open' }),
    ).toEqual([]);
    // still draft → no ready event
    expect(
      lifecycleTransitions({ isDraft: true, state: 'open' }, { isDraft: true, state: 'open' }),
    ).toEqual([]);
    // ready → draft (the reverse) is not a tracked event
    expect(
      lifecycleTransitions({ isDraft: false, state: 'open' }, { isDraft: true, state: 'open' }),
    ).toEqual([]);
  });

  it('does NOT treat merge as reopen, and can emit both transitions at once', () => {
    expect(
      lifecycleTransitions({ isDraft: false, state: 'open' }, { isDraft: false, state: 'merged' }),
    ).toEqual([]);
    expect(
      lifecycleTransitions({ isDraft: true, state: 'closed' }, { isDraft: false, state: 'open' }),
    ).toEqual(['pr_ready_for_review', 'pr_reopened']);
  });
});
