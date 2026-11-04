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

  test('nothing is selected on arrival; j picks the first row', async ({ page }) => {
    await openMyTurn(page);
    await expect(row(page)).toBeVisible();
    await expect(row(page)).not.toHaveAttribute('aria-selected', 'true');
    await page.getByRole('listbox', { name: 'Pending items' }).focus();
    await page.keyboard.press('j');
    await expect(row(page)).toHaveAttribute('aria-selected', 'true');
  });

  test('Enter opens the selected row, and e dismisses it with an Undo in the toast cluster', async ({ page }) => {
    await openMyTurn(page);
    await expect(row(page)).toBeVisible();
    await page.getByRole('listbox', { name: 'Pending items' }).focus();
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    const dismissed = page.waitForRequest((r) => r.method() === 'PUT' && /my-turn\/dismissals/.test(new URL(r.url()).pathname));
    await page.keyboard.press('e');
    await dismissed;
    await expect(page.getByTestId('undo-toast')).toContainText('until something new happens on it');
  });

  // THE ONE TOAST CLUSTER (docs/FRONTEND.md § There is ONE toast cluster): bottom right of the main
  // content, out of the page flow — a toast appearing never moves the page — and its panel opens UP
  // and LEFT from it. Below md it sits above the bottom bar, and above a sheet so the Undo is reachable.
  for (const vp of [
    { w: 1440, h: 900 },
    { w: 390, h: 844 },
  ]) {
    test(`the Undo is a circle at the bottom right whose panel opens up and left — ${vp.w}×${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await openMyTurn(page);
      await expect(row(page)).toBeVisible();
      const title = page.locator('[data-page-title]').first();
      const titleTop = (await title.boundingBox())!.y;
      await expect(page.getByTestId('header-toast-cluster')).toBeHidden();
      await page.getByRole('listbox', { name: 'Pending items' }).focus();
      await page.keyboard.press('j');
      await page.keyboard.press('Enter');
      await expect(panel(page)).toBeVisible();
      // The panel's own Dismiss (a sheet below lg): its Undo must stay reachable over the sheet.
      await panel(page).getByRole('button', { name: /^Dismiss/ }).click();
      const cluster = page.getByTestId('header-toast-cluster');
      await expect(cluster).toBeVisible();
      await expect(page.getByTestId('undo-toast')).toBeAttached();
      // The dismissed item's panel closes; once it has, nothing is under the cluster.
      await expect(panel(page)).toHaveCount(0);
      await page.waitForTimeout(300);
      // Nothing above the list moved.
      expect((await title.boundingBox())!.y).toBe(titleTop);
      const c = (await cluster.boundingBox())!;
      // Bottom right of the main content.
      expect(vp.w - (c.x + c.width)).toBeLessThanOrEqual(16);
      if (vp.w < 768) {
        const bar = (await page.getByTestId('bottom-bar').boundingBox())!;
        expect(c.y + c.height).toBeLessThanOrEqual(bar.y);
      } else {
        expect(vp.h - (c.y + c.height)).toBeLessThanOrEqual(80);
      }
      await page.screenshot({ path: `test-results/toast-cluster-${vp.w}.png` });
      // The panel: its bottom-right corner on the cluster's top-right corner, growing up and left.
      await cluster.click();
      const p = page.getByTestId('header-toast-panel');
      await expect(p).toBeVisible();
      await expect(page.getByTestId('undo-toast-panel')).toBeVisible();
      await page.waitForTimeout(250);
      const b = (await p.boundingBox())!;
      expect(Math.abs(b.x + b.width - (c.x + c.width))).toBeLessThanOrEqual(1);
      expect(b.y + b.height).toBeLessThanOrEqual(c.y);
      expect(c.y - (b.y + b.height)).toBeLessThanOrEqual(8);
      expect(b.y).toBeGreaterThanOrEqual(0);
      // Never past the main content's left edge.
      const main = (await page.locator('[data-shell-main]').boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(main.x);
      await page.screenshot({ path: `test-results/toast-panel-${vp.w}.png` });
      await page.keyboard.press('Escape');
      await expect(p).toBeHidden();
      await expect(cluster).toBeFocused();
    });
  }

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
    await page.keyboard.press('j');
    await page.keyboard.press('Shift+Enter');
    await expect(page).toHaveURL(/view=pr-detail(:|%3A)101/);
    await page.goBack();
    await expect(page.getByTestId('attention-view')).toBeVisible();
    // Back returns to the board; the row is selected again (the flash) or picked here.
    if ((await row(page).getAttribute('aria-selected')) !== 'true') await row(page).click();
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
