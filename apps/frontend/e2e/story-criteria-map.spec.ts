import { test, expect, type Page } from '@playwright/test';
import { fixtures, installMockApi } from './mock-api.js';
import type {
  TicketPrsResponse,
  TicketReview,
  TicketReviewMember,
  TicketReviewStatesResponse,
  TicketSequenceDiagramResponse,
  WorkspaceTrackerSettings,
} from '@pierre-review/shared';

// THE STORY VIEW'S CRITERIA MAP ("How the code meets each criterion", docs/FRONTEND.md § The story view →
// The criteria map) and A ONE-PR TICKET'S DESIGN (§ Design diagrams). Both draw from stored reads only:
// the ticket review already loaded (its criteria + each member's card at its current commit) and the
// PR's own design read.

const MAP_IDENT = 'jira:https://acme.atlassian.net#ACME-4';
const SOLO_IDENT = 'jira:https://acme.atlassian.net#ACME-5';
const [P1, P2, P3] = [fixtures.PRS[0]!, fixtures.PRS[1]!, fixtures.PRS[2]!];
const HEAD = 'a'.repeat(40);

const card = (criteria: Array<{ criterion: string; how: string; files: string[] }>): TicketReviewMember['card'] => ({
  summary: 'What it does.',
  interfaces: [],
  criteria,
  looseEnds: [],
  headSha: HEAD,
  source: 'story_check',
  createdAt: '2026-11-14T10:00:00.000Z',
});

const member = (prId: number, repo: string, number: number, title: string, c: TicketReviewMember['card']): TicketReviewMember => ({
  prId,
  repoId: fixtures.REPO.id,
  repo,
  number,
  title,
  headSha: HEAD,
  state: 'open',
  checkedOut: true,
  card: c,
});

/** ACME-4's story check: four criteria, three PRs — two with a current card, one pushed since. */
const MAP_CHECK: TicketReview = {
  id: 502,
  ident: MAP_IDENT,
  ticketKey: 'ACME-4',
  ticketTitle: 'Export a report as CSV',
  ticket: null,
  workspaceId: fixtures.WORKSPACE.id,
  originPrId: P1.id,
  trigger: 'manual',
  status: 'succeeded',
  model: 'claude-opus-5-5',
  costUsd: 0.4,
  error: null,
  refused: null,
  createdAt: '2026-11-14T09:58:00.000Z',
  startedAt: '2026-11-14T09:58:00.000Z',
  completedAt: '2026-11-14T10:00:00.000Z',
  alignment: 'partly_aligned',
  summary: 'The button and the file are there. Large reports do not stream yet.',
  assessment: {
    alignment: 'partly_aligned',
    summary: 'The button and the file are there. Large reports do not stream yet.',
    criteria: [
      { ref: 'AC1', index: 0, text: 'A Download CSV button on the report', status: 'met', explanation: null, deliveredBy: [P2.id], evidence: [], expectedIn: null },
      { ref: 'AC2', index: 1, text: 'The file has one row per report row, in table order', status: 'met', explanation: null, deliveredBy: [P1.id], evidence: [], expectedIn: null },
      { ref: 'AC3', index: 2, text: 'Large reports stream to the browser', status: 'partly_met', explanation: 'The route buffers the whole file first.', deliveredBy: [P1.id], evidence: [], expectedIn: null },
      { ref: 'AC4', index: 3, text: 'The export is recorded in the audit log', status: 'not_met', explanation: null, deliveredBy: [], evidence: [], expectedIn: null },
    ],
    missing: [],
    notRequested: [],
  },
  members: [
    member(P1.id, 'acme/api', P1.number, 'ACME-4 Add the CSV export route', card([
      { criterion: 'AC2', how: 'GET /reports/:id/export.csv writes one line per row, in column order.', files: ['src/reports/export.ts', 'src/reports/csv.ts'] },
      { criterion: 'Large reports stream to the browser', how: 'Sets a chunked response, but builds the whole file first.', files: ['src/reports/export.ts'] },
    ])),
    member(P2.id, 'acme/web', P2.number, 'ACME-4 Download button', card([
      { criterion: 'Download CSV button on the report', how: 'Adds the button to the report toolbar; it calls the export route.', files: ['web/src/ReportToolbar.tsx'] },
    ])),
    // Pushed since its card: the server sends none.
    member(P3.id, 'acme/api', P3.number, 'ACME-4 Audit hooks', null),
  ],
  items: [],
};

function ticketPrs(ident: string): TicketPrsResponse {
  const solo = ident === SOLO_IDENT;
  return {
    workspaceId: fixtures.WORKSPACE.id,
    ident,
    found: true,
    ticket: {
      key: solo ? 'ACME-5' : 'ACME-4',
      title: solo ? 'Rates import' : 'Export a report as CSV',
      url: `https://acme.atlassian.net/browse/${solo ? 'ACME-5' : 'ACME-4'}`,
      provider: 'jira',
      status: { name: 'In Progress', category: 'indeterminate' },
    },
    open: solo ? [P1] : [P1, P2, P3],
    merged: [],
    closed: [],
    outsideWorkspace: 0,
    truncated: false,
  };
}

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function withAi(page: Page): Promise<void> {
  await installMockApi(page);
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route((u) => u.pathname.endsWith('/api/me'), (r) => r.fulfill(json(me)));
  await page.route(
    (u) => u.pathname.endsWith('/api/ticket-prs'),
    (r) => r.fulfill(json(ticketPrs(new URL(r.request().url()).searchParams.get('ident') ?? ''))),
  );
  const states: TicketReviewStatesResponse = {
    states: [
      {
        ident: MAP_IDENT,
        status: 'current',
        staleBecause: [],
        changedPrIds: [],
        latestRunId: MAP_CHECK.id,
        runningRunId: null,
        alignment: 'partly_aligned',
        counts: { met: 2, partlyMet: 1, notMet: 1, unclear: 0, notChecked: 0, total: 4 },
        memberCount: 3,
        checkedAt: MAP_CHECK.completedAt,
        autoCheck: { status: 'up_to_date', reason: null, startsAt: null, lastChange: null },
      },
    ],
  };
  await page.route((u) => u.pathname.endsWith('/api/ticket-reviews/states'), (r) => r.fulfill(json(states)));
  // A Jira tracker, so the story view reads the ticket's check state.
  const tracker: WorkspaceTrackerSettings = {
    workspaceId: fixtures.WORKSPACE.id,
    issue: { provider: 'jira', baseUrl: 'https://acme.atlassian.net', projectKeys: ['ACME'], matchScope: 'title_branch' },
    jira: { email: null, hasToken: false },
    providerChosen: true,
    githubIssuesRepos: [],
  };
  await page.route((u) => /\/api\/workspaces\/\d+\/tracker$/.test(u.pathname), (r) => r.fulfill(json(tracker)));
  await page.route((u) => u.pathname.endsWith(`/api/ticket-reviews/${MAP_CHECK.id}`), (r) => r.fulfill(json(MAP_CHECK)));
  await page.route(
    (u) => u.pathname.endsWith('/api/sequence-diagrams/story'),
    (r) => {
      const ident = new URL(r.request().url()).searchParams.get('ident') ?? '';
      const solo = ident === SOLO_IDENT;
      const body: TicketSequenceDiagramResponse = {
        ident,
        ticketKey: solo ? 'ACME-5' : 'ACME-4',
        memberCount: solo ? 1 : 3,
        soloPr: solo ? { prId: P1.id, repo: 'acme/api', number: P1.number, title: P1.title, state: 'open', headSha: HEAD } : null,
        diagram: null,
        latest: null,
      };
      return r.fulfill(json(body));
    },
  );
}

const storyUrl = (ident: string) => `/app/?view=${encodeURIComponent(`ticket:${ident}`)}`;

test.describe('the criteria map', () => {
  test('joins each criterion to the PRs whose description claims it, and names the rest', async ({ page }) => {
    await withAi(page);
    await page.goto(storyUrl(MAP_IDENT));
    const map = page.getByTestId('criteria-map');
    await expect(map.getByRole('heading', { name: 'How the code meets each criterion' })).toBeVisible();
    // Wide: two columns joined by one line per link (AC1→web, AC2→api, AC3→api).
    await expect(map.locator('[data-layout="columns"]')).toBeVisible();
    await expect(map.getByTestId('criteria-map-lines').locator('path')).toHaveCount(3);
    // AC4: no card claims it — said, never hidden.
    const ac4 = map.locator('[data-map-criterion="AC4"]');
    await expect(ac4).toContainText('No pull request claims this.');
    await expect(ac4).toContainText('Not met');
    // The PR pushed since its card carries no line and says why.
    await expect(map.locator(`[data-map-pr="${P3.id}"]`)).toContainText('No description at its current commit.');
    // A link's files open on a click.
    const ac2 = map.locator('[data-map-criterion="AC2"]');
    await ac2.getByRole('button', { name: /2 files/ }).click();
    await expect(ac2.getByRole('button', { name: 'src/reports/csv.ts' })).toBeVisible();
    // The ⓘ says once what the cards are.
    await map.getByRole('button', { name: 'About “How the code meets each criterion”' }).click();
    await expect(page.getByText(/AI writes each description/)).toBeVisible();
  });

  test('stacks at phone width, each link naming its PR in words', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await withAi(page);
    await page.goto(storyUrl(MAP_IDENT));
    const map = page.getByTestId('criteria-map');
    await expect(map.locator('[data-layout="stacked"]')).toBeVisible();
    await expect(map.getByTestId('criteria-map-lines')).toHaveCount(0);
    await expect(map.locator('[data-map-criterion="AC1"]')).toContainText(`web#${P2.number}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("a one-PR ticket's design", () => {
  test("shows that pull request's own design, with its Redraw", async ({ page }) => {
    await withAi(page);
    await page.goto(storyUrl(SOLO_IDENT));
    const design = page.getByTestId('story-design');
    await expect(design).toHaveAttribute('data-story-design', 'pr');
    await expect(design.getByRole('heading', { name: 'Pull request design' })).toBeVisible();
    await expect(design).toContainText(`api#${P1.number}`);
    await expect(design).toContainText('Rate import');
    const redraw = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/prs/${P1.id}/sequence-diagrams/redraw`));
    await page.getByRole('button', { name: 'Redraw design' }).click();
    await redraw;
  });
});
