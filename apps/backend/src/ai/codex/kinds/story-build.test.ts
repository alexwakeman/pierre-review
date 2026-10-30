// "IMPLEMENT STORY" ON CODEX, offline — the `story_build` kind (docs/STORY-BUILD.md § Codex). One
// repository's build (coding/story-build/build.ts `buildRepo`) runs through the REAL Codex provider
// (ai/providers/codex.ts → `codex exec`) against a FAKE `codex` program playing recorded-shape JSONL
// streams, exactly as coding/codex-fix.test.ts does for AI Fix. The worktree is a REAL scratch git
// repository, so the diff is captured by the real `git`. Pinned:
//   • a WRITE run in `workspace-write` with the worktree its ONLY write root; the earlier repository's
//     tree and nothing else readable besides; the guard carries the write deny-list (`protect`);
//   • the strict `submit_build` schema on disk; Codex's wording (no Claude tool name, no submit_build);
//   • ONE ledger row, written by the provider (`story_build`, the repository), none by buildRepo;
//   • a shape failure gets ONE `exec resume` retry; a second failure fails the repository (its spend
//     still recorded once); a cancel is a clean cancelled result.
// (The `story_plan` kind is WP1's: its own test file ports it.)
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryBuildPlan } from '@pierre-review/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-codex-story-build-')));
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
    removed: [] as string[],
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
  pathGuardHook: (roots: unknown) => ({
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
  codexAccount: async () => ({ signedIn: true, plan: 'plus' }),
  codexSignedInCached: () => null,
  confirmCodexAccount: async () => {},
  recheckCodexAccount: async () => {},
}));
vi.mock('../../../db/usage.js', () => ({
  recordAiUsage: async (row: unknown) => {
    T.recorded.push(row);
  },
}));
vi.mock('../threads.js', () => ({
  armCodexThreadSweeps: () => {},
  queueCodexThreadCleanup: () => {},
}));
vi.mock('../../../auth/account.js', () => ({ getAccessToken: async () => 'gh-token' }));
vi.mock('../../../reference-docs/context.js', () => ({ reviewDocsFor: async () => null }));
vi.mock('../../../review/clone-manager.js', () => ({
  prepBranchWorktree: async (_owner: string, _name: string, ref: any) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    const clone = fs.mkdtempSync(path.join(T.root, 'clone-'));
    const wt = path.join(clone, '.worktrees', `${ref.sha}-1-${T.worktrees.length + 1}`);
    fs.mkdirSync(wt, { recursive: true });
    const git = (...a: string[]) => cp.execFileSync('git', ['-C', wt, ...a], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(wt, 'app.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    T.worktrees.push(wt);
    return { repoCloneDir: clone, worktreePath: wt, sha: ref.sha };
  },
  removeWorktreeLocked: async (_o: string, _n: string, _c: string, wt: string) => {
    T.removed.push(wt);
  },
  scrubGitError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { buildRepo } = await import('../../../coding/story-build/build.js');
const C = await import('../../providers/codex.js');
const P = await import('../../provider.js');

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
const write = (p, text) => {
  writeFileSync(p, text);
  out({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: p, kind: 'add' }], status: 'completed' } });
};
const BUILD = { summary: 'Added the refund button. It calls the endpoint.', commitMessage: 'feat: refund button', changes: [{ path: 'refund.ts', summary: 'The button.', refs: ['AC2'] }], unaddressed: null };
out({ type: 'thread.started', thread_id: 'th-' + scenario.replace(/_/g, '-') });
out({ type: 'turn.started' });
switch (scenario) {
  case 'build_ok':
    write(join(cwd, 'refund.ts'), 'export const refund = 1;\\n');
    msg(BUILD); done(400, 60); break;
  case 'build_retry':
    if (resumed) { msg(BUILD); done(700, 90); }
    else { write(join(cwd, 'refund.ts'), 'export const refund = 1;\\n'); msg({ ...BUILD, commitMessage: 5 }); done(400, 60); }
    break;
  case 'build_bad':
    write(join(cwd, 'refund.ts'), 'x\\n');
    msg({ ...BUILD, summary: null }); done(resumed ? 650 : 300, resumed ? 80 : 50); break;
  case 'hang':
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000); break;
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
  writeFileSync(
    join(T.home, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fixture', access_token: 'fixture', refresh_token: 'fixture' } }),
  );
  process.env.LIMN_AI_PROVIDER = 'codex';
});
beforeEach(() => {
  T.recorded.length = 0;
  T.trustWrites.length = 0;
  T.removed.length = 0;
  ctxRows.length = 0;
  C._resetCodexTrustCacheForTest();
});
afterEach(() => {
  if (existsSync(T.log)) unlinkSync(T.log);
  expect(ctxRows).toEqual([]);
});
afterAll(() => {
  if (savedProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
  else process.env.LIMN_AI_PROVIDER = savedProvider;
  rmSync(T.root, { recursive: true, force: true });
});

const PLAN: StoryBuildPlan = {
  revision: 1,
  summary: 'Add card refunds. Two repositories change.',
  repos: [
    { ref: 'R1', repoId: 11, why: 'Endpoint.', branchSlug: 'refunds-api', steps: [{ title: 'Endpoint', files: ['a.ts'], change: 'Add.', refs: ['AC1'] }], tests: [] },
    { ref: 'R2', repoId: 12, why: 'Button.', branchSlug: 'refunds-web', steps: [{ title: 'Button', files: ['refund.ts'], change: 'Add.', refs: ['AC2'] }], tests: [] },
  ],
  readOnlyRepos: [],
  criteria: [
    { ref: 'AC1', how: 'planned', repo: 'R1', reason: null },
    { ref: 'AC2', how: 'planned', repo: 'R2', reason: null },
  ],
  risks: [],
};

const ctxRows: unknown[] = [];
const ctx: any = {
  log: { warn: () => {}, info: () => {} },
  llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
  // A Codex build's row is the provider's: buildRepo must write none (asserted per test).
  recordAiUsage: async (row: unknown) => {
    ctxRows.push(row);
  },
};

function args(earlierWt: string | null, over: Record<string, unknown> = {}): any {
  return {
    accountId: 1,
    build: {
      id: 5,
      accountId: 1,
      workspaceId: 3,
      ident: 'jira:https://acme.atlassian.net#ACME-214',
      ticketKey: 'ACME-214',
      ticketTitle: 'Refunds by card',
      status: 'building',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      planJson: PLAN,
      acceptedRevision: 1,
      candidatesJson: [],
      coverageJson: null,
      seedJson: { version: 1, story: { key: 'ACME-214', title: 'Refunds by card', text: 'Refund a card payment.', url: null }, criteria: [], comments: null, cards: [] },
    },
    repo: { id: 41, accountId: 1, buildId: 5, repoId: 12, ref: 'R2', buildOrder: 1, include: true, status: 'queued', baseRef: 'main', baseSha: 'b2', stackedOnPrId: null, branch: 'b', worktreePath: null, checksWantedJson: [] },
    fullName: 'acme/web',
    earlier: earlierWt
      ? [{ repo: { id: 40, repoId: 11, ref: 'R1', summary: 'Endpoint done.', changeReportJson: null }, fullName: 'acme/api', worktreePath: earlierWt }]
      : [],
    docs: { included: '', superseded: '', pending: 0 },
    nonce: 'zz9nonce',
    budgetLeftUsd: 20,
    onProgress: () => {},
    signal: new AbortController().signal,
    ...over,
  };
}

describe('the kind', () => {
  it('story_build is a ported Codex kind', async () => {
    const real = await vi.importActual<typeof import('./story-build.js')>('./story-build.js');
    expect(real.CODEX_STORY_BUILD_KINDS).toContain('story_build');
    expect(P.CODEX_AGENT_KINDS.has('story_build')).toBe(true);
  });
});

describe('a story build on Codex', () => {
  it('success: a write run confined to its worktree, the earlier tree readable, the deny-list on, ONE ledger row', async () => {
    scenario('build_ok');
    const earlierWt = join(T.root, 'earlier-wt');
    mkdirSync(earlierWt, { recursive: true });
    const res = await buildRepo(ctx, args(earlierWt));
    const wt = T.worktrees.at(-1)!;

    expect(res).toMatchObject({ ok: true, provider: 'codex', model: 'gpt-6.1-sol', costUsd: 0, filesChanged: ['refund.ts'], summary: 'Added the refund button. It calls the endpoint.' });
    expect(res.patch).toContain('+export const refund = 1;');
    expect(res.changeReport).toEqual({ changes: [{ path: 'refund.ts', summary: 'The button.', refs: ['AC2'] }], unaddressed: [], notReported: [] });
    expect(res.worktreePath).toBe(wt);
    expect(T.removed).toEqual([]);
    // The provider wrote the row (US$ 0 on ChatGPT, the tokens), buildRepo none (afterEach).
    expect(T.recorded).toEqual([expect.objectContaining({ accountId: 1, feature: 'story_build', seam: 'agent', provider: 'codex', costUsd: 0, inputTokens: 400, outputTokens: 60, repoId: 12 })]);

    const [call] = calls();
    const c = cfg(call.argv);
    expect(c.get('sandbox_mode')).toBe('"workspace-write"');
    expect(c.get('sandbox_workspace_write.writable_roots')).toBe(JSON.stringify([wt]));
    expect(c.get('features.shell_tool')).toBe('false');
    // The guard: read the worktree and the earlier tree, write the worktree only, the deny-list on.
    expect(JSON.parse(T.trustWrites.at(-1).env.LIMN_CODEX_GUARD)).toEqual({ read: [wt, earlierWt], write: [wt], protect: true });
    // The strict submit_build schema (the submit_fix shape).
    expect(call.schema.required.sort()).toEqual(['changes', 'commitMessage', 'summary', 'unaddressed']);
    expect(call.schema.additionalProperties).toBe(false);
    const sys = JSON.parse(c.get('developer_instructions')!);
    expect(sys).toContain('read_file, list_files and search');
    expect(sys).toContain('apply_patch');
    expect(sys).toContain('You have NO shell here');
    expect(sys).not.toMatch(/\bsubmit_build\b|\bBash\b|MultiEdit/);
    expect(call.stdin).toContain('give your final JSON answer');
    expect(call.stdin).not.toContain('submit_build');
    expect(call.stdin).toContain(`its worktree is at ${earlierWt} (read only)`);
  });

  it('a shape failure gets ONE retry on the same thread; the corrected answer is used', async () => {
    scenario('build_retry');
    const res = await buildRepo(ctx, args(null));
    const [first, retry] = calls();
    expect(first.resumed).toBe(false);
    expect(retry.resumed).toBe(true);
    expect(res).toMatchObject({ ok: true, commitMessage: 'feat: refund button' });
    expect(T.recorded).toHaveLength(1);
    expect(T.recorded[0]).toMatchObject({ inputTokens: 700, outputTokens: 90 });
  });

  it('a second failure fails the repository — its usage recorded once, the tree released', async () => {
    scenario('build_bad');
    const res = await buildRepo(ctx, args(null));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not pass Limn's checks/);
    expect(calls()).toHaveLength(2);
    expect(T.recorded).toHaveLength(1);
    expect(T.removed).toEqual([T.worktrees.at(-1)]);
  });

  it('cancellation: a clean cancelled result, the NULL-token row recorded once by the provider', async () => {
    scenario('hang');
    const ac = new AbortController();
    const run = buildRepo(ctx, args(null, { signal: ac.signal }));
    for (let i = 0; i < 4800 && calls().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(calls()).toHaveLength(1);
    ac.abort();
    const res = await run;
    expect(res).toMatchObject({ ok: false, cancelled: true, error: null });
    expect(T.recorded).toEqual([expect.objectContaining({ feature: 'story_build', provider: 'codex', inputTokens: null, outputTokens: null })]);
    expect(T.removed).toEqual([T.worktrees.at(-1)]);
  });
});
