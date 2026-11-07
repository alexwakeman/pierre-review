import { test, expect, type Page } from '@playwright/test';
import type { AiFix, AiFixPickerPreview, SandboxRuntimeStatus } from '@pierre-review/shared';
import { AI_FIX_PREVIEW_MERGE, aiFixBuilt, aiFixMerged, fixtures, installMockApi, SANDBOX_RUNTIME_NONE } from './mock-api.js';

// AI FIX ON THE WORKSPACE SESSION (docs/SANDBOX.md § AI Fix sessions; docs/FRONTEND.md § The AI Fix tab)
// against the mocked API (mock-api.ts keeps the PR's fix per page). The picker stays; Start fix boots the
// session and runs the fix at once (the mock answers with the finished first build turn); the reader sees
// the conversation and the rail (What to fix, Repositories: only the PR's repository is pushed), asks
// for more in the same session, and pushes to the PR's branch. Plan first opens the session in chat mode
// and waits for Start fix. With no container runtime the picker stays and the run row is one line.

const PR_ID = fixtures.PRS[0]!.id;

async function openAiFix(
  page: Page,
  o: { aiFix?: AiFix | null; runtime?: SandboxRuntimeStatus; preview?: AiFixPickerPreview; onStart?: (prId: number) => AiFix } = {},
): Promise<void> {
  await installMockApi(page, {
    aiFix: o.aiFix ?? null,
    ...(o.runtime != null ? { runtime: o.runtime } : {}),
    ...(o.preview != null ? { aiFixPreview: o.preview } : {}),
    ...(o.onStart != null ? { aiFixOnStart: o.onStart } : {}),
  });
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

  test('a conflicting PR: the merge item is ticked first; the result shows the checked merge apart from the fix', async ({ page }) => {
    await openAiFix(page, { preview: AI_FIX_PREVIEW_MERGE, onStart: (id) => aiFixMerged(id) });
    const mergeRow = page.getByRole('region', { name: 'Merge conflicts' });
    await expect(mergeRow).toContainText('Resolve merge conflicts with main');
    await expect(mergeRow.getByRole('checkbox')).toBeChecked();
    await expect(page.getByText('3 items')).toBeVisible();
    // The old separate conflict run is gone: no "Also resolve" box.
    await expect(page.getByText(/Also resolve merge conflicts/)).toHaveCount(0);
    const startReq = page.waitForRequest((r) => r.url().endsWith(`/api/pro/prs/${PR_ID}/ai-fix`) && r.method() === 'POST');
    await page.locator('[data-ai-fix-action="start"]').click();
    expect((await startReq).postDataJSON().include).toEqual(['conflict:merge', 'ci:1', 'ci:2']);

    const merge = page.getByTestId('ai-fix-merge');
    await expect(merge).toHaveAttribute('data-merge-status', 'valid');
    await expect(page.getByTestId('ai-fix-merge-check')).toContainText('Its parents are the PR head (ddddddd) and main (eeeeeee).');
    await expect(page.getByTestId('ai-fix-resolution')).toContainText('How the conflicts were resolved');
    await expect(page.getByTestId('ai-fix-resolution')).toContainText('the API caps it at 100');
    await expect(page.getByTestId('ai-fix-changes')).toContainText('Fixes on top of the merge');
    await expect(page.getByTestId('fix-session-repos').locator('[data-repo="acme/web"]')).toContainText('main merged · 1 file changed');
    // A fix with the merge pushes only to the PR's own branch.
    await expect(page.getByText('New branch + open a PR')).toHaveCount(0);
    const pushReq = page.waitForRequest((r) => r.url().endsWith('/push') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Push', exact: true }).click();
    expect((await pushReq).postDataJSON().target).toBe('existing');
    await expect(page.getByText('Pushed to')).toBeVisible();
  });

  test('a merge that fails Limn’s check offers no Push and says why', async ({ page }) => {
    await openAiFix(page, { aiFix: aiFixMerged(PR_ID, 'invalid') });
    await expect(page.getByTestId('ai-fix-merge')).toHaveAttribute('data-merge-status', 'invalid');
    await expect(page.getByTestId('ai-fix-merge-check')).toContainText('Nothing will be pushed: conflict markers are left in src/reports/limits.ts.');
    await expect(page.getByTestId('ai-fix-session-status')).toContainText('The merge did not pass Limn’s check, so nothing can be pushed.');
    await expect(page.getByRole('button', { name: 'Push', exact: true })).toHaveCount(0);
  });
});
