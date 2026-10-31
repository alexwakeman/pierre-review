import { test, expect, type Page } from '@playwright/test';
import type { ClaudeReviewResponse, PrDetail, TicketPrsResponse } from '@pierre-review/shared';
import { fixtures, installMockApi, prDetailFor } from './mock-api.js';

// THE PR VIEW'S TABS ON THE WIRE (docs/FRONTEND.md § PrDetail): the AI Review tab is `?prTab=ai_review`
// (the old `?prTab=claude_review` still opens it and is rewritten), and the Story tab (`?prTab=story`)
// is listed only while the PR names a story, rendering the story view inside the PR.

const PR_ID = 101;
const IDENT = 'jira:https://acme.atlassian.net#ACME-7';

/** AI on (`me.ai.enabled`), an empty review read, and PR 101 naming a story when `story`. */
async function setup(page: Page, { story, two = false }: { story: boolean; two?: boolean }): Promise<void> {
  await installMockApi(page);
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route(
    (u) => u.pathname.endsWith('/api/me'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  const review: ClaudeReviewResponse = { enabled: true, auth: 'ok', review: null, history: [] };
  await page.route(
    (u) => u.pathname === `/api/prs/${PR_ID}/claude-review`,
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(review) }),
  );
  const detail: PrDetail = {
    ...prDetailFor(PR_ID),
    tickets: story
      ? [
          { key: 'ACME-7', url: 'https://acme.atlassian.net/browse/ACME-7', provider: 'jira', ident: IDENT },
          ...(two
            ? [{ key: 'ACME-8', url: 'https://acme.atlassian.net/browse/ACME-8', provider: 'jira' as const, ident: IDENT.replace('ACME-7', 'ACME-8') }]
            : []),
        ]
      : [],
  };
  await page.route(
    (u) => u.pathname === `/api/prs/${PR_ID}`,
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }),
  );
  const ticketPrs: TicketPrsResponse = {
    workspaceId: fixtures.WORKSPACE.id,
    ident: IDENT,
    found: true,
    ticket: null,
    open: [],
    merged: [],
    closed: [],
    outsideWorkspace: 0,
    truncated: false,
  };
  await page.route(
    (u) => u.pathname.endsWith('/api/ticket-prs'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ticketPrs) }),
  );
}

const tabs = (page: Page) => page.getByRole('tablist', { name: `Pull request #${PR_ID} tabs` });

test.describe('PR tabs on the wire', () => {
  test('?prTab=ai_review opens AI Review', async ({ page }) => {
    await setup(page, { story: false });
    await page.goto(`/app/?view=pr-detail:${PR_ID}&prTab=ai_review`);
    await expect(tabs(page).getByRole('tab', { name: /^AI Review/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('review-layout')).toBeVisible();
    await expect(page).toHaveURL(/prTab=ai_review/);
  });

  test('the old ?prTab=claude_review still opens AI Review, and the URL says ai_review', async ({ page }) => {
    await setup(page, { story: false });
    await page.goto(`/app/?view=pr-detail:${PR_ID}&prTab=claude_review`);
    await expect(tabs(page).getByRole('tab', { name: /^AI Review/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/prTab=ai_review/);
    expect(page.url()).not.toContain('claude_review');
  });

  test('picking AI Review writes ai_review', async ({ page }) => {
    await setup(page, { story: false });
    await page.goto(`/app/?view=pr-detail:${PR_ID}`);
    await tabs(page).getByRole('tab', { name: /^AI Review/ }).click();
    await expect(page).toHaveURL(/prTab=ai_review/);
  });
});

test.describe('the Story tab', () => {
  test('is listed when the PR names a story, last, and renders the story view', async ({ page }) => {
    await setup(page, { story: true });
    await page.goto(`/app/?view=pr-detail:${PR_ID}&prTab=story`);
    const story = tabs(page).getByRole('tab', { name: 'Story' });
    await expect(story).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(page).getByRole('tab').last()).toHaveText('Story');
    const pane = page.getByTestId('pr-story-tab');
    await expect(pane.getByTestId('story-view-body')).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Open story tab' })).toBeVisible();
    // One story: no switcher.
    await expect(pane.getByTestId('pr-story-switcher')).toHaveCount(0);
  });

  test('several stories: a switcher, the first picked', async ({ page }) => {
    await setup(page, { story: true, two: true });
    await page.goto(`/app/?view=pr-detail:${PR_ID}&prTab=story`);
    const switcher = page.getByTestId('pr-story-switcher');
    await expect(switcher.getByRole('button', { name: 'ACME-7' })).toHaveAttribute('aria-pressed', 'true');
    await switcher.getByRole('button', { name: 'ACME-8' }).click();
    await expect(switcher.getByRole('button', { name: 'ACME-8' })).toHaveAttribute('aria-pressed', 'true');
    await expect(switcher.getByRole('button', { name: 'ACME-7' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('picking it writes ?prTab=story', async ({ page }) => {
    await setup(page, { story: true });
    await page.goto(`/app/?view=pr-detail:${PR_ID}`);
    await tabs(page).getByRole('tab', { name: 'Story' }).click();
    await expect(page).toHaveURL(/prTab=story/);
    await expect(page.getByTestId('pr-story-tab')).toBeVisible();
  });

  test('is absent when the PR names no story; a stale ?prTab=story shows Overview', async ({ page }) => {
    await setup(page, { story: false });
    await page.goto(`/app/?view=pr-detail:${PR_ID}&prTab=story`);
    await expect(tabs(page).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(page).getByRole('tab', { name: 'Story' })).toHaveCount(0);
    await expect(page.getByTestId('pr-story-tab')).toHaveCount(0);
  });
});
