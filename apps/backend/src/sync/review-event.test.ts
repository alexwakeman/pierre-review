import { describe, expect, it } from 'vitest';
import { isSubstantiveReview } from './upsert.js';

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
