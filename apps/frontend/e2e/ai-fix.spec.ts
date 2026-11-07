import { test, expect, type Page } from '@playwright/test';
import type { AiFix, SandboxRuntimeStatus } from '@pierre-review/shared';
import { aiFixBuilt, fixtures, installMockApi, SANDBOX_RUNTIME_NONE } from './mock-api.js';

// AI FIX ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions; docs/FRONTEND.md § The AI Fix tab)
// against the mocked API (mock-api.ts keeps the PR's fix per page). The picker stays; Start fix boots the
// session and runs the fix at once (the mock answers with the finished first build turn); the reader sees
// the conversation and the rail (What to fix, Repositories: only the PR's repository is pushed), asks
// for more in the same session, and pushes to the PR's branch. Plan first opens the session in chat mode
// and waits for Start fix. With no container runtime the picker stays and the run row is one line.

const PR_ID = fixtures.PRS[0]!.id;

async function openAiFix(page: Page, o: { aiFix?: AiFix | null; runtime?: SandboxRuntimeStatus } = {}): Promise<void> {
  await installMockApi(page, { aiFix: o.aiFix ?? null, ...(o.runtime != null ? { runtime: o.runtime } : {}) });
  const me = { ...fixtures.ME_RESPONSE, ai: { ...fixtures.ME_RESPONSE.ai, enabled: true } };
  await page.route(
    (u) => u.pathname.endsWith('/api/me'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  await page.goto(`/app/?view=pr-detail:${PR_ID}&prTab=ai_fix`);
}

test.describe('AI Fix in the sandbox', () => {
  test('Start fix runs at once in the session; follow up, then push to the PR branch', async ({ page }) => {
    await openAiFix(page);
    const start = page.locator('[data-ai-fix-action="start"]');
    await expect(start).toHaveText('Start fix');
    await expect(page.getByText('test: csv.spec.ts fails on an empty report')).toBeVisible();
    await start.click();

    const session = page.getByTestId('fix-session');
    await expect(session).toBeVisible();
    await expect(page.getByTestId('ai-fix-session-status')).toContainText('Fixed. Review the changes and push them, or ask for more.');
    await expect(page.getByTestId('fix-session-conversation')).toContainText('Ran npm test: 42 passed');
    await expect(page.getByTestId('fix-session-conversation')).toContainText('You · Build turn');
    // The rail: what the fix was given, and which repository is pushed.
    await expect(page.getByTestId('fix-session-items')).toContainText('C1');
    const repos = page.getByTestId('fix-session-repos');
    await expect(repos.locator('[data-repo="acme/web"]')).toContainText('Pushes to feature/e2e-branch');
    await expect(repos.locator('[data-repo="acme/api"]')).toContainText('Read only. Edits here are left out.');
    await expect(page.getByTestId('fix-session-network')).toContainText('1 blocked');
    // The result under it: the report, the left-out line, the diff and Push.
    await expect(page.getByTestId('ai-fix-left-out')).toContainText('Edits in acme/api are left out. AI Fix pushes only acme/web.');
    await expect(page.getByText('Not built or tested here.')).toHaveCount(0);

    // A follow-up is one more turn in the SAME session.
    await page.getByRole('textbox', { name: 'Message the agent (it can change the code)' }).fill('Also handle a null row.');
    await page.locator('[data-ai-fix-action="send"]').click();
    await expect(page.getByTestId('fix-session-conversation')).toContainText('Also handle a null row.');
    await expect(page.getByTestId('fix-session-conversation')).toContainText('Build turn 2: Done');

    await page.getByRole('button', { name: 'Push', exact: true }).click();
    await expect(page.getByText('Pushed to')).toBeVisible();
    await expect(page.getByTestId('fix-session')).toHaveCount(0);
  });

  test('Plan first opens the session in chat mode and waits for Start fix', async ({ page }) => {
    await openAiFix(page);
    await page.getByText('Plan first', { exact: true }).click();
    const start = page.locator('[data-ai-fix-action="start"]');
    await expect(start).toHaveText('Make a plan');
    await start.click();
    await expect(page.getByTestId('ai-fix-session-status')).toContainText('The plan is ready. Talk to the agent, then press Start fix.');
    await expect(page.getByTestId('fix-session-conversation')).toContainText('C2: I will not change it');
    // No result yet: nothing changed.
    await expect(page.getByRole('button', { name: 'Push', exact: true })).toHaveCount(0);
    await page.locator('[data-ai-fix-action="build"]').click();
    await expect(page.getByTestId('ai-fix-session-status')).toContainText('Fixed.');
    await expect(page.getByRole('button', { name: 'Push', exact: true })).toBeVisible();
  });

  test('with no container runtime, the picker stays and the run row is one line with How to set up', async ({ page }) => {
    await openAiFix(page, { runtime: SANDBOX_RUNTIME_NONE });
    await expect(page.getByText('test: csv.spec.ts fails on an empty report')).toBeVisible();
    const line = page.getByTestId('ai-fix-runtime-line');
    await expect(line).toHaveAttribute('data-available', 'false');
    await expect(line).toContainText('No container runtime is installed.');
    await expect(line.getByRole('button', { name: 'How to set up a container runtime' })).toBeVisible();
    await expect(page.locator('[data-ai-fix-action="start"]')).toHaveCount(0);
  });

  test('a closed fix keeps its changes: Resume, and Discard asks once', async ({ page }) => {
    const built = aiFixBuilt(PR_ID);
    await openAiFix(page, { aiFix: { ...built, session: { ...built.session!, live: false, resumable: true, agentState: null } } });
    await expect(page.getByTestId('fix-session-closed')).toContainText('The sandbox is closed.');
    await expect(page.getByRole('button', { name: 'Push', exact: true })).toBeVisible();
    await page.locator('[data-ai-fix-action="resume"]').click();
    await expect(page.getByTestId('fix-session-composer')).toBeVisible();

    await page.locator('[data-ai-fix-action="discard"]').click();
    await expect(page.getByText('Stop the agent and remove the sandbox? Nothing is pushed.')).toBeVisible();
    await page.locator('[data-ai-fix-action="discard-confirm"]').click();
    await expect(page.getByTestId('fix-session')).toHaveCount(0);
    await expect(page.getByText('The fix was stopped or discarded. Nothing was pushed.')).toBeVisible();
  });
});
