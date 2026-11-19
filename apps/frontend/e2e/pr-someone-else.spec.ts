import { test, expect, type Page } from '@playwright/test';
import type { PrDetail, RequestReviewersBody, SuggestedReviewersResponse } from '@pierre-review/shared';
import { installMockApi, prDetailFor } from './mock-api.js';

// THE PR PANE'S "SOMEONE ELSE" PICKER (docs/FRONTEND.md § The "Someone else" picker):
//   • the link shows on an open PR the reader can push to, and nothing is fetched until it is opened
//   • typing filters the dropdown; picked people become removable chips
//   • "Request review" sends ONE request per person: GitHub refusing one (a 422) lands on that
//     person's chip, the other is asked, and a sent chip is never offered again
//   • the picker keeps its chips when a request empties the Suggested row (one tree slot)
//   • no link where the reader cannot push (hide, never disable)

const PR_ID = 101;
const BOB_REFUSAL = '@bob can’t be asked to review: they don’t have access to acme/web.';

interface Harness {
  bodies: RequestReviewersBody[];
  peopleHits: () => number;
}

async function setup(
  page: Page,
  { canPush, suggestAlice = false }: { canPush: boolean; suggestAlice?: boolean },
): Promise<Harness> {
  await installMockApi(page);
  const detail: PrDetail = { ...prDetailFor(PR_ID), state: 'open', viewerCanPush: canPush, authorId: 1 };
  // Like the server: Suggested lists @alice until anyone is requested, then empties; the refetched
  // detail lists her on Requested.
  let aliceAsked = false;
  if (suggestAlice) {
    await page.route(
      (u) => u.pathname === `/api/prs/${PR_ID}/suggested-reviewers`,
      (r) => {
        const body: SuggestedReviewersResponse = aliceAsked
          ? { suggestedReviewers: [], users: [] }
          : {
              suggestedReviewers: [
                { kind: 'user', login: 'alice', userId: 2, teamSlug: null, teamName: null, reason: 'reviewed here', source: 'history' },
              ],
              users: [],
            };
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      },
    );
  }
  await page.route(
    (u) => u.pathname === `/api/prs/${PR_ID}`,
    (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(aliceAsked ? { ...detail, requestedReviewers: [{ userId: 2, teamName: null }] } : detail),
      }),
  );
  let hits = 0;
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === `/api/prs/${PR_ID}/askable-people`) hits += 1;
  });
  const bodies: RequestReviewersBody[] = [];
  await page.route(/\/api\/prs\/\d+\/request-reviewers$/, async (route) => {
    const body = route.request().postDataJSON() as RequestReviewersBody;
    bodies.push(body);
    if (body.userIds?.includes(3)) {
      return route.fulfill({ status: 422, json: { error: 'ReviewerRefused', message: BOB_REFUSAL } });
    }
    if (body.userIds?.includes(2)) aliceAsked = true;
    return route.fulfill({ json: { status: 'ok', requestedLogins: ['alice'] } });
  });
  await page.goto(`/app/?view=pr-detail:${PR_ID}`);
  return { bodies, peopleHits: () => hits };
}

const chip = (page: Page, login: string) =>
  page.getByTestId('picked-reviewer').filter({ hasText: `@${login}` });

test.describe('PR Overview: Someone else', () => {
  test('picks two people, asks each on their own, and shows a refusal on its chip', async ({ page }) => {
    const { bodies, peopleHits } = await setup(page, { canPush: true });
    const link = page.getByTestId('someone-else');
    await expect(link).toBeVisible();
    expect(peopleHits()).toBe(0);

    await link.click();
    const box = page.getByRole('combobox', { name: 'Find someone to ask for a review' });
    await expect(box).toBeFocused();
    await expect(page.getByRole('option')).toHaveCount(2);
    expect(peopleHits()).toBe(1);

    // Typing filters; a pick becomes a chip and leaves the dropdown.
    await box.fill('ali');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: /@alice/ }).click();
    await expect(chip(page, 'alice')).toBeVisible();
    await box.fill('');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: /@bob/ }).click();

    // A chip can be removed before it is sent.
    await page.getByRole('button', { name: 'Remove @bob' }).click();
    await expect(chip(page, 'bob')).toHaveCount(0);
    await box.fill('bo');
    await box.press('Enter');
    await expect(chip(page, 'bob')).toBeVisible();

    await page.getByRole('button', { name: 'Request review', exact: true }).click();
    await expect(chip(page, 'alice').getByRole('status')).toHaveText('Asked');
    await expect(chip(page, 'bob').getByRole('alert')).toHaveText(BOB_REFUSAL);
    // Every chip was sent: no second press, no retry.
    await expect(page.getByRole('button', { name: 'Request review', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();

    expect(bodies).toEqual([{ userIds: [2] }, { userIds: [3] }]);
  });

  test('keeps both outcomes when the request empties the Suggested row', async ({ page }) => {
    const { bodies } = await setup(page, { canPush: true, suggestAlice: true });
    await expect(page.getByText('reviewed here')).toBeVisible();
    await page.getByTestId('someone-else').click();
    const box = page.getByRole('combobox', { name: 'Find someone to ask for a review' });
    await box.fill('ali');
    await box.press('Enter');
    await box.fill('bo');
    await box.press('Enter');
    await page.getByRole('button', { name: 'Request review', exact: true }).click();

    // Suggested goes away (alice is now requested) — the picker stays open with both outcomes.
    await expect(page.getByText('reviewed here')).toHaveCount(0);
    await expect(chip(page, 'alice').getByRole('status')).toHaveText('Asked');
    await expect(chip(page, 'bob').getByRole('alert')).toHaveText(BOB_REFUSAL);
    expect(bodies).toEqual([{ userIds: [2] }, { userIds: [3] }]);
  });

  test('no link where the reader cannot push', async ({ page }) => {
    const { peopleHits } = await setup(page, { canPush: false });
    await expect(page.getByRole('tablist', { name: `Pull request #${PR_ID} tabs` })).toBeVisible();
    await expect(page.getByTestId('someone-else')).toHaveCount(0);
    expect(peopleHits()).toBe(0);
  });
});
