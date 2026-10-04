import { test, expect, type Page } from '@playwright/test';
import type {
  AttentionCardsResponse,
  InsightCard,
  InsightKind,
  MyTurnCard,
  PendingAuthorSplit,
  PendingTab,
} from '@pierre-review/shared';
import { PENDING_TABS, pendingAuthorSideOf } from '@pierre-review/shared';
import { fixtures, installMockApi } from './mock-api.js';

// THE PENDING CARD, LAYOUT B — what the reader sees first, and what waits for a click:
//   • the card leads with the EVENT: "Bob replied: “…” · 1d", not the PR title
//   • the action line says what to do and where, with the PR title as a link to Overview
//   • inside My turn there is no "Your turn" label — the tab already says it
//   • ⚠ NOTHING ON THE BOARD FETCHES ON MOUNT: the thread's conversation is behind Details, and
//     only the click asks for it
//
// This spec overrides only `/api/attention`; everything else is mock-api.ts (thread 5001 is there).

const iso = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

const REPLY_CARD: MyTurnCard = {
  id: 'myturn:thread:5001',
  kind: 'my_turn',
  severity: 'high',
  reason: 'thread',
  prId: 101,
  repoId: fixtures.REPO.id,
  repoFullName: fixtures.REPO.fullName,
  prNumber: 101,
  prTitle: 'Login: remember the last account',
  authorId: 2,
  githubUrl: `https://github.com/${fixtures.REPO.fullName}/pull/101`,
  ciStatus: 'failure',
  failingChecks: ['lint'],
  failingCheckTotal: 1,
  changedFiles: 4,
  additions: 40,
  deletions: 8,
  openedAt: iso(72),
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
  threadId: 5001,
  detail: '@bob replied 1d ago',
  since: iso(26),
  personal: true,
  relevance: 'direct',
  reply: { authorId: 3, body: 'Can you take another look at this?', at: iso(26), truncated: false },
  threadPath: 'src/login.ts',
  threadLine: 10,
};

function attentionWithReply(): AttentionCardsResponse {
  const base = fixtures.ATTENTION;
  const cards: InsightCard[] = [REPLY_CARD, ...base.cards];
  const split = (cs: InsightCard[]): PendingAuthorSplit => ({
    people: cs.filter((c) => pendingAuthorSideOf(c) === 'people').length,
    automation: cs.filter((c) => pendingAuthorSideOf(c) === 'automation').length,
  });
  const tabs = PENDING_TABS.map((t): PendingTab => {
    const prior = base.tabs?.find((p) => p.key === t.key);
    const ranked: readonly InsightKind[] = t.kinds.filter((k) => k !== 'reviewer_load');
    const inTab = cards.filter((c) => ranked.includes(c.kind));
    const ofKind = (k: InsightKind): InsightCard[] => inTab.filter((c) => c.kind === k);
    return {
      ...prior,
      key: t.key,
      total: inTab.length,
      kindTotals: Object.fromEntries(ranked.map((k) => [k, ofKind(k).length])),
      cardIds: inTab.map((c) => c.id),
      authorTotals: split(inTab),
      kindAuthorTotals: Object.fromEntries(ranked.map((k) => [k, split(ofKind(k))])),
      ...(t.key === 'my_turn'
        ? {
            relevanceTotals: { mine: inTab.length, others: 0 },
            relevanceAuthorTotals: { mine: split(inTab), others: split([]) },
          }
        : {}),
    };
  });
  return { ...base, cards, tabs, users: [...base.users, ...fixtures.USERS] };
}

async function openMyTurn(page: Page): Promise<{ threadHits: () => number }> {
  await installMockApi(page);
  const board = attentionWithReply();
  await page.route(
    (url) => url.pathname === '/api/attention',
    (route) => route.fulfill({ json: board }),
  );
  let threads = 0;
  page.on('request', (r) => {
    if (/\/api\/threads\/\d+$/.test(new URL(r.url()).pathname)) threads += 1;
  });
  await page.goto('/app/');
  await expect(page.getByTestId('attention-view')).toBeVisible();
  return { threadHits: () => threads };
}

test.describe('Pending: the event-first card', () => {
  test('leads with what happened, says what to do, and claims no "Your turn" inside My turn', async ({
    page,
  }) => {
    await openMyTurn(page);
    const card = page.getByRole('listitem', { name: /Bob replied/ });
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 3 })).toContainText(
      'Bob replied: “Can you take another look at this?”',
    );
    await expect(card).toContainText('Reply or resolve');
    await expect(card).toContainText('your comment on src/login.ts:10');
    // The PR title is a link to Overview, not the card's heading.
    await expect(card.getByRole('button', { name: /Login: remember the last account/ })).toBeVisible();
    // The tab says it; the card does not.
    await expect(card).not.toContainText('Your turn');
    // The type chip and the server's @login sentence are gone.
    await expect(card).not.toContainText('Reply needed');
    await expect(card).not.toContainText('@bob');
    // The buttons sit on the left, Dismiss last and quiet.
    await expect(card.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  });

  test('the conversation waits for Details — nothing is fetched to paint the board', async ({ page }) => {
    const { threadHits } = await openMyTurn(page);
    const card = page.getByRole('listitem', { name: /Bob replied/ });
    await expect(card).toBeVisible();
    // Give any eager fetch the chance to happen before asserting it did not.
    await page.waitForTimeout(500);
    expect(threadHits()).toBe(0);
    await card.getByRole('button', { name: /^Details/ }).click();
    await expect.poll(threadHits).toBeGreaterThan(0);
    await expect(card.getByText('Can you take another look at this?').last()).toBeVisible();
    await expect(card.getByText('4 files')).toBeVisible();
  });
});
