import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi, prDetailFor, STORY_BUILD_DOCS_RUNNING, STORY_BUILD_PLAN_READY_DOCS } from './mock-api.js';
import type { PrDetail, StoryBuild, StoryBuildDocsDecisionsBody, TicketPrsResponse, TicketReviewStatesResponse, WorkspaceTrackerSettings } from '@pierre-review/shared';

// "Implement story" (docs/STORY-BUILD.md) against the mocked API (mock-api.ts keeps ACME-1's session
// per page). The entry is the STORY VIEW's action (§ Entry points), never a sprint card: the card carries
// only the build mark; a click opens the story tray, whose action group offers "Implement" on the
// not-started ticket with no pull request (owner decision 4) — opening the build tab, where Start makes a
// plan, Accept builds, Push pushes one repository — and "Fill gaps" on ACME-2 (started, its current story
// check found gaps), whose tab lists them up front. The story tab and the PR view's Story tab offer the
// same action from their own facts.

const ACME_1 = 'jira:https://acme.atlassian.net#ACME-1';
const ACME_2 = 'jira:https://acme.atlassian.net#ACME-2';

/** The story view's PR read for ACME-1 (To Do, no PR) and ACME-2 (In Progress, one open PR). */
function ticketPrsFor(ident: string): TicketPrsResponse {
  const two = ident === ACME_2;
  return {
    workspaceId: fixtures.WORKSPACE.id,
    ident,
    found: true,
    ticket: {
      key: two ? 'ACME-2' : 'ACME-1',
      title: two ? 'Sign in with a magic link' : 'Export a report as CSV',
      url: `https://acme.atlassian.net/browse/${two ? 'ACME-2' : 'ACME-1'}`,
      provider: 'jira',
      status: two ? { name: 'In Progress', category: 'indeterminate' } : { name: 'To Do', category: 'new' },
    },
    open: two ? [fixtures.PRS[0]!] : [],
    merged: [],
    closed: [],
    outsideWorkspace: 0,
    truncated: false,
  };
}

/** The fixtures keep AI dark; this feature needs it on (`me.ai.enabled`). Every story view gets its PR
 *  read, and ACME-2's story check (run 501, `ACME_2_CHECK`) is current. */
async function withAi(page: Page, storyBuild?: StoryBuild): Promise<void> {
  await installMockApi(page, storyBuild != null ? { storyBuild } : {});
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route(
    (u) => u.pathname.endsWith('/api/me'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  await page.route(
    (u) => u.pathname.endsWith('/api/ticket-prs'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ticketPrsFor(new URL(r.request().url()).searchParams.get('ident') ?? '')) }),
  );
  const states: TicketReviewStatesResponse = {
    states: [
      {
        ident: ACME_2,
        status: 'current',
        staleBecause: [],
        changedPrIds: [],
        latestRunId: 501,
        runningRunId: null,
        alignment: 'partly_aligned',
        counts: { met: 1, partlyMet: 0, notMet: 1, unclear: 0, notChecked: 0, total: 2 },
        memberCount: 1,
        checkedAt: '2026-10-19T10:00:00.000Z',
      },
    ],
  };
  await page.route(
    (u) => u.pathname.endsWith('/api/ticket-reviews/states'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(states) }),
  );
}

async function gotoSprint(page: Page): Promise<void> {
  await withAi(page);
  await page.goto('/app/?view=sprint');
  await expect(page.getByTestId('sprint-view')).toBeVisible();
}

/** Click a card: its story opens in the tray beside the board. */
async function openTray(page: Page, key: string) {
  await page.locator(`[data-ticket="${key}"]`).first().locator('[data-card-button]').click();
  const tray = page.getByTestId('sprint-story-tray');
  await expect(tray.getByTestId('story-view-body')).toBeVisible();
  return tray;
}

test.describe('Implement story', () => {
  test('the sprint cards carry no build button', async ({ page }) => {
    await gotoSprint(page);
    await expect(page.locator('[data-ticket="ACME-1"]').first()).toBeVisible();
    await expect(page.getByTestId('ticket-implement')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Implement ACME-1' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fill gaps in ACME-2' })).toHaveCount(0);
  });

  test('only the not-started ticket with no pull request offers Implement, in its story', async ({ page }) => {
    await gotoSprint(page);
    let tray = await openTray(page, 'ACME-1');
    await expect(tray.getByRole('button', { name: 'Implement ACME-1' })).toHaveCount(1);
    await expect(tray.getByTestId('story-build-entry')).toHaveText('Implement');
    tray = await openTray(page, 'ACME-2');
    await expect(tray.getByRole('button', { name: 'Implement ACME-2' })).toHaveCount(0);
  });

  test('a started ticket whose story check found gaps offers Fill gaps, and its tab lists them', async ({ page }) => {
    await gotoSprint(page);
    const tray = await openTray(page, 'ACME-2');
    await tray.getByRole('button', { name: 'Fill gaps in ACME-2' }).click();

    const view = page.getByTestId('story-build-overlay');
    await expect(view.getByTestId('story-build-action')).toHaveText('Fill gaps');
    await expect(view.getByTestId('story-build-start-gap')).toHaveCount(2);
    await expect(view.getByTestId('story-build-start-gaps')).toContainText('The link expires after 15 minutes');
    await expect(view.getByTestId('story-build-start-gaps')).toContainText('A rate limit on link requests');
    await expect(view.getByTestId('story-build-start-button')).toHaveText('Fill gaps');
  });

  test('open from the story, start, accept, push', async ({ page }) => {
    await gotoSprint(page);
    const tray = await openTray(page, 'ACME-1');
    await tray.getByRole('button', { name: 'Implement ACME-1' }).click();

    const view = page.getByTestId('story-build-overlay');
    await expect(view).toBeVisible();
    await expect(page).toHaveURL(/view=story-build%3A/);
    await expect(view.getByTestId('story-build-start')).toBeVisible();

    await view.getByTestId('story-build-start-button').click();
    await expect(view.getByTestId('story-build-summary')).toContainText('CSV endpoint');
    await expect(view.getByTestId('story-build-plan-repo')).toHaveCount(2);
    // Every gap the plan closes is listed under "Already done".
    await expect(view.getByTestId('story-build-criterion')).toHaveCount(3);

    // The steps sit behind Details.
    await view.getByTestId('story-build-plan-repo').first().getByRole('button', { name: 'Details' }).click();
    await expect(view.getByTestId('story-build-steps-detail')).toContainText('Stream a report as CSV');

    await view.getByRole('button', { name: 'Accept plan and build' }).click();
    await expect(view.getByTestId('story-build-repo')).toHaveCount(2);
    await expect(view.getByRole('button', { name: 'Push all' })).toBeVisible();

    // The diff is read only when opened.
    const api = view.locator('[data-testid="story-build-repo"][data-repo="acme/api"]');
    await api.getByTestId('story-build-diff-toggle').click();
    await expect(api.getByTestId('story-build-diff')).toContainText('csvHeader');

    await api.getByRole('button', { name: 'Push as draft' }).click();
    await expect(api).toHaveAttribute('data-status', 'pushed');
    await expect(api.getByTestId('story-build-pushed-pr')).toContainText('#77');
  });

  test('the story tab offers Implement from its own facts, and ⌘K names it', async ({ page }) => {
    await withAi(page);
    await page.goto(`/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}`);
    const tab = page.getByTestId('ticket-tab-view');
    await expect(tab.getByRole('button', { name: 'Implement ACME-1' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const option = page.getByRole('option', { name: /Implement ACME-1/ });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.getByTestId('story-build-overlay')).toBeVisible();
    await expect(page.getByTestId('story-build-action')).toHaveText('Implement');
  });

  test('an open session shows Open build with its mark', async ({ page }) => {
    await withAi(page, STORY_BUILD_PLAN_READY_DOCS);
    await page.goto(`/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}`);
    const tab = page.getByTestId('ticket-tab-view');
    const open = tab.getByRole('button', { name: "Open ACME-1's build: Plan ready" });
    await expect(open).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Implement ACME-1' })).toHaveCount(0);
    await open.click();
    await expect(page.getByTestId('story-build-overlay')).toBeVisible();
  });

  test("the PR view's Story tab offers Fill gaps on a started story with gaps", async ({ page }) => {
    await withAi(page);
    const prId = fixtures.PRS[0]!.id;
    const detail: PrDetail = {
      ...prDetailFor(prId),
      tickets: [{ key: 'ACME-2', url: 'https://acme.atlassian.net/browse/ACME-2', provider: 'jira', ident: ACME_2 }],
    };
    await page.route(
      (u) => u.pathname === `/api/prs/${prId}`,
      (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }),
    );
    // A Jira tracker, so the story view reads the ticket's check state (the gaps come from it, not a board).
    const tracker: WorkspaceTrackerSettings = {
      workspaceId: fixtures.WORKSPACE.id,
      issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ACME'], matchScope: 'title_branch' },
      jira: { email: null, hasToken: false },
      providerChosen: true,
      githubIssuesRepos: [],
    };
    await page.route(
      (u) => /\/api\/workspaces\/\d+\/tracker$/.test(u.pathname),
      (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tracker) }),
    );
    await page.goto(`/app/?view=pr-detail:${prId}&prTab=story`);
    const pane = page.getByTestId('pr-story-tab');
    await pane.getByRole('button', { name: 'Fill gaps in ACME-2' }).click();
    const view = page.getByTestId('story-build-overlay');
    await expect(view.getByTestId('story-build-action')).toHaveText('Fill gaps');
    await expect(view.getByTestId('story-build-start-gap')).toHaveCount(2);
  });

  test('never offered while AI is off', async ({ page }) => {
    await installMockApi(page);
    await page.route(
      (u) => u.pathname.endsWith('/api/ticket-prs'),
      (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ticketPrsFor(ACME_1)) }),
    );
    await page.goto('/app/?view=sprint');
    await expect(page.getByTestId('sprint-view')).toBeVisible();
    const tray = await openTray(page, 'ACME-1');
    await expect(tray.getByTestId('story-actions')).toBeAttached();
    await expect(page.getByTestId('story-build-entry')).toHaveCount(0);
  });

  test('a build tab URL re-creates the tab', async ({ page }) => {
    await withAi(page);
    await page.goto(`/app/?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#ACME-1')}`);
    await expect(page.getByTestId('story-build-overlay')).toBeVisible();
    await expect(page.getByTestId('story-build-header')).toContainText('ACME-1');
  });

  test('a docs tick names the docs run it was aimed at', async ({ page }) => {
    await withAi(page, STORY_BUILD_PLAN_READY_DOCS);
    await page.goto(`/app/?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#ACME-1')}`);
    const docs = page.getByTestId('story-build-docs');
    await expect(docs).toContainText('Suggestions from the docs (2)');
    await expect(docs).toContainText('This story changes the docs (1)');
    await expect(docs).toContainText('Grounded in the docs (2)');
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/docs/decisions'));
    await docs.locator('[data-testid="story-build-docs-item"][data-kind="suggestion"]').first().getByRole('checkbox').click();
    const body = (await put).postDataJSON() as StoryBuildDocsDecisionsBody;
    expect(body).toMatchObject({ planRevision: 1, runId: 'run-a', decisions: { D4: 'ignore', D5: 'include' } });
  });

  test('Cancel stops a docs-only run, from the docs section and from ⌘K', async ({ page }) => {
    await withAi(page, STORY_BUILD_DOCS_RUNNING);
    await page.goto(`/app/?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#ACME-1')}`);
    const docs = page.getByTestId('story-build-docs');
    await expect(docs).toContainText('Reading the docs');
    await expect(docs.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const option = page.getByRole('option', { name: /Cancel the build of ACME-1/ });
    await expect(option).toBeVisible();
    const cancel = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/cancel'));
    await option.click();
    await cancel;
    await expect(docs).toContainText('Couldn’t check the docs.');
  });

  test('a build tab URL for a ticket the board does not offer cannot start one', async ({ page }) => {
    await withAi(page);
    // ACME-9 is a ghost (outside the sprint): neither Implement nor Fill gaps.
    await page.goto(`/app/?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#ACME-9')}`);
    await expect(page.getByTestId('story-build-not-offered')).toBeVisible();
    await expect(page.getByTestId('story-build-start-button')).toHaveCount(0);
  });
});
