// TEAMMATES' POSTED REVIEWS on the AI Review tab: the words (lib/teammateReviews.ts).
import { describe, expect, it } from 'vitest';
import {
  alsoRaisedByFinding,
  alsoRaisedLabel,
  followUpItemWritable,
  leadingTeammateReview,
  reviewCountLine,
  teamFindingByLabel,
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

describe('the one review: teammates named in the findings list', () => {
  const robin = { userId: 2, login: 'robin-dev', displayName: 'Robin Dunn', avatarUrl: null };
  const sam = { userId: 3, login: 'sam-dev', displayName: null, avatarUrl: null };

  it('names who raised a point, and the reader with them', () => {
    expect(teamFindingByLabel([robin])).toBe('Robin');
    expect(teamFindingByLabel([robin, sam])).toBe('Robin and @sam-dev');
    expect(alsoRaisedLabel([robin])).toBe('You and Robin');
    expect(alsoRaisedLabel([robin, sam])).toBe('You, Robin and @sam-dev');
  });

  it('the newest review leads only when the server says it is a teammate’s', () => {
    const reviews = [{ ...base, reviewId: 9 }] as unknown as Parameters<typeof leadingTeammateReview>[1];
    expect(leadingTeammateReview({ lead: 'teammate', teammateReviewId: 9 }, reviews)?.reviewId).toBe(9);
    expect(leadingTeammateReview({ lead: 'own', teammateReviewId: null }, reviews)).toBeNull();
    expect(leadingTeammateReview(undefined, reviews)).toBeNull();
    expect(alsoRaisedByFinding({ alsoRaisedBy: [{ findingId: 4, by: [robin] }] }).get(4)).toEqual([robin]);
  });
});

describe('the review count line', () => {
  const robin = { userId: 2, login: 'robin-dev', displayName: 'Robin Dunn', avatarUrl: null };
  const sam = { userId: 3, login: 'sam-dev', displayName: null, avatarUrl: null };
  it('names the total and each teammate', () => {
    expect(reviewCountLine({ total: 4, byTeammate: [{ poster: robin, count: 1 }] })).toBe('4 Limn reviews so far · 1 by Robin');
    expect(reviewCountLine({ total: 5, byTeammate: [{ poster: robin, count: 2 }, { poster: sam, count: 1 }] })).toBe(
      '5 Limn reviews so far · 2 by Robin, 1 by @sam-dev',
    );
  });
  it('one review reads singular; none (or an older server) is no line', () => {
    expect(reviewCountLine({ total: 1, byTeammate: [] })).toBe('1 Limn review so far');
    expect(reviewCountLine({ total: 0, byTeammate: [] })).toBeNull();
    expect(reviewCountLine(undefined)).toBeNull();
  });
});
