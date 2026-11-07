// RESOLVE WITH CLAUDE ON CODEX, offline (docs/CODEX-PLAN.md § 5): `startAiResolve` run through the
// REAL Codex provider (ai/providers/codex.ts → `codex exec`), against a FAKE `codex` program that plays
// recorded-shape JSONL streams (the ai/codex/__fixtures__ events). Limn's Codex home, the hook's trust
// check, the MCP config, the app-server and the ledger are faked exactly as ai/providers/codex.test.ts
// fakes them; the git worktree is a REAL scratch repository.
//
// What is pinned: the strict result schema on disk, the Codex wording (no submit_* call), READ-ONLY,
// refused conflict choices answered with ONE retry (`exec resume`) and a second refusal keeping what
// was accepted (as on Claude), ONE ledger row written by the provider and none by the caller.
// (AI Fix and Plan first left this host path: they run as sandboxed workspace sessions —
// sandbox/session/fix-session-flow-db.test.ts.)
//
//   pnpm --filter @pierre-review/backend test coding/codex-resolve
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
// The worktree: a REAL git repository per run (so the provider's git snapshot runs for real), never a clone.
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

const C = await import('../ai/providers/codex.js');
const P = await import('../ai/provider.js');

// ---- the fake `codex` ------------------------------------------------------------------------------
//
// The scenario comes from a SIDECAR file (Limn hands Codex only an environment allow-list). On
// `exec resume <thread>` the same scenario plays its retry turn.
const FAKE = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
thread();
out({ type: 'turn.started' });
switch (scenario) {
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

describe('the kinds', () => {
  it('the shipped file still lists fix, plan and resolve (fix and plan now run through the sandbox drivers)', async () => {
    const real = await vi.importActual<typeof import('../ai/codex/kinds/fix.js')>('../ai/codex/kinds/fix.js');
    expect(real.CODEX_FIX_KINDS).toEqual(['fix', 'plan', 'resolve']);
    for (const k of ['fix', 'plan', 'resolve'] as const) expect(P.CODEX_AGENT_KINDS.has(k)).toBe(true);
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
