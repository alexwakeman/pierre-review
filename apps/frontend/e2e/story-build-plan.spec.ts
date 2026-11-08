import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi, STORY_SESSION_PLAN_READY, STORY_SESSION_STACK_BUILT } from './mock-api.js';
import type { BuildPlanDecisionBody, BuildPlanReplyBody, StoryBuild, StoryDocsAlignmentResponse, TicketPrsResponse } from '@pierre-review/shared';

// "IMPLEMENT, PLAN FIRST" against the mocked API (docs/STORY-BUILD.md § Plan first; mock-api.ts keeps
// ACME-1's session per page). The story view's Implement is a split button whose menu adds "Implement with
// docs" only while the library has a built document; the tab's docs box is then ticked and Start sends
// `docs: true`. A new session's checked plan waits in the PLAN PANEL: the evidence, Agree / Keep the story
// (a DB write, a second press clears), Reply (a new revision), an earlier revision, the draft ticket update
// with Copy, and "Approve and start" enabled only once every point is answered. After Approve the changes
// are the planned PRs in order (the stack view): Push shows on a stacked PR only once the one before it is
// pushed.

const ACME_1 = 'jira:https://acme.atlassian.net#ACME-1';

function ticketPrs(ident: string): TicketPrsResponse {
  return {
    workspaceId: fixtures.WORKSPACE.id,
    ident,
    found: true,
    ticket: { key: 'ACME-1', title: 'Export a report as CSV', url: 'https://acme.atlassian.net/browse/ACME-1', provider: 'jira', status: { name: 'To Do', category: 'new' } },
    open: [],
    merged: [],
    closed: [],
    outsideWorkspace: 0,
    truncated: false,
  };
}

async function withAi(page: Page, o: { storyBuild?: StoryBuild; docs?: boolean } = {}): Promise<void> {
  await installMockApi(page, o.storyBuild != null ? { storyBuild: o.storyBuild } : {});
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route(
    (u) => u.pathname.endsWith('/api/me'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  await page.route(
    (u) => u.pathname.endsWith('/api/ticket-prs'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ticketPrs(new URL(r.request().url()).searchParams.get('ident') ?? '')) }),
  );
  if (o.docs === true) {
    const docs: StoryDocsAlignmentResponse = { workspaceId: fixtures.WORKSPACE.id, ident: ACME_1, available: true, docCount: 3, run: null, lastSucceeded: null };
    await page.route(
      (u) => u.pathname.endsWith('/api/docs/story-alignment'),
      (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(docs) }) : r.fallback()),
    );
  }
}

const tabUrl = `/app/?view=${encodeURIComponent(`story-build:${ACME_1}`)}`;

test.describe('Implement, plan first', () => {
  test('the docs action shows only when the library has a document, and carries into the start', async ({ page }) => {
    await withAi(page, { docs: true });
    await page.goto(`/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}`);
    const tab = page.getByTestId('ticket-tab-view');
    await expect(tab.getByRole('button', { name: 'Implement ACME-1' })).toBeVisible();
    await tab.getByTestId('story-build-entry-menu').click();
    const menu = page.getByRole('menu', { name: 'More ways to implement' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Implement', 'Implement with docs']);
    await menu.getByRole('menuitem', { name: 'Implement with docs' }).click();

    const view = page.getByTestId('story-build-overlay');
    const box = view.getByTestId('story-build-start-docs').getByRole('checkbox');
    await expect(box).toBeChecked();
    await expect(view.getByTestId('story-build-start-button')).toHaveText('Start with docs');
    const start = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/story-builds');
    await view.getByTestId('story-build-start-button').click();
    expect((await start).postDataJSON()).toMatchObject({ action: 'implement', docs: true });
    await expect(view.getByTestId('story-plan')).toContainText('With docs');
  });

  test('without a built document there is no menu', async ({ page }) => {
    await withAi(page);
    await page.goto(`/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}`);
    const tab = page.getByTestId('ticket-tab-view');
    await expect(tab.getByRole('button', { name: 'Implement ACME-1' })).toBeVisible();
    await expect(tab.getByTestId('story-build-entry-menu')).toHaveCount(0);
  });

  test('the plan panel: evidence, answers, a reply, an earlier revision, then Approve and start', async ({ page }) => {
    await withAi(page, { storyBuild: STORY_SESSION_PLAN_READY });
    await page.goto(tabUrl);
    const view = page.getByTestId('story-build-overlay');
    const plan = view.getByTestId('story-plan');
    await expect(plan).toContainText('Plan · revision 2');
    await expect(plan.getByTestId('story-plan-repos')).toContainText('acme/web');
    await expect(plan.getByTestId('story-plan-criterion')).toHaveCount(3);
    await expect(plan.getByTestId('story-plan-pr')).toHaveText([/P1.*Lift the export row cap/, /P2.*Builds on P1/, /P3.*After P2/]);
    await expect(plan.getByTestId('story-plan-dropped')).toHaveText('Limn left out 1 point it could not check.');

    // The evidence: Limn's own text of the lines, the docs section, the query Limn saw run.
    const c1 = plan.locator('[data-testid="story-plan-contention"][data-id="C1"]');
    await expect(c1.locator('[data-kind="code"]')).toContainText('MAX_EXPORT_ROWS = 500');
    await expect(c1.locator('[data-kind="code"] a[aria-label="Open these lines on GitHub"]')).toHaveAttribute('href', /github\.com\/acme\/api\/blob\/b{40}\/src\/reports\/export\.ts#L14-L16$/);
    await expect(c1.locator('[data-kind="docs"]')).toContainText('Export guide');
    await expect(c1).toContainText('You replied (revision 1): Is the cap used anywhere else?');
    const c2 = plan.locator('[data-testid="story-plan-contention"][data-id="C2"]');
    await expect(c2.locator('[data-kind="data_run"]')).toContainText('psql -c select kind');

    // The draft ticket update keeps the ticket's own lines, and copies them exactly.
    await expect(plan.getByTestId('story-plan-ticket-criteria')).toContainText('GIVEN a report with more than 500 rows');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await plan.getByTestId('story-plan-ticket-criteria').getByRole('button', { name: 'Copy acceptance criteria' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('AC3: GIVEN a report with more than 500 rows\nWHEN I select Download CSV\nTHEN the file streams every row');

    // Approve waits for every point.
    const approve = view.locator('[data-story-build-action="approve"]');
    await expect(approve).toBeDisabled();
    await expect(view.getByTestId('story-plan-approve-reason')).toHaveText('2 points still to answer.');

    const decided = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/plan/decisions'));
    await c1.getByRole('button', { name: 'Agree' }).click();
    expect((await decided).postDataJSON() as BuildPlanDecisionBody).toEqual({ revision: 2, contentionId: 'C1', decision: 'agree' });
    await expect(c1).toHaveAttribute('data-decision', 'agree');
    await expect(view.getByTestId('story-plan-approve-reason')).toHaveText('1 point still to answer.');
    // A second press on the chosen answer clears it.
    const cleared = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/plan/decisions'));
    await c1.getByRole('button', { name: 'Agree' }).click();
    expect(((await cleared).postDataJSON() as BuildPlanDecisionBody).decision).toBeNull();
    await expect(c1).toHaveAttribute('data-decision', '');
    await c1.getByRole('button', { name: 'Agree' }).click();
    await expect(c1).toHaveAttribute('data-decision', 'agree');

    // Reply: the agent revises the plan (revision 3); the answers carry forward.
    await c2.getByRole('button', { name: 'Reply' }).click();
    await c2.getByRole('textbox', { name: 'Reply to C2' }).fill('Which two report types?');
    const replied = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/plan/reply'));
    await c2.getByRole('button', { name: 'Send' }).click();
    expect((await replied).postDataJSON() as BuildPlanReplyBody).toEqual({ revision: 2, contentionId: 'C2', text: 'Which two report types?' });
    await expect(plan).toContainText('Plan · revision 3');
    await expect(c1).toHaveAttribute('data-decision', 'agree');

    // An earlier revision, read-only, then back.
    await plan.getByTestId('story-plan-history').click();
    await page.getByRole('menuitem', { name: 'Revision 1' }).click();
    await expect(plan.getByTestId('story-plan-older')).toContainText('Revision 1: the first plan.');
    await plan.getByRole('button', { name: 'Back to the latest' }).click();
    await expect(plan).toContainText('Plan · revision 3');

    await c2.getByRole('button', { name: 'Keep the story' }).click();
    await expect(approve).toBeEnabled();
    await expect(view.getByTestId('story-plan-approve-reason')).toHaveCount(0);
    const approved = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/plan/approve'));
    await approve.click();
    expect((await approved).postDataJSON()).toEqual({ revision: 3 });

    // The plan folds to one line; the changes are the planned pull requests, in order.
    await expect(view.getByTestId('story-plan')).toHaveAttribute('data-status', 'approved');
    await expect(view.getByTestId('story-plan')).toContainText('Approved plan · revision 3');
    await expect(view.getByTestId('story-build-pr')).toHaveCount(3);
  });

  test('the stack view pushes in order', async ({ page }) => {
    await withAi(page, { storyBuild: STORY_SESSION_STACK_BUILT });
    await page.goto(tabUrl);
    const view = page.getByTestId('story-build-overlay');
    const stack = view.getByTestId('story-build-stack');
    await expect(stack.getByTestId('story-build-stack-repo')).toHaveCount(2);
    const p1 = stack.locator('[data-testid="story-build-pr"][data-key="P1"]');
    const p2 = stack.locator('[data-testid="story-build-pr"][data-key="P2"]');
    const p3 = stack.locator('[data-testid="story-build-pr"][data-key="P3"]');
    await expect(p1.getByTestId('story-build-pr-report')).toContainText('Removes the 500-row cap');
    await expect(p3.getByTestId('story-build-pr-report')).toContainText('Not run');
    await expect(p2).toContainText('Builds on P1');
    // Push only once the PR before it is pushed (and the one in another repository it waits for).
    await expect(p2.getByTestId('story-build-pr-wait')).toHaveText('Push P1 first.');
    await expect(p3.getByTestId('story-build-pr-wait')).toHaveText("Push acme/api's P2 first.");
    await expect(view.getByRole('button', { name: 'Push all (3)' })).toBeVisible();

    // The diff is read only when opened.
    await p1.getByTestId('story-build-pr-diff-toggle').click();
    await expect(p1.getByTestId('story-build-pr-diff')).toContainText('csvHeader');

    const pushed = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/prs/501/push'));
    await p1.getByRole('button', { name: 'Push as draft' }).click();
    expect((await pushed).postDataJSON()).toEqual({ draft: true });
    await expect(p1).toHaveAttribute('data-status', 'pushed');
    await expect(p1.getByTestId('story-build-pushed-pr')).toContainText('#81');
    await expect(p2.getByRole('button', { name: 'Push as draft' })).toBeVisible();
    await expect(p2).toContainText('Builds on #81 (P1)');
  });
});
