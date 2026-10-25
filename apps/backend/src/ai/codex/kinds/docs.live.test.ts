// THE OPT-IN LIVE TEST for Phase 3 stream (d) on Codex. SKIPPED unless LIMN_CODEX_LIVE=1.
//
//   LIMN_CODEX_LIVE=1 [LIMN_CODEX_LIVE_BIN=/path/to/codex] \
//   ./node_modules/.bin/vitest run src/ai/codex/kinds/docs.live.test.ts
//
// ⚠ LIMN'S OWN CODEX HOME ONLY (~/.limn/codex, the `limn ai login codex` sign-in) — never the reader's
// ~/.codex, and nothing here reads, copies or prints a sign-in file. No live sign-in ⇒ the runs skip.
// ⚠ TWO MODEL RUNS AT MOST (each may take its one validation retry), both on gpt-6-luna at LOW effort:
// the role's model is overridden HERE ONLY (production keeps gpt-6.1-sol for these Sonnet-role kinds).
// Both go through the ONE door — `getActiveProvider().runAgent` with LIMN_AI_PROVIDER=codex — so the
// kind allow-list, the trusted guard, the workspace MCP server and the strict result schema are real:
//   1. a design diagram over a two-file checkout: the answer passes validateDesign;
//   2. a 'sections' docs build over two section files: ONE answer, judged by judgeRecord + judgeFinish.
// No ledger row is written (no `usageRecord`: the ledger needs the database).
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LIVE = process.env.LIMN_CODEX_LIVE === '1';

describe.skipIf(!LIVE)('stream (d) on Codex, live (LIMN_CODEX_LIVE=1)', () => {
  let dir = '';
  let signedIn = false;
  const saved = { provider: process.env.LIMN_AI_PROVIDER, db: process.env.DATABASE_URL };

  beforeAll(async () => {
    if (process.env.LIMN_CODEX_LIVE_BIN) process.env.LIMN_CODEX_PATH = process.env.LIMN_CODEX_LIVE_BIN;
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'limn-codex-docs-live-')));
    process.env.DATABASE_URL = join(dir, 'scratch.db');
    process.env.LIMN_AI_PROVIDER = 'codex';
    const { codexHome } = await import('../home.js');
    if (existsSync(join(codexHome(), 'auth.json'))) {
      const AS = await import('../app-server.js');
      try {
        signedIn = !!(await AS.probeCodexAccount(AS.limnAppServerOptions()!)).account?.signedIn;
      } catch {
        signedIn = false;
      }
    }
    if (!signedIn) console.log(`[codex docs live] ${codexHome()} holds no live sign-in: the model runs are skipped`);
    // LIVE ONLY: the role's model and effort → gpt-6-luna at low (spike § 8: the cheap model).
    const C = await import('../../providers/codex.js');
    (C.CODEX_MODEL_FOR_ROLE as Record<string, string>).standard = 'gpt-6-luna';
    (C.CODEX_EFFORT_FOR_ROLE as Record<string, string>).standard = 'low';
  }, 60_000);

  afterAll(() => {
    if (saved.provider === undefined) delete process.env.LIMN_AI_PROVIDER;
    else process.env.LIMN_AI_PROVIDER = saved.provider;
    if (saved.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.db;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('1. a design diagram: read through the workspace server, the answer passes validateDesign (model run 1)', async (ctx) => {
    if (!signedIn) ctx.skip();
    const checkout = join(dir, 'checkout');
    mkdirSync(join(checkout, 'src'), { recursive: true });
    writeFileSync(
      join(checkout, 'src', 'import.ts'),
      "import { saveRate } from './rates.js';\n\nexport function importRows(rows: Array<{ account?: string; rate: number }>): number {\n  let saved = 0;\n  for (const r of rows) {\n    if (!r.account) continue; // reject rows with no account\n    saveRate(r.account, r.rate);\n    saved++;\n  }\n  return saved;\n}\n",
    );
    writeFileSync(
      join(checkout, 'src', 'rates.ts'),
      "const rates = new Map<string, number>();\n\nexport function saveRate(account: string, rate: number): void {\n  if (!rates.has(account)) rates.set(account, rate); // store each rate once\n}\n",
    );
    const cwd = join(dir, 'scratch');
    mkdirSync(cwd);
    const P = await import('../../../review/diagrams/prompts.js');
    const { runDiagramAgent } = await import('../../../review/diagrams/agent.js');
    const pr = {
      ref: 'PR1',
      repoFullName: 'acme/rates',
      number: 7,
      title: 'Import rates from a file',
      state: 'open' as const,
      headSha: 'abcdef1234567890',
      checkoutPath: checkout,
      changedFiles: ['src/import.ts', 'src/rates.ts'],
      diff: "diff --git a/src/import.ts b/src/import.ts\nnew file mode 100644\n+export function importRows(rows) { /* see the checkout */ }\ndiff --git a/src/rates.ts b/src/rates.ts\nnew file mode 100644\n+export function saveRate(account, rate) { /* see the checkout */ }\n",
    };
    const started = Date.now();
    const res = await runDiagramAgent({
      model: 'claude-sonnet-5',
      cwd,
      roots: [checkout],
      systemPrompt: P.prDiagramSystemPrompt(),
      prompt: P.buildPrDiagramPrompt({ pr, nonce: 'LIVE01' }),
      design: { kind: 'pr', prs: [{ ref: 'PR1', changedFiles: pr.changedFiles }] },
      applyAuthEnv: false,
      abortController: new AbortController(),
    });
    console.log('[codex docs live 1]', JSON.stringify({ ms: Date.now() - started, provider: res.provider, failure: res.failureReason ?? null, refusal: res.lastRefusal, tokens: [res.inputTokens, res.outputTokens], title: res.diagram?.title ?? null, cells: res.diagram?.design.cells.length ?? null }));
    expect(res.provider).toBe('codex');
    expect(res.diagram).not.toBeNull();
    expect(res.costUsd).toBe(0);
  }, 400_000);

  it('2. a sections docs build: ONE answer, judged by judgeRecord + judgeFinish (model run 2)', async (ctx) => {
    if (!signedIn) ctx.skip();
    const staging = join(dir, 'staging');
    const sectionsDir = join(staging, 'sections');
    mkdirSync(sectionsDir, { recursive: true });
    const files = ['001-plans.md', '002-refunds.md'];
    writeFileSync(join(sectionsDir, files[0]!), '# Plans\n\nThe Team plan costs 20 euros per seat per month and is billed on the first day of each month.\n');
    writeFileSync(join(sectionsDir, files[1]!), '# Refunds\n\nRefunds are due within 14 days of a request. A partial refund needs a manager\'s approval.\n');
    const DP = await import('../../../reference-docs/prompts.js');
    const { runBuildAgent } = await import('../../../reference-docs/agent.js');
    const started = Date.now();
    const res = await runBuildAgent({
      mode: 'sections',
      cwd: staging,
      sectionsDir,
      expected: files,
      systemPrompt: DP.buildSectionsSystemPrompt(),
      prompt: DP.buildSectionsPrompt(
        { title: 'Billing', sourceName: 'billing.md', sourceKind: 'markdown' },
        [
          { title: 'Plans', trail: [], body: '', words: 18, depth: 1 } as never,
          { title: 'Refunds', trail: [], body: '', words: 17, depth: 1 } as never,
        ],
        files,
        'LIVE02',
      ),
      applyAuthEnv: false,
      abortController: new AbortController(),
    });
    console.log('[codex docs live 2]', JSON.stringify({ ms: Date.now() - started, provider: res.provider, failure: res.failureReason ?? null, tokens: [res.inputTokens, res.outputTokens], finish: res.finish, recorded: [...res.state.recorded.entries()] }));
    expect(res.provider).toBe('codex');
    expect(res.finish).not.toBeNull();
    expect([...res.state.recorded.keys()].sort()).toEqual(files);
  }, 400_000);
});

describe('stream (d) on Codex, live', () => {
  it('is skipped unless LIMN_CODEX_LIVE=1', () => {
    expect(true).toBe(true);
  });
});
