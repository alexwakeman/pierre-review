// THE OPT-IN LIVE TEST for the review stream on Codex (docs/CODEX-PLAN.md Phase 3, stream a). SKIPPED
// unless LIMN_CODEX_LIVE=1.
//
//   LIMN_CODEX_LIVE=1 \
//   [LIMN_CODEX_LIVE_BIN=/path/to/codex]   (else Limn's install / LIMN_CODEX_PATH) \
//   ./node_modules/.bin/vitest run src/review/codex-review-live.test.ts
//
// ⚠ LIMN'S OWN CODEX HOME ONLY (~/.limn/codex, the `limn ai login codex` sign-in) — never ~/.codex;
// nothing here reads, copies or prints a sign-in file. With no live sign-in the runs are SKIPPED.
// ⚠ TWO model runs, gpt-6-luna at LOW effort (the live override, `_setCodexReviewModelForTest` — a
// production run keeps the review's own role and depth):
//   1. Claude Review, DIFF-ONLY, through `runReview` with the REAL prompts (systemPromptForMode +
//      buildUserPrompt) in Codex's words: the strict submit_review schema is accepted (within the one
//      retry), the answer goes through the same anchoring, and one Codex ledger row is written.
//   2. Check threads, WITH A CHECKOUT, through `runThreadCheckAgent`: the model reads the file through
//      the workspace MCP server and judges the one thread by its ref.
// The ledger is mocked (no database is written).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const LIVE = process.env.LIMN_CODEX_LIVE === '1';
const recorded = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-live-db-')), 'db.sqlite');
  return [] as unknown[];
});
vi.mock('../db/usage.js', () => ({
  recordAiUsage: async (row: unknown) => {
    recorded.push(row);
  },
}));

describe.skipIf(!LIVE)('the review stream on Codex, live (LIMN_CODEX_LIVE=1)', () => {
  let signedIn = false;
  let dir = '';
  const saved = process.env.LIMN_AI_PROVIDER;

  beforeAll(async () => {
    if (process.env.LIMN_CODEX_LIVE_BIN) process.env.LIMN_CODEX_PATH = process.env.LIMN_CODEX_LIVE_BIN;
    process.env.LIMN_AI_PROVIDER = 'codex';
    const { codexHome } = await import('../ai/codex/home.js');
    const { existsSync } = await import('node:fs');
    if (existsSync(join(codexHome(), 'auth.json'))) {
      const AS = await import('../ai/codex/app-server.js');
      try {
        signedIn = !!(await AS.probeCodexAccount(AS.limnAppServerOptions()!)).account?.signedIn;
      } catch {
        signedIn = false;
      }
    }
    if (!signedIn) console.log(`[codex review live] ${codexHome()} holds no live sign-in: the runs are skipped`);
    const { _setCodexReviewModelForTest } = await import('./codex-review.js');
    _setCodexReviewModelForTest({ model: 'gpt-6-luna', effort: 'low' });
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'limn-codex-review-live-')));
    mkdirSync(join(dir, 'repo', 'src'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'src', 'math.ts'), 'export const divide = (a: number, b: number) => a / b;\n');
  }, 60_000);

  afterAll(async () => {
    const { _setCodexReviewModelForTest } = await import('./codex-review.js');
    _setCodexReviewModelForTest(null);
    if (saved === undefined) delete process.env.LIMN_AI_PROVIDER;
    else process.env.LIMN_AI_PROVIDER = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('1. Claude Review, diff-only, on Codex: the strict schema, the same anchoring, one ledger row', async (ctx) => {
    if (!signedIn) ctx.skip();
    const { runReview } = await import('./agent.js');
    const { buildUserPrompt, systemPromptForMode } = await import('./claude-review/prompts.js');
    const diff =
      'diff --git a/src/math.ts b/src/math.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/math.ts\n@@ -0,0 +1,2 @@\n+// Returns the average of the values.\n+export const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;\n';
    const prompt = buildUserPrompt({
      repoFullName: 'acme/api',
      prNumber: 1,
      title: 'Add average()',
      body: 'Adds a helper.',
      headSha: 'a'.repeat(40),
      baseRef: 'main',
      changedFiles: ['src/math.ts'],
      excludedFiles: [],
      diff,
      mode: 'diff_only',
    });
    const res = await runReview({
      owner: 'acme',
      name: 'api',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      model: 'claude-sonnet-5',
      mode: 'diff_only',
      systemPrompt: systemPromptForMode('diff_only'),
      prompt,
      strippedDiff: diff,
      applyAuthEnv: false,
      abortController: new AbortController(),
      onProgress: () => {},
      usage: { accountId: 1, prId: 1 },
    });
    console.log('[live review]', JSON.stringify({ submitted: res.submitted, failureReason: res.failureReason, verdict: res.verdict, findings: res.findings.length, summary: res.summary.slice(0, 200), inputTokens: res.inputTokens }));
    expect(res.submitted).toBe(true);
    expect(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).toContain(res.verdict);
    expect(res.usageRecorded).toBe(true);
    expect(res.inputTokens).toBeGreaterThan(0);
    for (const f of res.findings) expect(f.path).toBe('src/math.ts');
    expect(recorded).toEqual([expect.objectContaining({ feature: 'claude_review', provider: 'codex', model: 'gpt-6-luna' })]);
  }, 300_000);

  it('2. Check threads with a checkout, on Codex: MCP reads, the thread judged by its ref', async (ctx) => {
    if (!signedIn) ctx.skip();
    const { runThreadCheckAgent } = await import('./claude-review/thread-check-agent.js');
    const { THREAD_CHECK_SYSTEM_PROMPT, buildThreadCheckPrompt } = await import('./claude-review/thread-check.js');
    const { planThreadReview } = await import('./claude-review/threads.js');
    const head = 'b'.repeat(40);
    const plan = planThreadReview(
      [
        {
          threadId: 1,
          path: 'src/math.ts',
          line: 1,
          isOutdated: false,
          derivedState: 'untouched',
          isResolved: false,
          url: null,
          comments: [{ authorLogin: 'alice', authorIsBot: false, createdAt: new Date(), body: 'divide() does not guard against b === 0.' }],
          commitsAfterFirstComment: 0,
          commitsAfterLastComment: 0,
        },
      ],
      head,
      null,
    );
    const worktree = join(dir, 'repo');
    const steps: string[] = [];
    const res = await runThreadCheckAgent({
      model: 'claude-sonnet-5',
      cwd: mkdtempSync(join(dir, 'scratch-')),
      worktrees: [worktree],
      systemPrompt: THREAD_CHECK_SYSTEM_PROMPT,
      prompt: buildThreadCheckPrompt({ repoFullName: 'acme/api', number: 1, title: 'Add divide', headSha: head, worktreePath: worktree, diff: null, plan, nonce: '0123456789abcdef' }),
      applyAuthEnv: false,
      abortController: new AbortController(),
      onProgress: (p) => steps.push(...p.recentActivity),
      usage: { accountId: 1, prId: 1, repoId: 1 },
    });
    console.log('[live threads]', JSON.stringify({ submitted: res.submitted, failureReason: res.failureReason, threads: res.threads, steps: [...new Set(steps)].slice(0, 8) }));
    expect(res.submitted).toBe(true);
    expect(res.threads?.map((t) => t.ref)).toEqual(['R1']);
    expect(res.usageRecorded).toBe(true);
  }, 300_000);
});

describe.skipIf(LIVE)('the review stream on Codex, live', () => {
  it('is skipped unless LIMN_CODEX_LIVE=1', () => {
    expect(LIVE).toBe(false);
  });
});
