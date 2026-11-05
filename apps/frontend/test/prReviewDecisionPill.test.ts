// The PR header's review pill: GitHub's `reviewDecision` as the face, then ONE reviewer from our
// `reviewStandings` fold (the newest matching the decision, else the newest), then "+N". The two
// claims stay apart; a null decision (reviews optional) has no face — the reviewers lead.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/prReviewDecisionPill.test.ts
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrDetail, User } from '@pierre-review/shared';
import { ReviewDecisionPill, reviewDecisionFace } from '../src/components/pr/ReviewDecisionPill.js';

type Fields = Pick<PrDetail, 'reviewDecision' | 'reviewStandings' | 'reviewerCount' | 'requestedReviewers'>;
const base: Fields = { reviewDecision: null, reviewStandings: [], reviewerCount: 0, requestedReviewers: [] };
const ref = (userId: number, standing: PrDetail['reviewStandings'][number]['standing'], at: string) => ({
  userId,
  standing,
  standingAt: at,
});

describe('reviewDecisionFace', () => {
  it('no decision, no reviewer, nobody asked: "No reviews yet"', () => {
    expect(reviewDecisionFace(base)).toEqual({ decision: null, label: 'No reviews yet', lead: null, more: 0 });
  });

  it('leads with the newest reviewer whose standing matches the decision', () => {
    const f = reviewDecisionFace({
      ...base,
      reviewDecision: 'approved',
      reviewerCount: 3,
      reviewStandings: [
        ref(1, 'commented', '2026-11-03T10:00:00Z'),
        ref(2, 'approved', '2026-11-02T10:00:00Z'),
        ref(3, 'approved', '2026-11-01T10:00:00Z'),
      ],
    });
    expect(f).toEqual({ decision: 'approved', label: 'Approved', lead: ref(2, 'approved', '2026-11-02T10:00:00Z'), more: 2 });
  });

  it('falls back to the newest reviewer when none matches', () => {
    const f = reviewDecisionFace({
      ...base,
      reviewDecision: 'review_required',
      reviewerCount: 1,
      reviewStandings: [ref(5, 'commented', '2026-11-03T10:00:00Z')],
    });
    expect(f?.label).toBe('Review required');
    expect(f?.lead?.userId).toBe(5);
    expect(f?.more).toBe(0);
  });

  it('no decision but reviewed: no face, the newest definite verdict leads', () => {
    const f = reviewDecisionFace({
      ...base,
      reviewerCount: 2,
      reviewStandings: [ref(4, 'commented', '2026-11-04T10:00:00Z'), ref(5, 'approved', '2026-11-03T10:00:00Z')],
    });
    expect(f).toEqual({ decision: null, label: null, lead: ref(5, 'approved', '2026-11-03T10:00:00Z'), more: 1 });
  });

  it('no decision, nobody reviewed, someone asked: "No reviews yet"', () => {
    const f = reviewDecisionFace({ ...base, requestedReviewers: [{ userId: 9, teamName: null }] });
    expect(f).toEqual({ decision: null, label: 'No reviews yet', lead: null, more: 0 });
  });

  it('counts reviewers GitHub can no longer name in +N', () => {
    const f = reviewDecisionFace({
      ...base,
      reviewDecision: 'changes_requested',
      reviewerCount: 3,
      reviewStandings: [ref(7, 'changes_requested', '2026-11-03T10:00:00Z')],
    });
    expect(f?.lead?.userId).toBe(7);
    expect(f?.more).toBe(2);
  });

  it('a decision with nobody reviewed yet still shows the face', () => {
    const f = reviewDecisionFace({ ...base, reviewDecision: 'review_required', requestedReviewers: [{ userId: 9, teamName: null }] });
    expect(f).toEqual({ decision: 'review_required', label: 'Review required', lead: null, more: 0 });
  });
});

describe('ReviewDecisionPill', () => {
  const user = (id: number, login: string): User => ({ id, githubLogin: login, displayName: null, avatarUrl: null }) as unknown as User;
  const pr = (over: Partial<PrDetail>): PrDetail =>
    ({ repoId: 1, reviews: [], ...base, ...over }) as unknown as PrDetail;

  it('with nothing reviewed or asked it still says "No reviews yet"', () => {
    const html = renderToStaticMarkup(createElement(ReviewDecisionPill, { pr: pr({}), usersById: new Map() }));
    expect(html.replace(/<[^>]*>/g, '')).toContain('No reviews yet');
  });

  it('an approval on a branch with no review rule never sits beside "No review required"', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewDecisionPill, {
        pr: pr({ reviewerCount: 1, reviewStandings: [ref(2, 'approved', '2026-11-02T10:00:00Z')] }),
        usersById: new Map([[2, user(2, 'bob')]]),
      }),
    );
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).toContain('bob');
    expect(text).not.toContain('No review');
  });

  it("names GitHub's decision, then one reviewer in their own standing, then +N, as one button", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewDecisionPill, {
        pr: pr({
          reviewDecision: 'approved',
          reviewerCount: 2,
          reviewStandings: [ref(1, 'commented', '2026-11-03T10:00:00Z'), ref(2, 'approved', '2026-11-02T10:00:00Z')],
        }),
        usersById: new Map([[1, user(1, 'ann')], [2, user(2, 'bob')]]),
      }),
    );
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).toContain('Approved');
    expect(text).toContain('bob');
    expect(text).not.toContain('ann');
    expect(text).toContain('+1');
    expect(html).toContain('data-testid="pr-header-review"');
    expect(html).toContain('aria-haspopup="dialog"');
    // One control: no link or second button inside the trigger.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('<a ');
  });
});
