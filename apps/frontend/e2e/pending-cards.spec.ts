import { test, expect, type Page } from '@playwright/test';
import type {
  AttentionCardsResponse,
  InsightCard,
  InsightKind,
  MyTurnCard,
  PendingAuthorSplit,
  PendingTab,
} from '@pierre-review/shared';
import { PENDING_TABS, pendingAuthorSideOf, pendingTabHolds } from '@pierre-review/shared';
import { fixtures, installMockApi } from './mock-api.js';

// THE PENDING INBOX — one line per item, the whole card in the side panel:
//   • the row names the PR (title, repo#N, size, author, age) and is one line
//   • the panel leads with the EVENT: "Bob replied: “…” · 1d", not the PR title
//   • the action line says what to do and where, with the PR title as a link to Overview
//   • inside My turn there is no "Your turn" label — the tab already says it
//   • ⚠ NOTHING ON THE BOARD FETCHES ON MOUNT, ON SELECTION OR ON OPENING THE PANEL: the thread's
//     conversation is behind Details, and only that click asks for it
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
    const inTab = cards.filter((c) => pendingTabHolds(t, c));
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
  await page.goto('/app/?view=activity&activityRepo=attention');
  await expect(page.getByTestId('attention-view')).toBeVisible();
  return { threadHits: () => threads };
}

const row = (page: Page) => page.getByRole('option', { name: /Login: remember the last account/ });
const panel = (page: Page) => page.getByTestId('pending-panel');

test.describe('Pending: one line per item, the event-first card in the panel', () => {
  test('the row is the PR; the panel leads with what happened and claims no "Your turn" inside My turn', async ({
    page,
  }) => {
    await openMyTurn(page);
    await expect(row(page)).toBeVisible();
    await expect(row(page)).toContainText('+40 −8');
    await row(page).click();
    const card = panel(page);
    await expect(card.getByRole('heading', { level: 3 })).toContainText(
      'Bob replied: “Can you take another look at this?”',
    );
    await expect(card).toContainText('Reply or resolve');
    await expect(card).toContainText('your comment on src/login.ts:10');
    // The PR title is a link to Overview, not the card's heading.
    await expect(card.getByRole('button', { name: /Login: remember the last account/ })).toBeVisible();
    // The tab says it; the card does not.
    await expect(card).not.toContainText('Your turn');
    // The server's @login sentence is gone.
    await expect(card).not.toContainText('@bob');
    // The buttons sit in the panel's action bar, Dismiss last and quiet.
    await expect(card.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: /^Dismiss/ })).toBeVisible();
    // Escape closes the panel; the row stays selected.
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(row(page)).toHaveAttribute('aria-selected', 'true');
  });

  test('Enter opens the selected row, and e dismisses it with an Undo in the header strip', async ({ page }) => {
    await openMyTurn(page);
    await expect(row(page)).toBeVisible();
    await page.getByRole('listbox', { name: 'Pending items' }).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    const dismissed = page.waitForRequest((r) => r.method() === 'PUT' && /my-turn\/dismissals/.test(new URL(r.url()).pathname));
    await page.keyboard.press('e');
    await dismissed;
    await expect(page.getByTestId('undo-toast')).toContainText('until something new happens on it');
  });

  test('a double-click goes straight to the thread: the PR’s own tab, on Changes', async ({ page }) => {
    await openMyTurn(page);
    await expect(row(page)).toBeVisible();
    await row(page).dblclick();
    await expect(page).toHaveURL(/view=pr-detail(:|%3A)101/);
    await expect(page).toHaveURL(/thread=5001/);
  });

  test('Shift+Enter goes straight to the item; Enter on an open panel does the same', async ({ page }) => {
    await openMyTurn(page);
    await expect(row(page)).toBeVisible();
    await page.getByRole('listbox', { name: 'Pending items' }).focus();
    await page.keyboard.press('Shift+Enter');
    await expect(page).toHaveURL(/view=pr-detail(:|%3A)101/);
    await page.goBack();
    await expect(page.getByTestId('attention-view')).toBeVisible();
    await page.getByRole('listbox', { name: 'Pending items' }).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    // The panel names where it goes (the arrow in its header).
    await expect(panel(page).getByRole('button', { name: 'Open thread' })).toBeVisible();
    await page.getByRole('listbox', { name: 'Pending items' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/view=pr-detail(:|%3A)101/);
  });

  test('the conversation waits for Details — nothing is fetched to paint, select or open', async ({ page }) => {
    const { threadHits } = await openMyTurn(page);
    await expect(row(page)).toBeVisible();
    await row(page).click();
    const card = panel(page);
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
