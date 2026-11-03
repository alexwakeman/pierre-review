// TEAMMATES' POSTED REVIEWS on the AI Review tab: the words (lib/teammateReviews.ts).
import { describe, expect, it } from 'vitest';
import {
  followUpItemWritable,
  followUpSectionTitle,
  followUpThreadsWritable,
  teammateReviewMeta,
  teammateReviewTitle,
  teammateRunLabel,
} from '../src/lib/teammateReviews.js';

const base = {
  poster: { userId: 2, login: 'robin-dev', displayName: 'Robin Dunn', avatarUrl: null },
  headSha: 'abcdef1234567890',
  run: 'auto' as const,
  pair: false,
  runs: [{ provider: 'claude' as const, model: 'claude-opus-5-5', effort: 'medium' }],
};

describe('teammate review words', () => {
  it("names whose review it is: first name, else the login", () => {
    expect(teammateReviewTitle(base)).toBe('Robin’s review');
    expect(teammateReviewTitle({ poster: { ...base.poster, displayName: null } })).toBe('@robin-dev’s review');
  });

  it('says it is on GitHub, the commit, an auto run and what ran it', () => {
    expect(teammateReviewMeta(base)).toBe('Posted on GitHub · abcdef1 · Auto review · Claude Opus 5.5 · medium');
  });

  it('labels a pair as one review and says nothing about a legacy post’s model', () => {
    expect(teammateRunLabel({ pair: true, runs: [] })).toBe('Claude + Codex');
    expect(teammateRunLabel({ pair: false, runs: [] })).toBeNull();
    expect(teammateReviewMeta({ ...base, run: null, runs: [] })).toBe('Posted on GitHub · abcdef1');
  });
});

describe("a follow-up on the PR author's own review", () => {
  it('names the author and never offers a write on their threads', () => {
    expect(followUpSectionTitle(null)).toBe('Previous review');
    expect(followUpSectionTitle({})).toBe('Previous review');
    expect(followUpSectionTitle({ teammate: { userId: 3, login: 'carol-dev' } })).toBe('@carol-dev’s review');
    expect(followUpThreadsWritable({})).toBe(true);
    expect(followUpThreadsWritable({ teammate: { userId: 3, login: 'carol-dev' } })).toBe(false);
  });

  it("keeps Post reply / Resolve on the reader's OWN carried findings in that follow-up", () => {
    const anchored = { teammate: { userId: 3, login: 'carol-dev' } };
    // The author's finding: never written to.
    expect(followUpItemWritable(anchored, { carried: false })).toBe(false);
    // The reader's own earlier finding, merged in as carried: still theirs.
    expect(followUpItemWritable(anchored, { carried: true })).toBe(true);
    // An ordinary follow-up: every item writable.
    expect(followUpItemWritable({}, { carried: false })).toBe(true);
    expect(followUpItemWritable(null, { carried: true })).toBe(true);
  });
});
