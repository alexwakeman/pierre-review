import { test, expect, type Page } from '@playwright/test';
import type {
  AttentionCardsResponse,
  InsightCard,
  InsightKind,
  InsightPrRef,
  PendingAuthorSplit,
  PendingTab,
  RequestReviewersBody,
  ReviewerRoutingCard,
} from '@pierre-review/shared';
import { PENDING_TABS, pendingAuthorSideOf } from '@pierre-review/shared';
import { fixtures, installMockApi } from './mock-api.js';

// A "Needs a reviewer" card on the Pending board: ONE Assign per suggested reviewer.
//   • each row asks just its own reviewer — a synced user by id, an unsynced one by login, a team by
//     slug — and there is no "Assign all"
//   • no button where the viewer cannot push (`viewerCanPush: false`); the suggestion still shows
//   • rows are independent: two in flight at once, one's success never marks another, one's failure
//     shows its own words and offers the retry
//   • the board refetches once the LAST request on the PR lands, and a tab switch (which remounts the
//     card) keeps "Requested"
//
// This spec overrides only `/api/attention` and the request route; everything else is mock-api.ts.

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/** Every REQUIRED `InsightPrRef` field, opened by bob — a person, so the card is on the People side. */
function orphan(prId: number, number: number, title: string): InsightPrRef {
  const repo = fixtures.REPO;
  return {
    prId,
    repoId: repo.id,
    repoFullName: repo.fullName,
    prNumber: number,
    prTitle: title,
    authorId: 3,
    githubUrl: `https://github.com/${repo.fullName}/pull/${number}`,
    ciStatus: 'success',
    changedFiles: 2,
    additions: 40,
    deletions: 4,
    openedAt: iso(3),
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
}

const ALICE_REASON = 'Reviewed 3 PRs touching these files';
const CAROL_REASON = 'Owns src/upload.ts in CODEOWNERS';
const TEAM_REASON = 'Team owns src/ in CODEOWNERS';
const DAVE_REASON = 'Owns docs/ in CODEOWNERS';

const WRITABLE: ReviewerRoutingCard = {
  ...orphan(301, 91, 'Add resumable uploads'),
  id: 'route:301',
  kind: 'reviewer_routing',
  severity: 'info',
  topPaths: ['src/upload.ts'],
  viewerCanPush: true,
  suggestedReviewers: [
    { kind: 'user', login: 'alice', userId: 2, teamSlug: null, teamName: null, reason: ALICE_REASON, source: 'history' },
    { kind: 'user', login: 'carol', userId: null, teamSlug: null, teamName: null, reason: CAROL_REASON, source: 'codeowners' },
    { kind: 'team', login: null, userId: null, teamSlug: 'core', teamName: 'acme/core', reason: TEAM_REASON, source: 'codeowners' },
  ],
};

const READ_ONLY: ReviewerRoutingCard = {
  ...orphan(302, 92, 'Fix the docs index'),
  id: 'route:302',
  kind: 'reviewer_routing',
  severity: 'info',
  topPaths: ['docs/index.md'],
  viewerCanPush: false,
  suggestedReviewers: [
    { kind: 'user', login: 'dave', userId: null, teamSlug: null, teamName: null, reason: DAVE_REASON, source: 'codeowners' },
  ],
};

/** The board response: mock-api's cards plus the two routing cards, with every tab's counts rebuilt
 *  from the cards (the server's own predicate) so a count and its list always agree. */
function attentionWithRouting(): AttentionCardsResponse {
  const base = fixtures.ATTENTION;
  const cards: InsightCard[] = [...base.cards, WRITABLE, READ_ONLY];
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
    };
  });
  return { ...base, cards, tabs, users: [...base.users, ...fixtures.USERS] };
}

interface Harness {
  bodies: RequestReviewersBody[];
  boardHits: () => number;
  releaseAlice: () => void;
}

async function openWaitingOnReview(page: Page): Promise<Harness> {
  await installMockApi(page);
  // Registered AFTER installMockApi, so these win (Playwright tries the newest route first).
  let hits = 0;
  const board = attentionWithRouting();
  await page.route(
    (url) => url.pathname === '/api/attention',
    (route) => {
      hits += 1;
      return route.fulfill({ json: board });
    },
  );
  const bodies: RequestReviewersBody[] = [];
  let releaseAlice!: () => void;
  const aliceHeld = new Promise<void>((resolve) => {
    releaseAlice = resolve;
  });
  await page.route(/\/api\/prs\/\d+\/request-reviewers$/, async (route) => {
    const body = route.request().postDataJSON() as RequestReviewersBody;
    bodies.push(body);
    if (body.teamSlugs?.length) {
      return route.fulfill({
        status: 502,
        json: { error: 'GitHubError', message: 'acme/core is not a collaborator on this repository.' },
      });
    }
    if (body.userIds?.includes(2)) await aliceHeld;
    return route.fulfill({
      json: { status: 'ok', requestedLogins: body.logins ?? ['alice'] },
    });
  });

  await page.goto('/app/');
  await expect(page.getByTestId('attention-view')).toBeVisible();
  await page
    .getByRole('tablist', { name: 'Pending', exact: true })
    .getByRole('tab', { name: /^Waiting on review/ })
    .click();
  return { bodies, boardHits: () => hits, releaseAlice };
}

const row = (page: Page, reason: string) =>
  page.getByTestId('suggested-reviewer').filter({ hasText: reason });

test.describe('Pending: one Assign per suggested reviewer', () => {
  test('each row asks its own reviewer, independently, and keeps its state across a tab switch', async ({
    page,
  }) => {
    const { bodies, boardHits, releaseAlice } = await openWaitingOnReview(page);

    const assignAlice = page.getByRole('button', { name: 'Assign @alice', exact: true });
    const assignCarol = page.getByRole('button', { name: 'Assign @carol', exact: true });
    const assignTeam = page.getByRole('button', { name: 'Assign @acme/core', exact: true });
    await expect(assignAlice).toBeVisible();
    await expect(assignCarol).toBeVisible();
    await expect(assignTeam).toBeVisible();
    await expect(page.getByRole('button', { name: /Assign all/ })).toHaveCount(0);

    // A repo the viewer only reads: the suggestion shows, the button does not.
    await expect(row(page, DAVE_REASON)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assign @dave' })).toHaveCount(0);

    // Two rows in flight at once, and one's success marks only itself.
    await assignAlice.click();
    await expect(page.getByRole('button', { name: 'Assigning @alice', exact: true })).toBeDisabled();
    await assignCarol.click();
    await expect(row(page, CAROL_REASON).getByText('Requested')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assigning @alice', exact: true })).toBeVisible();
    await expect(assignTeam).toBeEnabled();

    // The last request on the PR lands: its row says so, and the board refetches.
    const before = boardHits();
    releaseAlice();
    await expect(row(page, ALICE_REASON).getByText('Requested')).toBeVisible();
    await expect.poll(boardHits).toBeGreaterThan(before);
    await expect(row(page, CAROL_REASON).getByText('Requested')).toBeVisible();

    // A failure shows GitHub's words on its own row and offers the retry.
    await assignTeam.click();
    await expect(row(page, TEAM_REASON).getByRole('alert')).toHaveText(
      'acme/core is not a collaborator on this repository.',
    );
    await expect(assignTeam).toBeEnabled();

    // A tab switch remounts the card; the state lives in the mutation cache, so it survives.
    const tabs = page.getByRole('tablist', { name: 'Pending', exact: true });
    await tabs.getByRole('tab', { name: /^Ready to land/ }).click();
    await expect(page.getByTestId('suggested-reviewer')).toHaveCount(0);
    await tabs.getByRole('tab', { name: /^Waiting on review/ }).click();
    await expect(row(page, ALICE_REASON).getByText('Requested')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assign @alice', exact: true })).toHaveCount(0);

    expect(bodies).toEqual([{ userIds: [2] }, { logins: ['carol'] }, { teamSlugs: ['core'] }]);
  });
});
