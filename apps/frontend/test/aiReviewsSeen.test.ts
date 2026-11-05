// Pending → "AI reviews", the newest AI review per PR — the SPA half (lib/aiReviewsSeen.ts,
// components/Activity/PendingAiReviews.tsx, pendingTabs.ts, lib/pendingFirstLanding.ts), and the
// AI Review tab's per-run seen stamp (hooks/useClaudeReviewSeen.ts).
//
// WHAT THIS PINS:
//   1. LOOKING NEVER REMOVES A ROW: "New" is a tag against the stamp the visit started with.
//   2. THE STAMP POST CANNOT LOOP: it sends the newest row's time only when that is newer than the
//      response's stamp and than what the visit sent; an empty list sends nothing.
//   3. THE TAB IS A READ-ONLY REFERENCE: never "Do next", its badge is the NEW rows, and it never
//      keeps the board from reading as empty.
//   4. THE AI REVIEW TAB SENDS "SEEN" only for a finished, read, not-yet-seen run.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/aiReviewsSeen.test.ts
import { describe, expect, it } from 'vitest';
import { PENDING_TABS, type AiReviewCard, type AttentionCardsResponse, type PendingTab, type User } from '@pierre-review/shared';
import { aiReviewsStampToSend, isNewAiReview } from '../src/lib/aiReviewsSeen.js';
import { buildPendingView, tabBadgeCount } from '../src/components/Activity/pendingTabs.js';
import { pendingBoardEmpty, pendingSummaryParts } from '../src/lib/pendingFirstLanding.js';
import { pendingEmptyNote } from '../src/components/Activity/AttentionView.js';
import { aiReviewFindings, aiReviewRanBy } from '../src/components/Activity/PendingAiReviews.js';
import { claudeReviewNeedsSeen } from '../src/hooks/useClaudeReviewSeen.js';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const ai = (reviewId: number, minutesAgo: number, over: Partial<AiReviewCard> = {}): AiReviewCard => ({
  id: `ai_review:${reviewId}`,
  kind: 'ai_review',
  severity: 'info',
  reviewId,
  prId: reviewId + 100,
  repoId: 1,
  repoFullName: 'acme/api',
  prNumber: reviewId,
  prTitle: `PR ${reviewId}`,
  githubUrl: `https://github.com/acme/api/pull/${reviewId}`,
  ranByUserId: null,
  auto: false,
  verdict: null,
  findingCount: 0,
  at: new Date(T0 - minutesAgo * 60_000).toISOString(),
  ...over,
});

describe('"New" and the last-looked stamp', () => {
  it('tags only rows newer than the visit’s baseline — never looked: every row', () => {
    expect(isNewAiReview(ai(1, 30), null)).toBe(true);
    expect(isNewAiReview(ai(1, 30), T0 - 20 * 60_000)).toBe(false);
    expect(isNewAiReview(ai(2, 10), T0 - 20 * 60_000)).toBe(true);
  });

  it('sends the newest row once, never again after the refetch, and never for an empty list', () => {
    const rows = [ai(2, 10), ai(1, 30)];
    // First look, never stamped: the newest review shown.
    expect(aiReviewsStampToSend(rows, null, null)).toBe(T0 - 10 * 60_000);
    // The POST refetched the board: the server's stamp is now that time — nothing to send.
    expect(aiReviewsStampToSend(rows, T0 - 10 * 60_000, T0 - 10 * 60_000)).toBeNull();
    // A stale response (older stamp) after this visit sent: still nothing.
    expect(aiReviewsStampToSend(rows, T0 - 60 * 60_000, T0 - 10 * 60_000)).toBeNull();
    // An empty list: nothing at all.
    expect(aiReviewsStampToSend([], null, null)).toBeNull();
    // A newer review arrives during the visit: sent once.
    expect(aiReviewsStampToSend([ai(3, 1), ...rows], T0 - 10 * 60_000, T0 - 10 * 60_000)).toBe(T0 - 60_000);
  });
});

describe('the AI reviews tab', () => {
  const claudeDef = PENDING_TABS.find((t) => t.key === 'claude')!;
  const tab = (over: Partial<PendingTab> = {}): PendingTab => ({
    key: 'claude',
    total: 3,
    kindTotals: { ai_review: 3 },
    cardIds: ['ai_review:1', 'ai_review:2', 'ai_review:3'],
    newTotal: 1,
    ...over,
  });

  it('holds only the AI reviews, unscored, never "Do next"', () => {
    expect(claudeDef.kinds).toEqual(['ai_review']);
    expect(claudeDef.newestFirst).toEqual(['ai_review']);
    const cards = [ai(1, 5), ai(2, 9), ai(3, 12)];
    const data = { cards, users: [], tabs: [tab()] } as unknown as AttentionCardsResponse;
    const v = buildPendingView(data, 'claude', null, null, null);
    expect(v.doNextCount).toBe(0);
    expect(v.chips).toBeNull();
  });

  it('badges the NEW rows, and the summary line says the same number', () => {
    expect(tabBadgeCount(tab(), null)).toBe(1);
    expect(tabBadgeCount(tab(), 'automation')).toBe(0);
    expect(pendingSummaryParts([tab()], null)).toEqual([{ tab: 'claude', count: 1, text: '1 new AI review' }]);
    expect(pendingSummaryParts([tab({ newTotal: 0 })], null)).toEqual([]);
  });

  it('never keeps the board from reading as empty — it is a reference list', () => {
    const myTurn: PendingTab = { key: 'my_turn', total: 0, kindTotals: { my_turn: 0 }, cardIds: [] };
    expect(pendingBoardEmpty([myTurn, tab()])).toBe(true);
    expect(pendingBoardEmpty([{ ...myTurn, total: 1 }, tab()])).toBe(false);
  });

  it('says so plainly when there is nothing', () => {
    expect(
      pendingEmptyNote({ tab: 'claude', kind: null, relevance: null, authorLens: null, allTotal: 0, cards: 0, people: 0 })?.sentence,
    ).toBe('No AI reviews yet.');
  });

  it('says who ran it and what it found in plain words', () => {
    const robin: User = { id: 7, githubLogin: 'robin', displayName: 'Robin', avatarUrl: null, isBot: false };
    expect(aiReviewRanBy({ ranByUserId: null, auto: false }, undefined)).toBe('Your Limn');
    expect(aiReviewRanBy({ ranByUserId: null, auto: true }, undefined)).toBe('Your Limn, auto review');
    expect(aiReviewRanBy({ ranByUserId: 7, auto: false }, robin)).toBe('Robin’s Limn');
    expect(aiReviewRanBy({ ranByUserId: 7, auto: false }, undefined)).toBe('A teammate’s Limn');
    expect(aiReviewFindings(0)).toBe('No findings');
    expect(aiReviewFindings(1)).toBe('1 finding');
    expect(aiReviewFindings(4)).toBe('4 findings');
  });
});

describe('the AI Review tab’s seen stamp', () => {
  it('is sent only for a finished, read, unseen run — never on an older server', () => {
    expect(claudeReviewNeedsSeen({ status: 'succeeded', reviewMode: 'diff_only', seenAt: null })).toBe(true);
    expect(claudeReviewNeedsSeen({ status: 'succeeded', reviewMode: 'diff_only', seenAt: '2026-11-04T00:00:00Z' })).toBe(false);
    expect(claudeReviewNeedsSeen({ status: 'succeeded', reviewMode: 'diff_only', seenAt: undefined })).toBe(false);
    expect(claudeReviewNeedsSeen({ status: 'running', reviewMode: null, seenAt: null })).toBe(false);
    expect(claudeReviewNeedsSeen({ status: 'succeeded', reviewMode: 'skip', seenAt: null })).toBe(false);
    expect(claudeReviewNeedsSeen(null)).toBe(false);
  });
});
