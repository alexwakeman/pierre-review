// "Waiting on others" and the review target on the SPA side — `lib/reviewWaits.ts`, the waiting
// row (`pendingRow.ts`), its heading (`lib/pendingHeadings.ts`) and its tab (`pendingTabs.ts`).
//
// WHAT THIS PINS:
//   1. THE ROW SAYS WHO HAS IT AND FOR HOW LONG, IN WORKING HOURS — "With sam" and "6h", never the
//      clock age the other rows show; a team is named by its own name.
//   2. THE NOTE HAS THE REAL NUMBERS: "Over the 4h review target — waiting 9.5 working hours".
//   3. NUDGE AND "ASK SOMEONE ELSE" ARE OFFERED ONLY PAST THE TARGET, ONLY TO A READER WHO CAN
//      REQUEST REVIEWERS — and Nudge only to a PERSON (a team request carries no slug to re-ask by).
//   4. THE TAB HAS NO DO NEXT HEAD and says how it is ordered.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { AttentionCardsResponse, InsightCard, ReviewWait } from '@pierre-review/shared';
import {
  askSomeoneElseOffered,
  holdersText,
  nudgeOffered,
  overTargetText,
  waitingHeading,
  workHoursLong,
  workHoursShort,
} from '../src/lib/reviewWaits.js';
import { pendingRowSummary } from '../src/components/Activity/pendingRow.js';
import { pendingActionLine, pendingHeading } from '../src/lib/pendingHeadings.js';
import { buildPendingView, TAB_LABEL } from '../src/components/Activity/pendingTabs.js';
import { orderSentence } from '../src/components/Activity/pendingExplain.js';
import { pendingBoardEmpty, pendingSummaryParts } from '../src/lib/pendingFirstLanding.js';

const nameOf = (id: number | null | undefined): string | null =>
  id === 5 ? 'sam' : id === 6 ? 'robin' : null;
const wait = (o: Partial<ReviewWait>): ReviewWait => ({
  userId: null,
  teamName: null,
  since: '2026-10-28T09:00:00Z',
  workHours: 1,
  ...o,
});

const pr = {
  prId: 7,
  repoId: 1,
  repoFullName: 'acme/api',
  prNumber: 12,
  prTitle: 'Retry the upload',
  authorId: 2,
  githubUrl: 'https://github.com/acme/api/pull/12',
  ciStatus: 'success',
  changedFiles: 3,
  additions: 40,
  deletions: 8,
  openedAt: '2026-10-01T00:00:00Z',
  authorIsBot: false,
  authorBotKind: null,
  automation: null,
  inMergeQueue: null,
  mergeQueueEntryState: null,
  reviewDecision: null,
  reviewApprovals: 0,
  reviewChangesRequested: false,
  reviewers: [],
  reviewerCount: 0,
};
const waitingCard = (o: Record<string, unknown> = {}): InsightCard =>
  ({
    id: 'waiting:7',
    kind: 'waiting_on_others',
    severity: 'info',
    ...pr,
    holders: [wait({ userId: 5, workHours: 9.5 })],
    waitHours: 9.5,
    targetHours: 4,
    overReviewTarget: { targetHours: 4, waitedHours: 9.5 },
    viewerCanPush: true,
    ...o,
  }) as unknown as InsightCard;

describe('the words', () => {
  it('spells working hours short and long', () => {
    expect(workHoursShort(6)).toBe('6h');
    expect(workHoursShort(4.44)).toBe('4.4h');
    expect(workHoursShort(12.6)).toBe('13h');
    expect(workHoursLong(1)).toBe('1 working hour');
    expect(workHoursLong(9.5)).toBe('9.5 working hours');
    expect(workHoursLong(0.01)).toBe('a few working minutes');
  });

  it('states the target and the real wait', () => {
    expect(overTargetText({ targetHours: 4, waitedHours: 9.5 })).toBe(
      'Over the 4h review target — waiting 9.5 working hours',
    );
  });

  it('names who has it — a person, a team, several', () => {
    expect(holdersText([wait({ userId: 5 })], nameOf)).toBe('sam');
    expect(holdersText([wait({ teamName: 'Platform Team' })], nameOf)).toBe('Platform Team');
    expect(holdersText([wait({ userId: 5 }), wait({ userId: 6 })], nameOf)).toBe('sam and robin');
    expect(holdersText([wait({ userId: 5 }), wait({ userId: 6 }), wait({ teamName: 'x' })], nameOf)).toBe(
      'sam and 2 others',
    );
    expect(waitingHeading({ holders: [wait({ userId: 5 })], waitHours: 6 }, nameOf)).toBe(
      'With sam · 6 working hours',
    );
  });
});

describe('Nudge and Ask someone else', () => {
  it('are offered only past the target, to a reader who can request', () => {
    const over = wait({ userId: 5, workHours: 9 });
    const under = wait({ userId: 5, workHours: 3 });
    expect(nudgeOffered(over, 4, true)).toBe(true);
    expect(nudgeOffered(under, 4, true)).toBe(false);
    expect(nudgeOffered(over, 4, false)).toBe(false);
    // Exactly on the target is within it.
    expect(nudgeOffered(wait({ userId: 5, workHours: 4 }), 4, true)).toBe(false);
    expect(askSomeoneElseOffered([under, over], 4, true)).toBe(true);
    expect(askSomeoneElseOffered([under], 4, true)).toBe(false);
    expect(askSomeoneElseOffered([over], 4, false)).toBe(false);
  });

  it('never nudges a team — there is no slug to re-ask by', () => {
    expect(nudgeOffered(wait({ teamName: 'Platform Team', workHours: 30 }), 4, true)).toBe(false);
  });
});

describe('the waiting row and card', () => {
  const ctx = { nameOf, sharedOwner: 'acme' };

  it('says who has it and the WORKING-hours wait, and flags the target', () => {
    const s = pendingRowSummary(waitingCard(), ctx);
    expect(s.reason).toBe('With sam');
    expect(s.waitText).toBe('9.5h');
    expect(s.overTarget).toBe('Over the 4h review target — waiting 9.5 working hours');
    expect(s.title).toBe('Retry the upload');
  });

  it('carries no note under the target', () => {
    const s = pendingRowSummary(
      waitingCard({ waitHours: 2, holders: [wait({ userId: 5, workHours: 2 })], overReviewTarget: undefined }),
      ctx,
    );
    expect(s.overTarget).toBeUndefined();
  });

  it('flags a stalled review over the target too', () => {
    const stalled = {
      id: 'stalled:7',
      kind: 'stalled_review',
      severity: 'info',
      ...pr,
      ageHours: 50,
      requestedReviewerIds: [5],
      requestedTeamNames: [],
      overReviewTarget: { targetHours: 4, waitedHours: 20 },
    } as unknown as InsightCard;
    expect(pendingRowSummary(stalled, ctx).overTarget).toBe(
      'Over the 4h review target — waiting 20 working hours',
    );
  });

  it('heads the card with the wait, and gives no imperative without its button', () => {
    expect(pendingHeading(waitingCard(), ctx).lead).toBe('With sam · 9.5 working hours');
    expect(pendingActionLine(waitingCard(), ctx).verb).toBe('Nudge them or ask someone else');
    expect(pendingActionLine(waitingCard({ viewerCanPush: false }), ctx).verb).toBeNull();
    expect(pendingActionLine(waitingCard({ overReviewTarget: undefined }), ctx).verb).toBeNull();
  });
});

describe('the Waiting on others tab', () => {
  it('has a label, no Do next head, and says how it is ordered', () => {
    expect(TAB_LABEL.waiting).toBe('Waiting on others');
    const c = waitingCard();
    const data: AttentionCardsResponse = {
      cards: [c],
      users: [],
      tabs: [{ key: 'waiting', total: 1, kindTotals: { waiting_on_others: 1 }, cardIds: [c.id] }],
    };
    const view = buildPendingView(data, 'waiting', null, null, null);
    expect(view.cards.map((x) => x.id)).toEqual([c.id]);
    expect(view.doNextCount).toBe(0);
    expect(orderSentence('waiting', false)).toMatch(/^Longest wait first/);
  });

  it('does not stop the board reading as empty — it is information, not something to do', () => {
    const t = (key: 'my_turn' | 'waiting', total: number) => ({ key, total, kindTotals: {}, cardIds: [] });
    expect(pendingBoardEmpty([t('my_turn', 0), t('waiting', 2)])).toBe(true);
    expect(pendingBoardEmpty([t('my_turn', 1), t('waiting', 0)])).toBe(false);
    // The summary names it apart, as its own figure.
    expect(pendingSummaryParts([t('my_turn', 1), t('waiting', 2)], null).map((p) => p.text)).toEqual([
      '1 waiting on you',
      '2 of yours waiting on others',
    ]);
  });
});
