// PHASE 3 STREAM (d) ON CODEX, OFFLINE (docs/CODEX-PLAN.md § 5): design diagrams, sprint critical paths,
// the docs build and the docs chat run through the ACTIVE provider's `runAgent` with
// LIMN_AI_PROVIDER=codex. A FAKE `codex` (a node script) plays recorded-shape JSONL streams
// (ai/codex/__fixtures__/docs/), in order, one per `codex exec`, and logs each argv, stdin and schema
// file. Limn's Codex home, the hook's trust check, the workspace MCP config, the app-server, the thread
// cleanup and the ledger are mocked (their own suites cover them). What is pinned, per kind:
//   • success: the strict schema of the run's result tool on disk (`--output-schema`), Codex's model for
//     the role, the Codex wording of the system prompt, the read roots EXACTLY as the Claude path guard
//     allows them (and no write root), the answer handed to the SAME handler (so validateDesign /
//     validateSprintPaths / judgeRecord + judgeFinish judge it), and ONE ledger row written by the
//     provider as Codex (US$ 0 on a ChatGPT sign-in, its tokens) — never a second, Claude-named row;
//   • a refused answer (a schema issue, a validator refusal) gets ONE retry on the thread (`exec resume`)
//     whose prompt carries the reason in Codex's words, and the run then succeeds;
//   • cancellation: aborted, null tokens recorded, nothing accepted;
//   • the budget gate: over budget, an automatic run starts nothing on Codex either;
//   • ⚠ Claude's prompts are BYTE-IDENTICAL (pinned by hash, taken before the port).
//
//   pnpm --filter @pierre-review/backend test ai/codex/kinds/docs
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-docs-kinds-'));
  // Never the real database: any module that opens one opens this scratch file.
  process.env.DATABASE_URL = path.join(root, 'scratch.db');
  return {
    root,
    home: path.join(root, 'codex-home'),
    bin: path.join(root, 'fake-codex.mjs'),
    log: path.join(root, 'calls.jsonl'),
    recorded: [] as any[],
    trustWrites: [] as any[],
  };
});

vi.mock('../home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../home.js')>()),
  codexBinary: async () => T.bin,
  codexHome: () => T.home,
  ensureCodexHomeConfig: async (hook: unknown) => {
    T.trustWrites.push(hook);
  },
}));
vi.mock('../hook.js', () => ({
  pathGuardHook: (roots: { read: string[]; write: string[] }) => ({
    override: 'hooks.PreToolUse=[{matcher=".*", hooks=[{type="command", command="/limn/guard", timeout=30}]}]',
    matcher: '.*',
    command: '/limn/guard',
    timeoutSec: 30,
    trustKey: '/<session-flags>/config.toml:pre_tool_use:0:0',
    trustedHash: 'sha256:test',
    env: { LIMN_CODEX_GUARD: JSON.stringify(roots) },
  }),
  verifyHookTrusted: async () => true,
}));
vi.mock('../workspace-mcp.js', () => ({
  workspaceMcpConfig: (roots: { read: string[] }) => ({
    id: 'workspace',
    command: '/usr/bin/node',
    args: ['/limn/mcp.js', ...roots.read],
    env: {},
    default_tools_approval_mode: 'approve',
  }),
}));
vi.mock('../app-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-server.js')>()),
  codexSignedInCached: () => ({ signedIn: true, type: 'chatgpt', plan: 'plus' }),
  confirmCodexAccount: async () => {},
  recheckCodexAccount: async () => {},
}));
vi.mock('../threads.js', () => ({
  armCodexThreadSweeps: () => {},
  queueCodexThreadCleanup: () => {},
}));
vi.mock('../../../db/usage.js', () => ({
  recordAiUsage: async (row: unknown) => {
    T.recorded.push(row);
  },
}));

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'docs');

// The fake `codex exec`: plays the NEXT fixture of its sidecar's `plays` list (a counter file keeps the
// place), with its thread id; a fixture named `hang…` keeps the turn open until SIGTERM.
const FAKE = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const at = (f) => argv[argv.indexOf(f) + 1];
const schemaFile = argv.includes('--output-schema') ? at('--output-schema') : null;
const side = JSON.parse(readFileSync(${JSON.stringify(T.bin)} + '.json', 'utf8'));
const countFile = ${JSON.stringify(T.bin)} + '.count';
const n = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
writeFileSync(countFile, String(n + 1));
appendFileSync(${JSON.stringify(T.log)}, JSON.stringify({
  argv, stdin, schema: schemaFile ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null,
}) + '\\n');
const name = side.plays[n];
const lines = readFileSync(${JSON.stringify(FIXTURES)} + '/' + name, 'utf8').split('\\n').filter(Boolean);
for (const l of lines) process.stdout.write(l.replace('"THREAD"', '"th-docs"') + '\\n');
if (name.startsWith('hang')) {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`;
writeFileSync(T.bin, FAKE);
chmodSync(T.bin, 0o755);

/** The fixtures the next `codex exec` calls play, in order. */
function plays(...names: string[]): void {
  writeFileSync(`${T.bin}.json`, JSON.stringify({ plays: names }));
  if (existsSync(`${T.bin}.count`)) unlinkSync(`${T.bin}.count`);
}

const calls = (): any[] =>
  existsSync(T.log)
    ? readFileSync(T.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Every `-c` value of one argv, by key. */
function cfg(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  argv.forEach((a, i) => {
    if (a === '-c') {
      const kv = argv[i + 1]!;
      m.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1));
    }
  });
  return m;
}
const model = (argv: string[]): string => argv[argv.indexOf('-m') + 1]!;
/** The guard roots the run's hook was trusted with (= what the workspace server may read). */
const guardRoots = (i = 0): { read: string[]; write: string[] } => JSON.parse(T.trustWrites[i].env.LIMN_CODEX_GUARD);

const savedProvider = process.env.LIMN_AI_PROVIDER;
const CHATGPT_AUTH = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fixture', access_token: 'fixture', refresh_token: 'fixture' } });

const P = await import('../../provider.js');
const { _resetCodexTrustCacheForTest } = await import('../../providers/codex.js');
const { resultJsonSchemas } = await import('../../result-schemas.js');
const { CODEX_DOCS_KINDS } = await import('./docs.js');
const Diag = await import('../../../review/diagrams/agent.js');
const DiagPrompts = await import('../../../review/diagrams/prompts.js');
const DiagTrigger = await import('../../../review/diagrams/trigger.js');
const Paths = await import('../../../review/sprint-paths/agent.js');
const PathsPrompt = await import('../../../review/sprint-paths/prompt.js');
const PathsManager = await import('../../../review/sprint-paths/manager.js');
const { runSprintAfterRead } = await import('../../../review/sprint-briefs/index.js');
const Docs = await import('../../../reference-docs/agent.js');
const DocsPrompts = await import('../../../reference-docs/prompts.js');

let work: string;
beforeEach(() => {
  process.env.LIMN_AI_PROVIDER = 'codex';
  mkdirSync(T.home, { recursive: true });
  writeFileSync(join(T.home, 'auth.json'), CHATGPT_AUTH);
  T.recorded.length = 0;
  T.trustWrites.length = 0;
  _resetCodexTrustCacheForTest();
  work = mkdtempSync(join(T.root, 'work-'));
});
afterEach(() => {
  if (existsSync(T.log)) unlinkSync(T.log);
  if (savedProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
  else process.env.LIMN_AI_PROVIDER = savedProvider;
});
afterAll(() => rmSync(T.root, { recursive: true, force: true }));

describe('the kinds file', () => {
  it('ports exactly this stream’s four kinds, and the provider runs them', () => {
    expect([...CODEX_DOCS_KINDS].sort()).toEqual(['diagram', 'docs_build', 'docs_chat', 'sprint_paths']);
    for (const k of CODEX_DOCS_KINDS) expect(P.codexKindReady(k)).toBe(true);
    expect(P.getActiveProvider().id).toBe('codex');
  });
});

// ---- design diagrams ------------------------------------------------------------------------------

describe('design diagrams on Codex (kind: diagram)', () => {
  const pr = {
    ref: 'PR1',
    repoFullName: 'o/r',
    number: 3,
    title: 'Rates',
    state: 'open' as const,
    headSha: 'abcdef1234567890',
    checkoutPath: '/x',
    changedFiles: ['src/import.ts', 'src/rates.ts'],
    diff: 'diff --git a/src/import.ts b/src/import.ts\n+x',
  };
  const run = (checkout: string, abortController = new AbortController(), onProgress?: (p: { recentActivity: string[] }) => void) =>
    Diag.runDiagramAgent({
      model: 'claude-sonnet-5',
      cwd: work,
      roots: [checkout],
      systemPrompt: DiagPrompts.prDiagramSystemPrompt(),
      prompt: DiagPrompts.buildPrDiagramPrompt({ pr, nonce: 'N0' }),
      design: { kind: 'pr', prs: [{ ref: 'PR1', changedFiles: pr.changedFiles }] },
      applyAuthEnv: false,
      abortController,
      usageRecord: { accountId: 7, seam: 'agent', feature: 'sequence_diagram', prId: 3 },
      ...(onProgress ? { onProgress } : {}),
    });

  it('success: the strict submit_design schema, Codex’s standard model, the Claude guard’s roots, validated, one Codex ledger row', async () => {
    plays('diagram-good.jsonl');
    const checkout = mkdtempSync(join(T.root, 'checkout-'));
    const activity: string[][] = [];
    const res = await run(checkout, new AbortController(), (p) => activity.push(p.recentActivity));
    expect(res.failureReason).toBeUndefined();
    expect(res.diagram?.title).toBe('Rate import');
    // The null `files` on an unchanged cell (strict form) reached the handler as absent.
    expect(res.diagram?.design.cells.find((c) => c.id === 'c3')?.files).toEqual([]);
    expect(res).toMatchObject({ provider: 'codex', aborted: false, costUsd: 0, inputTokens: 11000, outputTokens: 900 });

    const [call] = calls();
    expect(call.schema).toEqual((await resultJsonSchemas('submit_design')).strict);
    expect(model(call.argv)).toBe('gpt-6.1-sol');
    expect(cfg(call.argv).get('model_reasoning_effort')).toBe('"medium"');
    expect(cfg(call.argv).get('sandbox_mode')).toBe('"read-only"');
    const dev = JSON.parse(cfg(call.argv).get('developer_instructions')!);
    expect(dev).toBe(DiagPrompts.prDiagramSystemPrompt('codex'));
    expect(dev).toMatch(/You may use read_file, list_files and search\./);
    expect(dev).not.toMatch(/submit_design/);
    expect(call.stdin).toMatch(/Answer with the one JSON design\.$/);
    // Exactly the Claude path guard's roots (the scratch cwd, then the checkout), read-only.
    expect(guardRoots()).toEqual({ read: [resolve(work), resolve(checkout)], write: [] });
    // ONE ledger row, written by the provider AS CODEX.
    expect(T.recorded).toEqual([
      expect.objectContaining({ accountId: 7, feature: 'sequence_diagram', prId: 3, provider: 'codex', model: 'gpt-6.1-sol', costUsd: 0, inputTokens: 41000, outputTokens: 900 }),
    ]);
    // The read steps become activity lines; the JSON answer reads as "Submitting the design…".
    expect(activity.at(-1)).toContain('Submitting the design…');
  });

  it('a shape failure gets ONE retry on the thread, with the reason; the usage is the thread’s total, counted once', async () => {
    plays('diagram-badshape.jsonl', 'diagram-fixed.jsonl');
    const res = await run(mkdtempSync(join(T.root, 'checkout-')));
    expect(res.diagram?.title).toBe('Rate import');
    const [first, retry] = calls();
    expect(first.argv).not.toContain('resume');
    expect(retry.argv).toContain('resume');
    expect(retry.argv).toContain('th-docs');
    expect(retry.stdin).toMatch(/Limn could not accept your final answer/);
    expect(retry.stdin).toMatch(/acts/);
    expect(T.recorded).toHaveLength(1);
    expect(T.recorded[0]).toMatchObject({ provider: 'codex', inputTokens: 62000, outputTokens: 1100 });
  });

  it('a validateDesign refusal reaches the retry in Codex’s words (never "call submit_design")', async () => {
    plays('diagram-refused.jsonl', 'diagram-fixed.jsonl');
    const res = await run(mkdtempSync(join(T.root, 'checkout-')));
    expect(res.diagram?.title).toBe('Rate import');
    const retry = calls()[1];
    expect(retry.stdin).toMatch(/acts; merge stages so there are at most 4/);
    expect(retry.stdin).toMatch(/Fix every point and answer again with the whole design\./);
    expect(retry.stdin).not.toMatch(/submit_design/);
  });

  it('two refusals fail the run: nothing accepted, the refusal kept, still ONE Codex ledger row', async () => {
    plays('diagram-refused.jsonl', 'diagram-refused.jsonl');
    const res = await run(mkdtempSync(join(T.root, 'checkout-')));
    expect(res.diagram).toBeNull();
    expect(res.lastRefusal).toMatch(/acts/);
    expect(res.aborted).toBe(false);
    expect(T.recorded).toHaveLength(1);
    expect(T.recorded[0]).toMatchObject({ provider: 'codex' });
  });

  it('cancellation: aborted, nothing accepted, NULL tokens recorded', async () => {
    plays('hang.jsonl');
    const ac = new AbortController();
    const p = run(mkdtempSync(join(T.root, 'checkout-')), ac, () => ac.abort());
    const res = await p;
    expect(res).toMatchObject({ diagram: null, aborted: true, provider: 'codex' });
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', inputTokens: null, outputTokens: null, costUsd: 0 })]);
  });

  it('the budget gate: after an AUTO review over the budget, nothing is queued and Codex never starts', async () => {
    plays('diagram-good.jsonl');
    const allow = vi.fn(async () => false);
    const enqueue = vi.fn();
    const r = await DiagTrigger.maybeDrawDiagramsAfterReview(
      { aiBudget: { allowAutomaticRun: allow }, log: { warn: vi.fn() } } as any,
      { accountId: 7, prId: 3, reviewTrigger: 'auto' },
      { enabled: true, switchedOn: async () => true, enqueue } as any,
    );
    expect(r.pr).toBe('over_budget');
    expect(allow).toHaveBeenCalledWith(7, 'diagrams');
    expect(enqueue).not.toHaveBeenCalled();
    expect(calls()).toEqual([]);
  });
});

// ---- sprint critical paths ------------------------------------------------------------------------

describe('sprint critical paths on Codex (kind: sprint_paths)', () => {
  const input = {
    text: 'MAP',
    keys: ['BMD-1080', 'BMD-1081', 'BMD-1090'],
    identByKey: {},
    sprintTickets: 3,
    eligible: true,
    inputHash: 'h1',
  };
  const run = (abortController = new AbortController()) =>
    Paths.runSprintPathsAgent({
      input,
      model: 'claude-sonnet-5',
      systemPrompt: PathsPrompt.sprintPathsSystem(),
      prompt: PathsPrompt.sprintPathsPrompt(input, 'N0'),
      maxTurns: 6,
      maxBudgetUsd: 1,
      applyAuthEnv: false,
      abortController,
      usageRecord: { accountId: 7, seam: 'agent', feature: 'sprint_paths' },
    });

  it('success: the strict submit_paths schema, an EMPTY throwaway read root, validated, one Codex ledger row', async () => {
    plays('paths-good.jsonl');
    const res = await run();
    expect(res.error).toBeNull();
    expect(res.accepted?.paths[0]).toMatchObject({ tickets: ['BMD-1080', 'BMD-1081'], risk: 'high' });
    expect(res).toMatchObject({ provider: 'codex', subtype: 'success', costUsd: 0, inputTokens: 12000, outputTokens: 300 });
    const [call] = calls();
    expect(call.schema).toEqual((await resultJsonSchemas('submit_paths')).strict);
    const dev = JSON.parse(cfg(call.argv).get('developer_instructions')!);
    expect(dev).toBe(PathsPrompt.sprintPathsSystem('codex'));
    expect(dev).not.toMatch(/submit_paths/);
    expect(dev).toMatch(/NO digits/);
    // The Claude run's only root: a throwaway cwd (removed after), read-only, nothing else.
    const roots = guardRoots();
    expect(roots.write).toEqual([]);
    expect(roots.read).toHaveLength(1);
    expect(roots.read[0]).toMatch(/limn-sprint-paths-/);
    expect(existsSync(roots.read[0]!)).toBe(false);
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'sprint_paths', provider: 'codex', model: 'gpt-6.1-sol', costUsd: 0 })]);
  });

  it('the DIGIT GATE refuses a numeral; the one retry fixes it', async () => {
    plays('paths-digit.jsonl', 'paths-fixed.jsonl');
    const res = await run();
    expect(res.accepted?.paths[0]?.advice).toBe('Get the writer reviewed this week.');
    const retry = calls()[1];
    expect(retry.argv).toContain('resume');
    expect(retry.stdin).toMatch(/digit or numeral/);
    expect(retry.stdin).toMatch(/Fix every point and answer again with the whole answer\./);
  });

  it('the pass records NO second (Claude-named) row for a Codex run, and stores the validated answer', async () => {
    plays('paths-good.jsonl');
    PathsManager.resetSprintPathsPasses();
    const stored: unknown[] = [];
    const ctx = { log: { info: vi.fn(), warn: vi.fn() } as never, llm: { detectAuth: () => ({ status: 'ok' as const }) }, recordAiUsage: vi.fn(async () => undefined) };
    const r = await PathsManager.runSprintPathsPass(ctx, 7, 2, {
      aiEnabled: true,
      entitled: async () => true,
      todo: async () => input,
      row: async () => null,
      store: async (_a, _w, _h, v) => void stored.push(v),
      recordAttempt: async () => {},
      noteRun: async () => {},
      dailyCap: 12,
      applyAuthEnv: async () => false,
    });
    expect(r).toMatchObject({ state: 'done', paths: 1, costUsd: 0 });
    expect(stored).toHaveLength(1);
    expect(ctx.recordAiUsage).not.toHaveBeenCalled();
    expect(T.recorded).toEqual([expect.objectContaining({ accountId: 7, feature: 'sprint_paths', provider: 'codex' })]);
  });

  it('cancellation: nothing accepted, NULL tokens recorded', async () => {
    plays('hang.jsonl');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res = await run(ac);
    expect(res.accepted).toBeNull();
    expect(res.error).toMatch(/cancelled/i);
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', inputTokens: null, outputTokens: null })]);
  });

  it('the budget gate: a SCHEDULED read over the budget runs no pass at all', async () => {
    const order: string[] = [];
    const allow = vi.fn(async () => false);
    await runSprintAfterRead(
      { log: { warn: vi.fn() } as never, llm: { detectAuth: () => ({ status: 'ok' as const }) }, recordAiUsage: async () => undefined, aiBudget: { allowAutomaticRun: allow } } as any,
      7,
      2,
      {
        briefs: async () => (order.push('briefs'), { state: 'done', stoppedBy: null }) as any,
        themes: async () => order.push('themes') as any,
        paths: async () => order.push('paths') as any,
      },
    );
    expect(order).toEqual([]);
    expect(calls()).toEqual([]);
  });
});

// ---- the docs build -------------------------------------------------------------------------------

describe('the docs build on Codex (kind: docs_build)', () => {
  const files = ['001-introduction.md', '002-refunds.md'];
  const setup = (): { staging: string; sectionsDir: string } => {
    const staging = mkdtempSync(join(T.root, 'staging-'));
    const sectionsDir = join(staging, 'sections');
    mkdirSync(sectionsDir);
    for (const f of files) writeFileSync(join(sectionsDir, f), `# ${f}\n\nText.\n`);
    return { staging, sectionsDir };
  };
  const run = (mode: 'sections' | 'pdf', s: { staging: string; sectionsDir: string }, abortController = new AbortController()) => {
    const progress: Array<{ recorded: number; expected: number }> = [];
    const p = Docs.runBuildAgent({
      mode,
      cwd: s.staging,
      sectionsDir: s.sectionsDir,
      expected: mode === 'sections' ? files : [],
      systemPrompt: DocsPrompts.buildSectionsSystemPrompt(),
      prompt: DocsPrompts.buildSectionsPrompt(
        { title: 'Billing', sourceName: 'billing.md', sourceKind: 'markdown' },
        files.map((f) => ({ title: f, trail: [], body: 'Text.', words: 1 }) as any),
        files,
        'N0',
      ),
      applyAuthEnv: false,
      abortController,
      usageRecord: { accountId: 7, seam: 'agent', feature: 'reference_docs_build' },
      onProgress: (x) => progress.push({ recorded: x.recorded, expected: x.expected }),
    });
    return { p, progress };
  };

  it('success: ONE answer (submit_document) judged by judgeRecord + judgeFinish; the staging folder read-only', async () => {
    plays('docs-build-good.jsonl');
    const s = setup();
    const { p, progress } = run('sections', s);
    const res = await p;
    expect(res.failureReason).toBeUndefined();
    expect(res.finish).toEqual({ title: 'Billing handbook', summary: 'The billing handbook: how plans are charged and refunded.', topics: ['billing', 'refunds'] });
    expect([...res.state.recorded.keys()]).toEqual(files);
    expect(res.state.recorded.get('002-refunds.md')?.summary).toMatch(/14 days/);
    expect(res).toMatchObject({ provider: 'codex', costUsd: 0 });
    expect(progress.at(-1)).toEqual({ recorded: 2, expected: 2 });
    const [call] = calls();
    expect(call.schema).toEqual((await resultJsonSchemas('submit_document')).strict);
    // Both halves of the old two-call protocol, side by side.
    expect(Object.keys(call.schema.properties).sort()).toEqual(['sections', 'summary', 'title', 'topics']);
    const dev = JSON.parse(cfg(call.argv).get('developer_instructions')!);
    expect(dev).toBe(DocsPrompts.buildSectionsSystemPrompt('codex'));
    expect(dev).not.toMatch(/record_sections|finish_document|progress and/);
    expect(dev).toMatch(/You may use read_file, list_files and search\. You have NO write tools\./);
    expect(guardRoots()).toEqual({ read: [resolve(s.staging)], write: [] });
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'reference_docs_build', provider: 'codex', model: 'gpt-6.1-sol', costUsd: 0 })]);
  });

  it('a section left out: the finish refuses in Codex’s words, the ONE retry is the last attempt and completes it', async () => {
    plays('docs-build-missing.jsonl', 'docs-build-fixed.jsonl');
    const res = await run('sections', setup()).p;
    expect(res.finish?.title).toBe('Billing handbook');
    expect([...res.state.recorded.keys()]).toEqual(files);
    const retry = calls()[1];
    expect(retry.argv).toContain('resume');
    expect(retry.stdin).toMatch(/record summaries first for: 002-refunds\.md/);
    expect(retry.stdin).toMatch(/Then answer again with the whole answer\./);
    expect(retry.stdin).not.toMatch(/finish_document|record_sections/);
  });

  it('a first answer that records NOTHING (no finish attempt used): the retry is still the last attempt and is accepted with what it has', async () => {
    plays('docs-build-badnames.jsonl', 'docs-build-missing.jsonl');
    const res = await run('sections', setup()).p;
    expect(calls()).toHaveLength(2);
    expect(calls()[1].stdin).toMatch(/999-nope\.md/);
    expect(res.failureReason).toBeUndefined();
    expect(res.finish?.title).toBe('Billing handbook');
    expect([...res.state.recorded.keys()]).toEqual(['001-introduction.md']);
  });

  it('a first answer that fails Limn’s shape check (the handler never ran): the retry is the last attempt', async () => {
    plays('docs-build-notjson.jsonl', 'docs-build-missing.jsonl');
    const res = await run('sections', setup()).p;
    expect(calls()).toHaveLength(2);
    expect(res.failureReason).toBeUndefined();
    expect(res.finish?.title).toBe('Billing handbook');
    expect([...res.state.recorded.keys()]).toEqual(['001-introduction.md']);
  });

  it('a PDF never runs on Codex: refused with its own sentence before anything starts', async () => {
    plays('docs-build-good.jsonl');
    const res = await run('pdf', setup()).p;
    expect(res.finish).toBeNull();
    expect(res.failureReason).toBe(Docs.CODEX_PDF_MESSAGE);
    expect(calls()).toEqual([]);
    expect(T.recorded).toEqual([]);
  });

  it('cancellation: aborted, NULL tokens recorded', async () => {
    plays('hang.jsonl');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res = await run('sections', setup(), ac).p;
    expect(res).toMatchObject({ aborted: true, finish: null, provider: 'codex' });
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', inputTokens: null })]);
  });
});

// ---- the docs chat --------------------------------------------------------------------------------

describe('the docs chat on Codex (kind: docs_chat)', () => {
  const run = (lib: string, abortController = new AbortController()) =>
    Docs.runDocsChatAgent({
      cwd: lib,
      systemPrompt: DocsPrompts.chatSystemPrompt(),
      prompt: DocsPrompts.buildChatPrompt([], 'When are refunds due?', 'N0'),
      applyAuthEnv: false,
      abortController,
      usageRecord: { accountId: 7, seam: 'agent', feature: 'reference_docs_chat' },
    });

  it('the final message is the answer; no result schema; the library read-only; one Codex ledger row', async () => {
    plays('docs-chat-good.jsonl');
    const lib = mkdtempSync(join(T.root, 'library-'));
    const res = await run(lib);
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/^Refunds are due within 14 days/);
    expect(res.provider).toBe('codex');
    const [call] = calls();
    expect(call.schema).toBeNull();
    expect(call.argv).not.toContain('--output-schema');
    const dev = JSON.parse(cfg(call.argv).get('developer_instructions')!);
    expect(dev).toBe(DocsPrompts.chatSystemPrompt('codex'));
    expect(dev).toMatch(/read them with read_file, list_files and search\./);
    expect(dev).toMatch(/Search across the library/);
    expect(guardRoots()).toEqual({ read: [resolve(lib)], write: [] });
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'reference_docs_chat', provider: 'codex', costUsd: 0, inputTokens: 18000, outputTokens: 250 })]);
  });

  it('cancellation: not ok, aborted, NULL tokens recorded', async () => {
    plays('hang.jsonl');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const res = await run(mkdtempSync(join(T.root, 'library-')), ac);
    expect(res).toMatchObject({ ok: false, aborted: true });
    expect(T.recorded).toEqual([expect.objectContaining({ provider: 'codex', inputTokens: null })]);
  });
});

// ---- Claude is untouched --------------------------------------------------------------------------

describe('Claude’s prompts are BYTE-IDENTICAL to before the port', () => {
  // sha256 of each prompt as built by the code BEFORE this port (taken at ae7c8d78), over fixed inputs.
  const BEFORE: Record<string, string> = {
    PR_DIAGRAM_SYSTEM_PROMPT: 'c2cb43c804b49cf6ed2827803442fde7e38cdeb98c0f7b7e41cddd2a18aef4f6',
    STORY_DIAGRAM_SYSTEM_PROMPT: '8c24e1f5f0dec733a0f8a240ed78c009bcdda5e182d4efa95547c3ab63f22fd7',
    buildPrDiagramPrompt: '6661f36479868affbe49e0627efd3638c1729af6fa624ad7a19c80c9ea641231',
    buildStoryDiagramPrompt: '4186fd734636e2268b85c506a275e62ff696c5dcaa20194d77240538fea0c0de',
    SPRINT_PATHS_SYSTEM: 'c4ef79f37f75c5d9fad9e1c71376b810456d4fbc6a4d886038c6c0e8f68036b9',
    sprintPathsPrompt: '2bec786f635ffb21a0e0276967b7f75361b9c52e6ce8bbdc48f36960450a6f93',
    BUILD_SECTIONS_SYSTEM_PROMPT: '83a03d4446782dfd2b5afd7606d5780ebebab8b23840840f4240bf6ef9aa2fb7',
    BUILD_PDF_SYSTEM_PROMPT: 'd28d6a9679e995d54a22ededb66443540764a8155d36f9c5506644d60d8ecaf8',
    CHAT_SYSTEM_PROMPT: 'c6fbfb918a10017215469c917e1fc5f9147a40b4ebee689f6d36f518d5dc2abd',
    buildSectionsPrompt: 'e9e669b9c337734a98b08beeb40c418348d4368140260a1fb7571f952692acda',
    buildPdfPrompt: 'd5a88145eb57f45a9a4383d46cd5d86902bca3a96afdec0d386722d502c36d12',
    docsNavigationPrompt: 'f9d7e9d7824c22fee2ff8f27cdcf523ae93a96319218f65875e9a8cbf8afc440',
    buildChatPrompt: '7d2b6f41c0304fd5a821cb40c91385f575abedc078214b71ba48eed07e415ff5',
  };
  const h = (s: string): string => createHash('sha256').update(s).digest('hex');
  const pr = { ref: 'PR1', repoFullName: 'o/r', number: 3, title: 'T', state: 'open' as const, headSha: 'abcdef1234567890', checkoutPath: '/x', changedFiles: ['a.ts'], diff: 'diff --git a/a.ts b/a.ts\n+x' };
  const pathsInput = { text: 'MAP', keys: ['A-1'] } as any;
  const drafts = [{ title: 'Intro', trail: ['A'], body: 'b', words: 3 } as any];
  const built = (provider: 'claude' | undefined): Record<string, string> => ({
    PR_DIAGRAM_SYSTEM_PROMPT: provider ? DiagPrompts.prDiagramSystemPrompt(provider) : DiagPrompts.PR_DIAGRAM_SYSTEM_PROMPT,
    STORY_DIAGRAM_SYSTEM_PROMPT: provider ? DiagPrompts.storyDiagramSystemPrompt(provider) : DiagPrompts.STORY_DIAGRAM_SYSTEM_PROMPT,
    buildPrDiagramPrompt: DiagPrompts.buildPrDiagramPrompt({ pr, nonce: 'N0', ...(provider ? { provider } : {}) }),
    buildStoryDiagramPrompt: DiagPrompts.buildStoryDiagramPrompt({
      ticket: { key: 'K-1', title: 't', description: 'd' },
      prs: [pr, { ...pr, ref: 'PR2' }],
      nonce: 'N0',
      ...(provider ? { provider } : {}),
    }),
    SPRINT_PATHS_SYSTEM: provider ? PathsPrompt.sprintPathsSystem(provider) : PathsPrompt.SPRINT_PATHS_SYSTEM,
    sprintPathsPrompt: PathsPrompt.sprintPathsPrompt(pathsInput, 'N0'),
    BUILD_SECTIONS_SYSTEM_PROMPT: provider ? DocsPrompts.buildSectionsSystemPrompt(provider) : DocsPrompts.BUILD_SECTIONS_SYSTEM_PROMPT,
    BUILD_PDF_SYSTEM_PROMPT: DocsPrompts.BUILD_PDF_SYSTEM_PROMPT,
    CHAT_SYSTEM_PROMPT: provider ? DocsPrompts.chatSystemPrompt(provider) : DocsPrompts.CHAT_SYSTEM_PROMPT,
    buildSectionsPrompt: DocsPrompts.buildSectionsPrompt({ title: 'T', sourceName: 's.md', sourceKind: 'markdown' }, drafts, ['001-intro.md'], 'N0', provider),
    buildPdfPrompt: DocsPrompts.buildPdfPrompt({ title: 'T', sourceName: 's.pdf', sourceKind: 'pdf' }, 12, 'N0'),
    docsNavigationPrompt: DocsPrompts.docsNavigationPrompt('/lib', provider),
    buildChatPrompt: DocsPrompts.buildChatPrompt([{ role: 'user', text: 'q0' }, { role: 'assistant', text: 'a0' }], 'q?', 'N0'),
  });
  const hashes = (o: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, h(v)]));

  it('the exported constants, and every builder asked for Claude', () => {
    // Undefined = the ACTIVE provider for the builders: Claude here (the constants are always Claude's).
    process.env.LIMN_AI_PROVIDER = 'claude';
    expect(hashes(built(undefined))).toEqual(BEFORE);
    process.env.LIMN_AI_PROVIDER = 'codex';
    expect(hashes(built('claude'))).toEqual(BEFORE);
  });

  it('…and the builders under the ACTIVE provider when that is Claude', () => {
    process.env.LIMN_AI_PROVIDER = 'claude';
    expect(hashes({
      PR_DIAGRAM_SYSTEM_PROMPT: DiagPrompts.prDiagramSystemPrompt(),
      STORY_DIAGRAM_SYSTEM_PROMPT: DiagPrompts.storyDiagramSystemPrompt(),
      SPRINT_PATHS_SYSTEM: PathsPrompt.sprintPathsSystem(),
      BUILD_SECTIONS_SYSTEM_PROMPT: DocsPrompts.buildSectionsSystemPrompt(),
      CHAT_SYSTEM_PROMPT: DocsPrompts.chatSystemPrompt(),
      docsNavigationPrompt: DocsPrompts.docsNavigationPrompt('/lib'),
    })).toEqual({
      PR_DIAGRAM_SYSTEM_PROMPT: BEFORE.PR_DIAGRAM_SYSTEM_PROMPT,
      STORY_DIAGRAM_SYSTEM_PROMPT: BEFORE.STORY_DIAGRAM_SYSTEM_PROMPT,
      SPRINT_PATHS_SYSTEM: BEFORE.SPRINT_PATHS_SYSTEM,
      BUILD_SECTIONS_SYSTEM_PROMPT: BEFORE.BUILD_SECTIONS_SYSTEM_PROMPT,
      CHAT_SYSTEM_PROMPT: BEFORE.CHAT_SYSTEM_PROMPT,
      docsNavigationPrompt: BEFORE.docsNavigationPrompt,
    });
  });

  it('the handlers’ refusal words for Claude are unchanged', () => {
    const j = Diag.judgeSubmission({ acts: [] } as any, 1, { kind: 'pr', prs: [{ ref: 'PR1', changedFiles: [] }] });
    expect('reply' in j && j.reply).toMatch(/Fix every point and call submit_design again with the whole design\.$/);
    const p = Paths.judgePathsSubmission({ paths: [{ title: 'x', tickets: [], advice: 'y', risk: 'high' }] }, 1, { keys: [] });
    expect('reply' in p && p.reply).toMatch(/Fix every point and call submit_paths again with the whole answer\.$/);
  });

  it('the Codex prompts name no Claude tool', () => {
    const codex = [
      DiagPrompts.prDiagramSystemPrompt('codex'),
      DiagPrompts.storyDiagramSystemPrompt('codex'),
      PathsPrompt.sprintPathsSystem('codex'),
      DocsPrompts.buildSectionsSystemPrompt('codex'),
      DocsPrompts.chatSystemPrompt('codex'),
      DocsPrompts.buildSectionsPrompt({ title: 'T', sourceName: 's.md', sourceKind: 'markdown' }, drafts, ['001-intro.md'], 'N0', 'codex'),
    ];
    for (const text of codex) {
      expect(text).not.toMatch(/Read, Glob|\bGlob\b|\bGrep\b|submit_design|submit_paths|record_sections|finish_document/);
    }
  });
});
