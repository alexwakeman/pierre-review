import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi, STORY_SESSION_PLAN_READY, STORY_SESSION_STACK_BUILT } from './mock-api.js';
import type { BuildPlanDecisionBody, BuildPlanReplyBody, StoryBuild, StoryDocsAlignmentResponse, TicketPrsResponse, TicketUpdateBody, TicketUpdateResponse } from '@pierre-review/shared';

// "IMPLEMENT, PLAN FIRST" against the mocked API (docs/STORY-BUILD.md § Plan first; mock-api.ts keeps
// ACME-1's session per page). The story view's Implement is a split button whose menu adds "Implement with
// docs" only while the library has a built document; the tab's docs box is then ticked and Start sends
// `docs: true`. A new session's checked plan waits in the PLAN PANEL: the evidence, then the points to
// settle ONE STEP AT A TIME (Agree / Keep the story, a DB write saved on the pick, which moves on; the same
// pick again keeps it; the 1 and 2 keys), Reply (a new revision, the wizard opening on the first open
// point), an earlier revision, the draft ticket update with Copy, and the Review step whose "Approve and
// start" is enabled only once every point is answered. After Approve the changes
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
  test('the reference documents are not a choice: the start state says the agent gets them', async ({ page }) => {
    await withAi(page, { docs: true });
    await page.goto(`/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}`);
    const tab = page.getByTestId('ticket-tab-view');
    await tab.getByRole('button', { name: 'Implement ACME-1' }).click();
    const view = page.getByTestId('story-build-overlay');
    await expect(view.getByTestId('story-build-start-docs')).toContainText("The agent also gets the workspace's reference documents.");
    await expect(view.getByTestId('story-build-start-docs').getByRole('checkbox')).toHaveCount(0);
    await expect(view.getByTestId('story-build-start-button')).toHaveText('Start');
    const start = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/story-builds');
    await view.getByTestId('story-build-start-button').click();
    expect((await start).postDataJSON()).not.toHaveProperty('docs');
  });

  test('"Build end to end" starts the build as the tab opens, with its fixed settings', async ({ page }) => {
    await withAi(page);
    await page.goto(`/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}`);
    const tab = page.getByTestId('ticket-tab-view');
    await expect(tab.getByRole('button', { name: 'Implement ACME-1' })).toBeVisible();
    await tab.getByTestId('story-build-entry-menu').click();
    const menu = page.getByRole('menu', { name: 'More ways to implement' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Implement', 'Build end to end']);
    const start = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/story-builds');
    await menu.getByRole('menuitem', { name: 'Build end to end' }).click();
    // No Start press: the menu press is the start.
    {
      const body = (await start).postDataJSON();
      expect(body).toMatchObject({ action: 'implement', endToEnd: true, autoApprovePlan: true, autoPush: true });
      // No rounds sent: the server reads Settings → AI → Implement story's itself.
      expect(body.loopRounds).toBeUndefined();
    }
    await expect(page.getByTestId('story-build-overlay').getByTestId('story-plan')).toBeVisible();
  });

  test('the plan panel: evidence, one point at a time, a reply, an earlier revision, then Review and Approve and start', async ({ page }) => {
    await withAi(page, { storyBuild: STORY_SESSION_PLAN_READY });
    const sentDecisions: BuildPlanDecisionBody[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/plan/decisions')) sentDecisions.push(r.postDataJSON() as BuildPlanDecisionBody);
    });
    await page.goto(tabUrl);
    const view = page.getByTestId('story-build-overlay');
    const plan = view.getByTestId('story-plan');
    await expect(plan).toContainText('Plan · revision 2');
    await expect(plan.getByTestId('story-plan-repos')).toContainText('acme/web');
    await expect(plan.getByTestId('story-plan-criterion')).toHaveCount(3);
    await expect(plan.getByTestId('story-plan-pr')).toHaveText([/P1.*Lift the export row cap/, /P2.*Builds on P1/, /P3.*After P2/]);
    await expect(plan.getByTestId('story-plan-dropped')).toHaveText('Ensemble left out 1 point it could not check.');

    // The wizard opens on the first open point: one step, headed with its criteria.
    const wizard = plan.getByTestId('story-plan-contentions');
    const step = plan.getByTestId('story-plan-step');
    await expect(step).toHaveAttribute('data-id', 'C1');
    await expect(step).toContainText('Point 1 of 2');
    await expect(step).toContainText('AC3');
    await expect(plan.getByTestId('story-plan-contention')).toHaveCount(1);
    await expect(wizard).toContainText('Points to settle (0 of 2 answered)');

    // The evidence: Limn's own text of the lines, the docs section, the query Limn saw run.
    const c1 = plan.locator('[data-testid="story-plan-contention"][data-id="C1"]');
    await expect(c1.locator('[data-kind="code"]')).toContainText('MAX_EXPORT_ROWS = 500');
    await expect(c1.locator('[data-kind="code"] a[aria-label="Open these lines on GitHub"]')).toHaveAttribute('href', /github\.com\/acme\/api\/blob\/b{40}\/src\/reports\/export\.ts#L14-L16$/);
    await expect(c1.locator('[data-kind="docs"]')).toContainText('Export guide');
    await expect(c1).toContainText('You replied (revision 1): Is the cap used anywhere else?');
    // Each choice says what the agent then builds.
    await expect(step.locator('[data-plan-action="agree"]')).toContainText('Remove the 500-row cap for CSV and stream every row.');
    await expect(step.locator('[data-plan-action="keep"]')).toContainText('Stream up to 500 rows and keep the refusal above that.');

    // The draft ticket update keeps the ticket's own lines, and copies them exactly.
    await expect(plan.getByTestId('story-plan-ticket-criteria')).toContainText('GIVEN a report with more than 500 rows');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await plan.getByTestId('story-plan-ticket-criteria').getByRole('button', { name: 'Copy acceptance criteria' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('AC3: GIVEN a report with more than 500 rows\nWHEN I select Download CSV\nTHEN the file streams every row');

    // Next goes past an open point (it stays open); Review lists both open, and Approve waits for every point.
    await step.locator('[data-plan-nav="next"]').click();
    await expect(step).toHaveAttribute('data-id', 'C2');
    await expect(step.locator('[data-kind="data_run"]')).toContainText('psql -c select kind');
    await step.locator('[data-plan-nav="next"]').click();
    const review = plan.getByTestId('story-plan-review');
    await expect(review.getByTestId('story-plan-review-line')).toHaveText([/Point 1.*AC3.*Not answered/, /Point 2.*AC1.*Not answered/]);
    const approve = view.locator('[data-story-build-action="approve"]');
    await expect(approve).toBeDisabled();
    await expect(view.getByTestId('story-plan-approve-reason')).toHaveText('2 points still to answer.');

    // A Review line goes back to its step; a pick is saved at once and moves to the next open point.
    await review.locator('[data-testid="story-plan-review-line"][data-id="C1"] button').click();
    await expect(step).toHaveAttribute('data-id', 'C1');
    const decided = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/plan/decisions'));
    await step.locator('[data-plan-action="agree"]').click();
    expect((await decided).postDataJSON() as BuildPlanDecisionBody).toEqual({ revision: 2, contentionId: 'C1', decision: 'agree' });
    await expect(step).toHaveAttribute('data-id', 'C2');
    await expect(plan.getByTestId('story-plan-steps').locator('button[data-state="answered"]')).toHaveText(['1']);
    await expect(wizard).toContainText('Points to settle (1 of 2 answered)');

    // Back, and the same pick again keeps the answer (no clear) and moves on. A double-click's second
    // click lands on the next point's Agree and is ignored: C2 stays open.
    await step.locator('[data-plan-nav="back"]').click();
    await expect(step.locator('[data-plan-action="agree"]')).toHaveAttribute('aria-pressed', 'true');
    await step.locator('[data-plan-action="agree"]').dblclick();
    await expect(step).toHaveAttribute('data-id', 'C2');
    await expect(step.locator('[data-plan-action="agree"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(plan.getByTestId('story-plan-steps').locator('button[data-state="answered"]')).toHaveText(['1']);

    // A key pressed inside the ⓘ popover (a portal) does not pick an answer.
    await wizard.getByRole('button', { name: /Points to settle/ }).click();
    await expect(page.getByRole('dialog', { name: 'Points to settle' }).locator('[tabindex="0"]')).toBeFocused();
    await page.keyboard.press('1');
    await page.keyboard.press('Escape');
    await expect(step).toHaveAttribute('data-id', 'C2');
    expect(sentDecisions).toEqual([{ revision: 2, contentionId: 'C1', decision: 'agree' }]);

    // Reply: the agent revises the plan (revision 3); the answers carry forward and the wizard opens on the open point.
    await step.getByRole('button', { name: 'Reply' }).click();
    await step.getByRole('textbox', { name: 'Reply to C2' }).fill('Which two report types?');
    const replied = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/plan/reply'));
    await step.getByRole('button', { name: 'Send' }).click();
    expect((await replied).postDataJSON() as BuildPlanReplyBody).toEqual({ revision: 2, contentionId: 'C2', text: 'Which two report types?' });
    await expect(plan).toContainText('Plan · revision 3');
    await expect(step).toHaveAttribute('data-id', 'C2');
    await expect(plan.getByTestId('story-plan-steps').locator('button[data-state="answered"]')).toHaveText(['1']);

    // An earlier revision, read-only, then back.
    await plan.getByTestId('story-plan-history').click();
    await page.getByRole('menuitem', { name: 'Revision 1' }).click();
    await expect(plan.getByTestId('story-plan-older')).toContainText('Revision 1: the first plan.');
    await plan.getByRole('button', { name: 'Back to the latest' }).click();
    await expect(plan).toContainText('Plan · revision 3');

    // The 2 key picks Keep the story; the last answer moves to Review, where Approve is enabled.
    await expect(step).toHaveAttribute('data-id', 'C2');
    await wizard.focus();
    const kept = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/plan/decisions'));
    await page.keyboard.press('2');
    expect((await kept).postDataJSON() as BuildPlanDecisionBody).toEqual({ revision: 3, contentionId: 'C2', decision: 'keep_story' });
    await expect(review.getByTestId('story-plan-review-line')).toHaveText([/Point 1.*Agree/, /Point 2.*Keep the story/]);
    // ← and → move between the steps.
    await page.keyboard.press('ArrowLeft');
    await expect(step).toHaveAttribute('data-id', 'C2');
    await page.keyboard.press('ArrowRight');
    await expect(review).toBeVisible();
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
  test('the ticket draft is editable, and Update ticket writes only what changes to Jira once asked', async ({ page }) => {
    await withAi(page, { storyBuild: STORY_SESSION_PLAN_READY });
    const sent: TicketUpdateBody[] = [];
    await page.route(
      (u) => u.pathname.endsWith('/api/ticket-update'),
      (r) => {
        sent.push(r.request().postDataJSON() as TicketUpdateBody);
        const res: TicketUpdateResponse = { workspaceId: fixtures.WORKSPACE.id, ident: ACME_1, updated: { description: false, acceptanceCriteria: true }, criteriaField: 'Acceptance Criteria', criteriaWritten: 'field' };
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
      },
    );
    await page.goto(tabUrl);
    const draft = page.getByTestId('story-plan-ticket-update');
    const box = draft.getByTestId('story-plan-ticket-criteria').getByRole('textbox', { name: 'Acceptance criteria' });
    await expect(box).toHaveValue(/GIVEN a report with more than 500 rows/);
    // The whole ticket: the description box holds the current text (the draft leaves it), "No change".
    await expect(draft.getByTestId('story-plan-ticket-description').getByRole('textbox')).toHaveValue(/download a report as a CSV file/);
    await expect(draft.getByTestId('story-plan-ticket-description-diff')).toHaveText('No change.');
    await expect(draft.getByTestId('story-plan-ticket-criteria-diff')).toContainText('What changes');
    // The changed words wear the docs-quote wash in the box; the unchanged description has none.
    await expect(draft.getByTestId('story-plan-ticket-description').locator('mark.doc-quote-mark')).toHaveCount(0);
    await expect(draft.getByTestId('story-plan-ticket-criteria').locator('mark.doc-quote-mark').first()).toBeVisible();
    await box.fill('AC3: GIVEN a report with 10,000 rows\nTHEN the file streams every row');
    await expect(draft).toContainText('The ticket (edited)');
    await expect(draft.getByTestId('story-plan-ticket-criteria').locator('mark.doc-quote-mark')).toHaveText(['with 10,000 rows', 'streams']);
    // Copy takes the edited text.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await draft.getByRole('button', { name: 'Copy acceptance criteria' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('AC3: GIVEN a report with 10,000 rows\nTHEN the file streams every row');
    // Update asks once, then writes only the field the draft has.
    await draft.getByTestId('story-plan-ticket-update-button').click();
    await expect(draft).toContainText('Replace the ticket\'s acceptance criteria in Jira?');
    await draft.getByTestId('story-plan-ticket-update-confirm').click();
    await expect(draft.getByTestId('story-plan-ticket-updated')).toHaveText('Updated in Jira.');
    expect(sent).toEqual([{ ident: ACME_1, description: null, acceptanceCriteria: 'AC3: GIVEN a report with 10,000 rows\nTHEN the file streams every row' }]);
    await expect(draft.getByTestId('story-plan-ticket-update-button')).toBeDisabled();
    // Back to the draft restores the agent's text.
    await draft.getByTestId('story-plan-ticket-reset').click();
    await expect(box).toHaveValue(/GIVEN a report with more than 500 rows/);
  });

  test('the build header links to the ticket tab and to the tracker, with no sprint read in memory', async ({ page }) => {
    await withAi(page, { storyBuild: STORY_SESSION_PLAN_READY });
    await page.goto(tabUrl);
    const header = page.getByTestId('story-build-header');
    await expect(header.getByTestId('tracker-link-out')).toHaveAttribute('href', 'https://acme.atlassian.net/browse/ACME-1');
    await header.getByTestId('story-build-open-story').click();
    await expect(page.getByTestId('ticket-tab-view')).toBeVisible();
  });
});
