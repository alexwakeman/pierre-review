// PHASE 3 STREAM (b) ON CODEX, offline (docs/CODEX-PLAN.md § 5): AI Fix (`runCodingAgent`), Plan first
// (`runPlanAgent`) and Resolve with Claude (`startAiResolve`), each run through the REAL Codex provider
// (ai/providers/codex.ts → `codex exec`), against a FAKE `codex` program that plays recorded-shape
// JSONL streams (the ai/codex/__fixtures__ events: thread.started, item.completed agent_message /
// file_change, turn.completed with usage). Limn's Codex home, the hook's trust check, the MCP config,
// the app-server and the ledger are faked exactly as ai/providers/codex.test.ts fakes them; the git
// worktree is a REAL scratch repository, so the fix's diff is captured by the real `git`.
//
// What is pinned, per kind:
//   • success: the strict result schema on disk, the Codex wording (no Claude tool name, no
//     submit_* call), the write/read roots the Claude path guard allows (the fixer writes its worktree
//     only; Plan first and Resolve are READ-ONLY), US$ 0 on a ChatGPT sign-in, ONE ledger row written
//     by the provider (with the PR and the feature) and none by the caller;
//   • schema failure + ONE retry (`exec resume`): a shape issue (fix), a refused plan (its shown-ref
//     check, unchanged, answered as an error so the retry happens) and refused conflict choices (the
//     resolver's own validator; a second refusal keeps what was accepted, as on Claude);
//   • a second failure fails the fix, its usage still recorded once;
//   • the sandbox's ONLY write root is the worktree (no /tmp, no $TMPDIR) — the hook's refusal of an
//     outside edit is proven live (ai/codex/live.test.ts);
//   • cancellation: an aborted run is a clean `aborted` result, its NULL-token row recorded once.
// (The budget skip of an AUTOMATIC fix on Codex is pinned in ai-fix/auto-fix.test.ts.)
//
//   pnpm --filter @pierre-review/backend test coding/codex-fix
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-fix-test-')));
  process.env.DATABASE_URL = path.join(root, 'unused.sqlite');
  process.env.DISABLE_SCHEDULER = 'true';
  return {
    root,
    home: path.join(root, 'codex-home'),
    bin: path.join(root, 'fake-codex.mjs'),
    log: path.join(root, 'calls.jsonl'),
    scenario: path.join(root, 'scenario.txt'),
    recorded: [] as any[],
    trustWrites: [] as any[],
    worktrees: [] as string[],
  };
});

vi.mock('../ai/codex/home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/codex/home.js')>()),
  codexBinary: async () => T.bin,
  codexHome: () => T.home,
  ensureCodexHomeConfig: async (hook: unknown) => {
    T.trustWrites.push(hook);
  },
}));
vi.mock('../ai/codex/hook.js', () => ({
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
vi.mock('../ai/codex/workspace-mcp.js', () => ({
  workspaceMcpConfig: (roots: { read: string[] }) => ({
    id: 'workspace',
    command: '/usr/bin/node',
    args: ['/limn/mcp.js', ...roots.read],
    env: {},
    default_tools_approval_mode: 'approve',
  }),
}));
vi.mock('../ai/codex/app-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/codex/app-server.js')>()),
  codexAccount: async () => ({ signedIn: true, plan: 'plus' }),
  codexSignedInCached: () => null,
  confirmCodexAccount: async () => {},
  recheckCodexAccount: async () => {},
}));
vi.mock('../db/usage.js', () => ({
  recordAiUsage: async (row: unknown) => {
    T.recorded.push(row);
  },
}));
vi.mock('../ai/codex/threads.js', () => ({
  armCodexThreadSweeps: () => {},
  queueCodexThreadCleanup: () => {},
}));
// Plan first is ported in code but not yet in the shipped allow-list (ai/codex/kinds/fix.ts: its live
// run has not passed); this suite runs it through the provider's one door all the same.
vi.mock('../ai/codex/kinds/fix.js', () => ({ CODEX_FIX_KINDS: ['fix', 'plan', 'resolve'] }));
vi.mock('../auth/account.js', () => ({ getAccessToken: async () => 'gh-token' }));
// The worktree: a REAL git repository per run (so the provider's git snapshot and the fixer's
// `captureWorktreeDiff` run for real), never a clone.
vi.mock('../review/clone-manager.js', () => ({
  prepWorktree: async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    const parent = fs.mkdtempSync(path.join(T.root, 'wt-'));
    const wt = path.join(parent, 'worktree');
    fs.mkdirSync(wt);
    const git = (...a: string[]) => cp.execFileSync('git', ['-C', wt, ...a], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(wt, 'app.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    T.worktrees.push(wt);
    return { repoCloneDir: parent, worktreePath: wt };
  },
  removeWorktreeLocked: async () => {},
  cleanupCloneCache: () => {},
}));

const { runCodingAgent, runPlanAgent } = await import('./agent.js');
const { buildFixSystemPrompt, buildFixUserPrompt, buildPlanSystemPrompt, buildPlanUserPrompt } = await import(
  './ai-fix/prompts.js'
);
const { CODEX_PLAIN_TASK_RULE, CODEX_PLAN_REFS_RULE } = await import('./ai-fix/plan.js');
const C = await import('../ai/providers/codex.js');
const P = await import('../ai/provider.js');

// ---- the fake `codex` ------------------------------------------------------------------------------
//
// The scenario comes from a SIDECAR file (Limn hands Codex only an environment allow-list). On
// `exec resume <thread>` the same scenario plays its retry turn.
const FAKE = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const at = (f) => argv[argv.indexOf(f) + 1];
const schemaFile = argv.includes('--output-schema') ? at('--output-schema') : null;
const cwd = at('-C');
const resumed = argv.includes('resume');
const scenario = readFileSync(${JSON.stringify(T.scenario)}, 'utf8').trim();
appendFileSync(${JSON.stringify(T.log)}, JSON.stringify({ argv, stdin, resumed, schema: schemaFile ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const msg = (o) => out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: typeof o === 'string' ? o : JSON.stringify(o) } });
const done = (i, o) => out({ type: 'turn.completed', usage: { input_tokens: i, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0 } });
const thread = () => out({ type: 'thread.started', thread_id: 'th-' + scenario.replace(/_/g, '-') });
const write = (p, text) => {
  writeFileSync(p, text);
  out({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: p, kind: 'add' }], status: 'completed' } });
};
const FIX = { summary: 'Guarded the null user.', commitMessage: 'fix: guard null user', changes: [{ path: 'fixed.ts', summary: 'Added a guard.', refs: ['F1'] }], unaddressed: null };
const GOOD_PLAN = { summary: ['Guard the null user'], steps: [{ title: 'Null guard', files: ['app.ts'], change: 'Return early.', refs: ['F1'] }], notAddressed: null, reply: null };
thread();
out({ type: 'turn.started' });
switch (scenario) {
  case 'fix_ok':
    out({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'Reading app.ts' } });
    write(join(cwd, 'fixed.ts'), 'export const y = 2;\\n');
    msg(FIX); done(120, 30); break;
  case 'fix_retry':
    if (resumed) { msg(FIX); done(300, 50); }
    else { write(join(cwd, 'fixed.ts'), 'export const y = 2;\\n'); msg({ ...FIX, summary: 7 }); done(120, 30); }
    break;
  case 'fix_bad':
    msg({ ...FIX, commitMessage: null }); done(resumed ? 260 : 100, resumed ? 40 : 20); break;
  case 'hang':
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000); break;
  case 'plan_refused':
    if (resumed) { msg(GOOD_PLAN); done(200, 40); }
    else { msg({ ...GOOD_PLAN, steps: [{ ...GOOD_PLAN.steps[0], refs: ['F9'] }] }); done(90, 20); }
    break;
  case 'plan_no_steps':
    if (resumed) { msg(GOOD_PLAN); done(200, 40); }
    else { msg({ ...GOOD_PLAN, steps: [] }); done(90, 20); }
    break;
  case 'plan_plain_invented_ref':
    if (resumed) { msg({ summary: ['Already guarded'], steps: [{ title: 'No change needed', files: ['src/math.ts'], change: 'divide already throws when b is 0.', refs: [] }], notAddressed: null, reply: null }); done(200, 40); }
    else { msg({ summary: ['Already guarded'], steps: [], notAddressed: [{ ref: 'T1', reason: 'Already done.' }], reply: null }); done(90, 20); }
    break;
  case 'plan_empty_twice':
    msg({ summary: ['Already guarded'], steps: [], notAddressed: null, reply: null }); done(90, 20); break;
  case 'resolve_retry':
    if (resumed) { msg({ choices: [{ file: 0, region: 1, fingerprint: 'fp1', decision: 'theirs', lines: null, rationale: 'main renamed it', confidence: 'high' }], summary: 'Took main.' }); done(150, 20); }
    else { msg({ choices: [{ file: 0, region: 1, fingerprint: 'WRONG', decision: 'theirs', lines: null, rationale: 'x', confidence: 'high' }], summary: 'First go.' }); done(80, 10); }
    break;
  case 'resolve_partial_then_fail':
    if (resumed) { msg('not json at all'); done(150, 20); }
    else { msg({ choices: [{ file: 0, region: 1, fingerprint: 'fp1', decision: 'theirs', lines: null, rationale: 'main renamed it', confidence: 'high' }, { file: 0, region: 3, fingerprint: 'WRONG', decision: 'ours', lines: null, rationale: null, confidence: null }], summary: 'Took main for one.' }); done(80, 10); }
    break;
  case 'resolve_refused_twice':
    msg({ choices: [{ file: 0, region: 1, fingerprint: 'WRONG', decision: 'theirs', lines: null, rationale: null, confidence: null }], summary: 'Tried.' }); done(80, 10); break;
  default: msg('?'); done(1, 1);
}
`;

const calls = (): any[] =>
  existsSync(T.log)
    ? readFileSync(T.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const scenario = (s: string): void => writeFileSync(T.scenario, s);
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

const savedProvider = process.env.LIMN_AI_PROVIDER;
beforeAll(() => {
  writeFileSync(T.bin, FAKE);
  chmodSync(T.bin, 0o755);
  mkdirSync(T.home, { recursive: true });
  // A ChatGPT sign-in, as 0.164 writes it (non-secret fixture fields only).
  writeFileSync(
    join(T.home, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fixture', access_token: 'fixture', refresh_token: 'fixture' } }),
  );
  process.env.LIMN_AI_PROVIDER = 'codex';
});
beforeEach(() => {
  T.recorded.length = 0;
  T.trustWrites.length = 0;
  C._resetCodexTrustCacheForTest();
});
afterEach(() => {
  if (existsSync(T.log)) unlinkSync(T.log);
});
afterAll(() => {
  if (savedProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
  else process.env.LIMN_AI_PROVIDER = savedProvider;
  rmSync(T.root, { recursive: true, force: true });
});

const pr = { number: 12, repoFullName: 'acme/app', title: 'Fix auth', body: null } as any;
const fixArgs = (over: Partial<Parameters<typeof runCodingAgent>[0]> = {}) => ({
  accountId: 1,
  prId: 7,
  owner: 'acme',
  name: 'app',
  prNumber: 12,
  baseSha: 'abc',
  model: 'claude-opus-5-5',
  systemPrompt: buildFixSystemPrompt('codex'),
  prompt: buildFixUserPrompt({ pr, diff: '', seed: { kind: 'review', text: 'F1: null deref' }, provider: 'codex' }),
  abortController: new AbortController(),
  onProgress: () => {},
  provider: 'codex' as const,
  ...over,
});

describe('the kinds', () => {
  it('the shipped file lists fix, plan and resolve (plan joined after its live runs passed)', async () => {
    const real = await vi.importActual<typeof import('../ai/codex/kinds/fix.js')>('../ai/codex/kinds/fix.js');
    expect(real.CODEX_FIX_KINDS).toEqual(['fix', 'plan', 'resolve']);
    for (const k of ['fix', 'plan', 'resolve'] as const) expect(P.CODEX_AGENT_KINDS.has(k)).toBe(true);
  });
});

describe('the prompts on Codex keep the no-shell text (no-shell.test.ts pins the Claude half)', () => {
  it('the fix and plan prompts name Codex’s tools, still say there is no shell and nothing is built, and leave the commit to the host', () => {
    const fix = buildFixSystemPrompt('codex');
    const plan = buildPlanSystemPrompt('codex');
    for (const p of [fix, plan]) {
      expect(p).not.toMatch(/\bBash\b|\bsubmit_(?:fix|plan)\b|\bMultiEdit\b/);
      expect(p).toContain('NO shell here');
      expect(p).toContain('Nothing is installed, built or tested here');
    }
    expect(fix).toContain('Do NOT commit, push, create branches');
    expect(plan).toContain('You CANNOT edit files');
    expect(plan).not.toContain('apply_patch');
  });

  it('Claude is the default when no provider is named (the active one here), byte for byte', () => {
    expect(buildFixSystemPrompt('claude')).toContain('call the submit_fix tool EXACTLY ONCE');
    expect(buildPlanSystemPrompt('claude')).toContain('call the submit_plan tool EXACTLY ONCE');
  });
});

describe('AI Fix on Codex', () => {
  it('success: a write run confined to the worktree, Codex’s words, the strict schema, the diff from git, ONE ledger row', async () => {
    scenario('fix_ok');
    const progress: any[] = [];
    const res = await runCodingAgent(fixArgs({ onProgress: (p: any) => progress.push(p) }));
    const wt = T.worktrees.at(-1)!;

    expect(res.aborted).toBe(false);
    expect(res.summary).toBe('Guarded the null user.');
    expect(res.commitMessage).toBe('fix: guard null user');
    // The report reaches the manager as the tool received it (strict nulls dropped); the manager
    // validates its refs against the shown set at save, unchanged.
    expect(res.report).toEqual({ changes: [{ path: 'fixed.ts', summary: 'Added a guard.', refs: ['F1'] }] });
    expect(res.filesChanged).toEqual(['fixed.ts']);
    expect(res.patch).toContain('+export const y = 2;');
    // US$ 0 on a ChatGPT sign-in, never Claude-priced; the provider wrote the row, so the save will not.
    expect(res.costUsd).toBe(0);
    expect(res.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(res.usageRecorded).toBe(true);
    expect(T.recorded).toEqual([
      expect.objectContaining({ accountId: 1, prId: 7, feature: 'ai_fix', seam: 'agent', provider: 'codex', model: 'gpt-6-astra', costUsd: 0, inputTokens: 120, outputTokens: 30 }),
    ]);

    const [call] = calls();
    const c = cfg(call.argv);
    // A WRITE run: workspace-write, the worktree the ONLY write root (what the Claude path guard
    // allows: cwd, no other root), the guard's roots in its environment.
    expect(c.get('sandbox_mode')).toBe('"workspace-write"');
    expect(c.get('sandbox_workspace_write.writable_roots')).toBe(JSON.stringify([wt]));
    expect(T.trustWrites.at(-1).env.LIMN_CODEX_GUARD).toBe(JSON.stringify({ read: [wt], write: [wt] }));
    expect(c.get('features.shell_tool')).toBe('false');
    // ⚠ /tmp and $TMPDIR are NOT writable (spike § 3.2): the worktree is the sandbox's only write root.
    // (The hook's refusal of an outside edit is proven live: ai/codex/live.test.ts, test 5.)
    expect(c.get('sandbox_workspace_write.exclude_slash_tmp')).toBe('true');
    expect(c.get('sandbox_workspace_write.exclude_tmpdir_env_var')).toBe('true');
    // The strict submit_fix schema; every key required, the optional ones nullable.
    expect(call.schema.required.sort()).toEqual(['changes', 'commitMessage', 'summary', 'unaddressed']);
    expect(call.schema.additionalProperties).toBe(false);
    // Codex's wording: its own tools, a final JSON answer, still no shell.
    const sys = JSON.parse(c.get('developer_instructions')!);
    expect(sys).toContain('read_file, list_files and search');
    expect(sys).toContain('apply_patch');
    expect(sys).toContain('You have NO shell here');
    expect(sys).not.toMatch(/\bsubmit_fix\b|\bBash\b|MultiEdit/);
    expect(call.stdin).toContain('give your final JSON answer');
    expect(call.stdin).not.toContain('submit_fix');
    // The neutral progress reached the fixer's own phase.
    expect(progress.some((p) => p.phase === 'fixing' && Array.isArray(p.recentActivity))).toBe(true);
  });

  it('a shape failure gets ONE retry on the same thread, and the corrected answer is used', async () => {
    scenario('fix_retry');
    const res = await runCodingAgent(fixArgs());
    const [first, retry] = calls();
    expect(first.resumed).toBe(false);
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('summary');
    expect(res.summary).toBe('Guarded the null user.');
    expect(res.filesChanged).toEqual(['fixed.ts']);
    // The resumed turn reports the thread's total: the run's tokens are that total, once.
    expect(T.recorded).toHaveLength(1);
    expect(T.recorded[0]).toMatchObject({ inputTokens: 300, outputTokens: 50 });
  });

  it('a second failure fails the fix — its usage still recorded, once', async () => {
    scenario('fix_bad');
    await expect(runCodingAgent(fixArgs())).rejects.toThrow(/did not pass Limn's checks/);
    expect(calls()).toHaveLength(2);
    expect(T.recorded).toHaveLength(1);
    expect(T.recorded[0]).toMatchObject({ feature: 'ai_fix', provider: 'codex', inputTokens: 260 });
  });

  it('cancellation: a clean aborted result, the NULL-token row recorded once by the provider', async () => {
    scenario('hang');
    const abortController = new AbortController();
    const run = runCodingAgent(fixArgs({ abortController }));
    for (let i = 0; i < 4800 && calls().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(calls()).toHaveLength(1);
    abortController.abort();
    const res = await run;
    expect(res.aborted).toBe(true);
    expect(res.patch).toBe('');
    expect(res.usageRecorded).toBe(true);
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'ai_fix', provider: 'codex', inputTokens: null, outputTokens: null })]);
  });
});

describe('Plan first on Codex', () => {
  const planArgs = () => ({
    accountId: 1,
    prId: 7,
    owner: 'acme',
    name: 'app',
    prNumber: 12,
    baseSha: 'abc',
    model: 'claude-opus-5-5',
    systemPrompt: buildPlanSystemPrompt('codex'),
    prompt: buildPlanUserPrompt({ pr, diff: '', seed: { kind: 'review', text: 'F1: null deref' }, nonce: 'n0', provider: 'codex' }),
    shownRefs: ['F1'],
    maxBudgetUsd: 5,
    abortController: new AbortController(),
    onProgress: () => {},
    provider: 'codex' as const,
  });

  it('READ-ONLY; a plan citing a ref it was not shown is refused by the SAME check, retried once, then accepted', async () => {
    scenario('plan_refused');
    const res = await runPlanAgent(planArgs());
    const [first, retry] = calls();
    const c = cfg(first.argv);
    expect(c.get('sandbox_mode')).toBe('"read-only"');
    expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
    const wt = T.worktrees.at(-1)!;
    expect(T.trustWrites.at(-1).env.LIMN_CODEX_GUARD).toBe(JSON.stringify({ read: [wt], write: [] }));
    const sys = JSON.parse(c.get('developer_instructions')!);
    expect(sys).toContain('You may use read_file, list_files and search to explore.');
    expect(sys).toContain('You CANNOT edit files and you have NO shell here');
    expect(sys).toContain('`steps` must hold at least one entry');
    expect(sys).not.toMatch(/\bsubmit_plan\b|\bBash\b/);
    // The plan's own check (ai-fix/plan.ts checkPlanSubmission) refused F9; its sentence is the retry's reason.
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('The plan was not recorded');
    expect(retry.stdin).toContain('F9');
    expect(res.plan).toEqual({ summary: ['Guard the null user'], steps: [{ title: 'Null guard', files: ['app.ts'], change: 'Return early.', refs: ['F1'] }], notAddressed: undefined, reply: undefined });
    expect(res.costUsd).toBe(0);
    expect(res.usageRecorded).toBe(true);
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'ai_fix_plan', prId: 7, provider: 'codex', inputTokens: 200 })]);
  });

  it('a plan with NO steps is refused by the SAME check Claude’s tool runs, retried once, then accepted', async () => {
    scenario('plan_no_steps');
    const res = await runPlanAgent(planArgs());
    const [, retry] = calls();
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('Give at least one step');
    // A task WITH refs gets no plain-task hint.
    expect(retry.stdin).not.toContain(CODEX_PLAIN_TASK_RULE);
    expect((res.plan as any).steps).toHaveLength(1);
    expect(T.recorded).toHaveLength(1);
  });

  // The 2026-10-25 live failure, replayed: a plain task (no refs) whose first answer invented ref T1.
  const plainArgs = () => ({
    ...planArgs(),
    prompt: buildPlanUserPrompt({ pr, diff: '', seed: { kind: 'plain', text: 'Make divide throw when b is 0.' }, nonce: 'n0', provider: 'codex' }),
    shownRefs: [] as string[],
  });

  it('a plain task: Codex is told there are no refs, and a refusal for an invented ref says a step is still needed', async () => {
    scenario('plan_plain_invented_ref');
    const res = await runPlanAgent(plainArgs());
    const [first, retry] = calls();
    expect(first.stdin).toContain(CODEX_PLAIN_TASK_RULE);
    expect(JSON.parse(cfg(first.argv).get('developer_instructions')!)).toContain(CODEX_PLAN_REFS_RULE);
    expect(retry.stdin).toContain('This task has no item refs');
    expect(retry.stdin).toContain(CODEX_PLAIN_TASK_RULE);
    expect(res.plan).toMatchObject({ steps: [expect.objectContaining({ title: 'No change needed', refs: [] })] });
  });

  it('a plan still step-less after its one retry is never accepted', async () => {
    scenario('plan_empty_twice');
    const outcome = await runPlanAgent(plainArgs()).then(
      (r) => r.plan,
      (e: Error) => e.message,
    );
    expect(calls()).toHaveLength(2);
    if (typeof outcome === 'string') expect(outcome).toMatch(/at least one step/);
    else expect(outcome).toBeNull();
    expect(T.recorded).toHaveLength(1);
  });

  it('cancellation: an aborted pass, its row recorded once', async () => {
    scenario('hang');
    const args = planArgs();
    const run = runPlanAgent(args);
    for (let i = 0; i < 4800 && calls().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    args.abortController.abort();
    const res = await run;
    expect(res).toMatchObject({ plan: null, aborted: true, usageRecorded: true });
    expect(T.recorded).toHaveLength(1);
  });
});

describe('Resolve with Claude, on Codex', () => {
  const S = () => import('../conflict/session.js');
  const R = () => import('./ai-resolve/run.js');

  function model(): any {
    return {
      accountId: 1,
      prId: 7,
      owner: 'acme',
      name: 'web',
      number: 7,
      headSha: 'h',
      baseSha: 'b',
      headRef: 'feature',
      baseRef: 'main',
      mergeBaseSha: null,
      mergeBaseIsVirtual: false,
      mergedTreeSha: 't',
      files: [
        {
          index: 0,
          path: 'src/a.ts',
          relatedPaths: [],
          unsupported: null,
          unsupportedLabel: null,
          terminators: { base: true, ours: true, theirs: true },
          maxSideBytes: 10,
          stage2Mode: '100644',
          regions: [
            { id: 0, kind: 'unchanged', base: ['a'], ours: ['a'], theirs: ['a'], fingerprint: 'fp0', wand: null, mergedLines: null },
            { id: 1, kind: 'conflict', base: ['b'], ours: ['c'], theirs: ['d'], fingerprint: 'fp1', wand: null, mergedLines: null },
            { id: 2, kind: 'unchanged', base: ['e'], ours: ['e'], theirs: ['e'], fingerprint: 'fp2', wand: null, mergedLines: null },
            { id: 3, kind: 'conflict', base: ['f'], ours: ['g'], theirs: ['h'], fingerprint: 'fp3', wand: null, mergedLines: null },
          ],
        },
      ],
      totalConflictedPaths: 1,
      truncated: false,
      renameDetection: 'on',
      commitsAboveBase: 1,
      strategies: ['merge'],
      rebaseUnavailableReason: null,
      reservedBranchNames: ['main'],
      prBranchPushable: true,
      prBranchUnavailableReason: null,
    };
  }

  async function resolveOnce(): Promise<{ view: any; recordAiUsage: ReturnType<typeof vi.fn> }> {
    const sessions = await S();
    const runs = await R();
    sessions.__testing.reset();
    runs.__testing.reset();
    const recordAiUsage = vi.fn(async () => {});
    const ctx = {
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      llm: { detectAuth: () => ({ status: 'ok' }) },
      recordAiUsage,
    } as any;
    const started = await runs.startAiResolve(ctx, {
      accountId: 1,
      prId: 7,
      model: 'claude-sonnet-5',
      log: ctx.log,
      runOpen: async (rec: any) => {
        sessions.settleReady(rec, model(), 'hash', false);
      },
    });
    expect(started.status).toBe('started');
    let view: any = null;
    for (let i = 0; i < 4800; i++) {
      view = runs.getAiResolution(1, 7);
      if (view && view.finishedAt) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return { view, recordAiUsage };
  }

  it('READ-ONLY; refused choices (the resolver’s own validator) earn ONE retry, then the fixed choice is kept', async () => {
    scenario('resolve_retry');
    const { view, recordAiUsage } = await resolveOnce();
    expect(view.status).toBe('succeeded');
    expect(view.choices).toEqual([
      expect.objectContaining({ fileIndex: 0, regionId: 1, decision: 'theirs', rationale: 'main renamed it', confidence: 'high' }),
    ]);
    expect(view.summary).toBe('Took main.');
    const [first, retry] = calls();
    const c = cfg(first.argv);
    expect(c.get('sandbox_mode')).toBe('"read-only"');
    const sys = JSON.parse(c.get('developer_instructions')!);
    expect(sys).toContain('Give your choices as your final answer');
    expect(sys).not.toContain('submit_resolution');
    expect(first.schema.required.sort()).toEqual(['choices', 'summary']);
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('fingerprint does not match the region');
    // The provider wrote the ledger row; the run module wrote none.
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'ai_resolve', prId: 7, provider: 'codex' })]);
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  it('a SECOND refusal is not a failure: the run ends with what was accepted (here nothing), as on Claude', async () => {
    scenario('resolve_refused_twice');
    const { view } = await resolveOnce();
    expect(calls()).toHaveLength(2);
    expect(view.status).toBe('succeeded');
    expect(view.choices).toEqual([]);
    expect(T.recorded).toHaveLength(1);
  });

  it('a retry that FAILS keeps what the first answer got accepted: succeeded, never failed', async () => {
    scenario('resolve_partial_then_fail');
    const { view, recordAiUsage } = await resolveOnce();
    const [, retry] = calls();
    expect(retry.resumed).toBe(true);
    expect(retry.stdin).toContain('fingerprint does not match the region');
    expect(view.status).toBe('succeeded');
    expect(view.choices).toEqual([
      expect.objectContaining({ fileIndex: 0, regionId: 1, decision: 'theirs', rationale: 'main renamed it' }),
    ]);
    expect(view.summary).toBe('Took main for one.');
    // The provider recorded the run's usage once; the run module wrote none.
    expect(T.recorded).toHaveLength(1);
    expect(recordAiUsage).not.toHaveBeenCalled();
  });
});

// A safety net for this file's own fixture: the scratch repos really are git repos.
it('the scratch worktrees are real git repositories', () => {
  const wt = T.worktrees[0];
  expect(wt).toBeTruthy();
  expect(execFileSync('git', ['-C', wt!, 'rev-parse', '--is-inside-work-tree']).toString().trim()).toBe('true');
});
