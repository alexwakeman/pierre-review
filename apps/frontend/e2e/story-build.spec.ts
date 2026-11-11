import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi, prDetailFor, SANDBOX_RUNTIME_NONE, STORY_SESSION_CLOSED, STORY_SESSION_READY } from './mock-api.js';
import type { PrDetail, SandboxNetworkAllowBody, SandboxRuntimeStatus, StoryBuild, TicketPrsResponse, TicketReviewStatesResponse, WorkspaceTrackerSettings } from '@pierre-review/shared';

// "Implement story" as a WORKSPACE SESSION (docs/SANDBOX.md § Sessions) against the mocked API (mock-api.ts
// keeps ACME-1's session per page). The entry is the STORY VIEW's action (docs/STORY-BUILD.md § Entry
// points), never a sprint card: the card carries only the build mark; a click opens the story tray, whose
// action group offers "Implement" on the not-started ticket with no pull request (owner decision 4) —
// opening the build tab, where Start boots a sandbox that PLANS FIRST (the plan panel: story-build-plan.spec.ts);
// an older session (before plan first) still talks, then Start build builds and Push pushes one repository — and "Fill gaps" on ACME-2 (started, its current story check found gaps), whose
// tab lists them up front. The story tab and the PR view's Story tab offer the same action from their own
// facts. With no container runtime the tab says so in one line, with "How to set up".

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
async function withAi(page: Page, storyBuild?: StoryBuild, runtime?: SandboxRuntimeStatus): Promise<void> {
  await installMockApi(page, { ...(storyBuild != null ? { storyBuild } : {}), ...(runtime != null ? { runtime } : {}) });
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
        // The automatic check's plan (auto-plan.ts): nothing moved, so the story view says nothing.
        autoCheck: { status: 'up_to_date', reason: null, startsAt: null, lastChange: null },
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

/** Click a card: its story opens in the tray over the board. */
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
    // The tray sits ON TOP of the board and may cover the next card: close it first.
    await page.keyboard.press('Escape');
    await expect(tray).toHaveCount(0);
    tray = await openTray(page, 'ACME-2');
    await expect(tray.getByRole('button', { name: 'Implement ACME-2' })).toHaveCount(0);
  });

  test('the tray steps through the board in order, and a click on the board closes it', async ({ page }) => {
    await gotoSprint(page);
    const order = await page.locator('[data-testid="sprint-view"] [data-ident]:has([data-card-button])').evaluateAll((els) => els.map((e) => e.getAttribute('data-ticket')));
    expect(order.length).toBeGreaterThan(1);
    const tray = await openTray(page, order[0]!);
    const open = page.locator('[data-testid="sprint-view"] [data-card-button][aria-current="true"]');
    await expect(open).toHaveCount(1);
    await expect(tray.getByTestId('sprint-story-tray-prev')).toBeDisabled();
    // j steps to the next card in board order; the Previous button back again.
    await page.keyboard.press('j');
    await expect(page.locator(`[data-ticket="${order[1]}"][data-selected="true"]`)).toHaveCount(1);
    await tray.getByTestId('sprint-story-tray-prev').click();
    await expect(page.locator(`[data-ticket="${order[0]}"][data-selected="true"]`)).toHaveCount(1);
    // A click on the board outside a card closes the tray.
    await page.getByTestId('sprint-view').locator('h3').first().click();
    await expect(tray).toHaveCount(0);
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

  test('open from the story and start: the agent plans first, and nothing builds before Approve', async ({ page }) => {
    await gotoSprint(page);
    const tray = await openTray(page, 'ACME-1');
    await tray.getByRole('button', { name: 'Implement ACME-1' }).click();

    const view = page.getByTestId('story-build-overlay');
    await expect(view).toBeVisible();
    await expect(page).toHaveURL(/view=story-build%3A/);
    await expect(view.getByTestId('story-build-start')).toBeVisible();
    await expect(view.getByTestId('story-build-start')).toContainText('It plans first.');
    await expect(view.getByTestId('sandbox-runtime-line')).toContainText('Colima 0.8.1');
    // What comes in beside the code, counted before Start.
    await expect(view.getByTestId('story-build-start-inherits')).toContainText(
      'The agent also gets 12 memories from 1 project, your CLAUDE.md and 1 project skill.',
    );
    // No built document in this workspace: no docs box.
    await expect(view.getByTestId('story-build-start-docs')).toHaveCount(0);

    const start = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/story-builds');
    await view.getByTestId('story-build-start-button').click();
    expect((await start).postDataJSON()).not.toHaveProperty('docs');
    await expect(view.getByTestId('story-session')).toHaveAttribute('data-phase', 'plan_ready');
    await expect(view.getByTestId('story-plan')).toBeVisible();
    // A plan-first session never offers Start build: the plan panel's Approve starts it.
    await expect(view.getByRole('button', { name: 'Start build' })).toHaveCount(0);
  });

  test('an older session (before plan first): talk, start build, push', async ({ page }) => {
    await withAi(page, STORY_SESSION_READY);
    await page.goto(`/app/?view=${encodeURIComponent(`story-build:${ACME_1}`)}`);
    const view = page.getByTestId('story-build-overlay');
    const session = view.getByTestId('story-session');
    await expect(session).toHaveAttribute('data-phase', 'ready');
    await expect(view.getByTestId('story-build-steps').locator('[aria-current="step"]')).toHaveText('Talk');
    // The rail: the ticket the agent was told, every repository at its path, the network log.
    await expect(view.getByTestId('story-session-ticket')).toContainText('Download CSV button');
    await expect(view.getByTestId('story-session-ticket')).toContainText('Open points (1)');
    await expect(view.getByTestId('story-session-repos')).toContainText('/Users/me/acme/web');
    await expect(view.getByTestId('story-session-network')).toContainText('1 blocked');

    // A blocked host: the reader's Allow click, for this session.
    const allow = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/network/allow'));
    await view.getByTestId('story-session-network').getByRole('button', { name: 'Allow for this session' }).click();
    expect((await allow).postDataJSON() as SandboxNetworkAllowBody).toEqual({ rule: 'telemetry.example.com', scope: 'session' });

    // A chat turn: the reader on the right, the tool row (it opens to its output), the agent's answer.
    await view.getByRole('textbox', { name: 'Message the agent' }).fill('Where are the reports?');
    await view.getByRole('button', { name: 'Send' }).click();
    const convo = view.getByTestId('story-session-conversation');
    await expect(convo.locator('[data-kind="reader"]')).toContainText('Where are the reports?');
    await expect(convo.locator('[data-kind="agent"]')).toContainText('src/reports/index.ts');
    await convo.locator('[data-kind="tool"]').getByRole('button').click();
    await expect(convo.locator('[data-kind="tool"]')).toContainText('ReportHeader.tsx');

    await view.getByRole('button', { name: 'Start build' }).click();
    await expect(session).toHaveAttribute('data-phase', 'built');
    await expect(view.getByTestId('story-build-repo')).toHaveCount(2);
    await expect(view.getByRole('button', { name: 'Push all' })).toBeVisible();
    await expect(view.getByRole('button', { name: 'Start build' })).toHaveCount(0);
    // The agent ran the tests in the sandbox: no "Not built or tested here", no Retry.
    await expect(view.getByText('Not built or tested here.')).toHaveCount(0);

    // The diff is read only when opened.
    const api = view.locator('[data-testid="story-build-repo"][data-repo="acme/api"]');
    await api.getByTestId('story-build-diff-toggle').click();
    await expect(api.getByTestId('story-build-diff')).toContainText('csvHeader');

    await api.getByRole('button', { name: 'Push as draft' }).click();
    await expect(api).toHaveAttribute('data-status', 'pushed');
    await expect(api.getByTestId('story-build-pushed-pr')).toContainText('#77');
  });

  test('with no container runtime, the tab says so and how to set one up', async ({ page }) => {
    await withAi(page, undefined, SANDBOX_RUNTIME_NONE);
    await page.goto(`/app/?view=${encodeURIComponent(`story-build:${ACME_1}`)}`);
    const view = page.getByTestId('story-build-overlay');
    const line = view.getByTestId('sandbox-runtime-line');
    await expect(line).toHaveAttribute('data-available', 'false');
    await expect(line).toContainText('No container runtime is installed');
    await line.getByRole('button', { name: 'How to set up a container runtime' }).click();
    await expect(page.getByText('brew install colima docker')).toBeVisible();
    // The button stays (one path, owner decision Q2); a press says why in one line.
    await page.keyboard.press('Escape');
    await view.getByTestId('story-build-start-button').click();
    await expect(view.getByTestId('story-build-start-error')).toContainText('No container runtime is installed');
  });

  test('a closed session keeps its changes: Resume, and Push still works', async ({ page }) => {
    await withAi(page, STORY_SESSION_CLOSED);
    await page.goto(`/app/?view=${encodeURIComponent(`story-build:${ACME_1}`)}`);
    const view = page.getByTestId('story-build-overlay');
    await expect(view.getByTestId('story-build-status')).toContainText('The changes are kept');
    await expect(view.getByTestId('story-session-closed')).toBeVisible();
    await expect(view.getByRole('button', { name: 'Push all' })).toBeVisible();
    const resume = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/resume'));
    await view.getByRole('button', { name: 'Resume' }).click();
    await resume;
    await expect(view.getByTestId('story-session-composer')).toBeVisible();
  });

  test('Discard asks once, then ends the session', async ({ page }) => {
    await withAi(page, STORY_SESSION_READY);
    await page.goto(`/app/?view=${encodeURIComponent(`story-build:${ACME_1}`)}`);
    const view = page.getByTestId('story-build-overlay');
    await view.getByRole('button', { name: 'Discard' }).click();
    await expect(view.getByText('Stop the agent and remove the sandbox?')).toBeVisible();
    const discard = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/discard'));
    await view.locator('[data-story-build-action="discard-confirm"]').click();
    await discard;
    await expect(view.getByTestId('story-build-start')).toBeVisible();
    await expect(view.getByTestId('story-build-last')).toContainText('Discarded.');
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
    await withAi(page, STORY_SESSION_READY);
    await page.goto(`/app/?view=${encodeURIComponent(`ticket:${ACME_1}`)}`);
    const tab = page.getByTestId('ticket-tab-view');
    const open = tab.getByRole('button', { name: "Open ACME-1's build: Waiting for you" });
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

  test('a build tab URL for a ticket the board does not offer cannot start one', async ({ page }) => {
    await withAi(page);
    // ACME-9 is a ghost (outside the sprint): neither Implement nor Fill gaps.
    await page.goto(`/app/?view=${encodeURIComponent('story-build:jira:https://acme.atlassian.net#ACME-9')}`);
    await expect(page.getByTestId('story-build-not-offered')).toBeVisible();
    await expect(page.getByTestId('story-build-start-button')).toHaveCount(0);
  });
});
