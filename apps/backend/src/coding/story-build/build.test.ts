// ONE REPOSITORY'S BUILD (build.ts `buildRepo`) through a FAKE provider on a REAL scratch git worktree.
// What is pinned:
//   • the run: kind `story_build`, a write run on the worktree ONLY, Bash denied, the write deny-list on
//     (`protectWrites`), the earlier repositories' worktrees as READ-ONLY roots, the session's model;
//   • the result: the patch and files from git, the report validated against the shown refs, the kept
//     worktree, the ledger row written ONCE (Claude: by buildRepo; never twice);
//   • "Run tests": checks that cannot start never fail the repository; a failing pre-commit hook goes
//     back to the agent at most MAX_HOOK_REPAIRS times;
//   • refusals: a plan changed since Accept, the budget spent, nothing changed, a patch over the cap,
//     a cancel (worktree released, spend still reported).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryBuildPlan } from '@pierre-review/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-story-build-test-')));
  process.env.DATABASE_URL = path.join(root, 'unused.sqlite');
  process.env.DISABLE_SCHEDULER = 'true';
  return {
    root,
    specs: [] as any[],
    /** What the fake agent does on each pass (index = pass number). */
    behave: [] as Array<(spec: any) => Promise<void> | void>,
    removed: [] as string[],
    prepped: [] as any[],
    checks: null as any,
  };
});

vi.mock('../../auth/account.js', () => ({ getAccessToken: async () => 'gh-token' }));
vi.mock('../../review/auth.js', () => ({ applyClaudeReviewAuth: () => () => {} }));
vi.mock('../../reference-docs/context.js', () => ({ reviewDocsFor: async () => null }));
vi.mock('../checks/index.js', () => ({
  openCheckSession: async () => T.checks,
}));
vi.mock('../../review/clone-manager.js', () => ({
  prepBranchWorktree: async (owner: string, name: string, ref: any) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    T.prepped.push({ owner, name, ref });
    const clone = fs.mkdtempSync(path.join(T.root, `${owner}__${name}-`));
    const wt = path.join(clone, '.worktrees', `${ref.sha}-1-${T.prepped.length}`);
    fs.mkdirSync(wt, { recursive: true });
    const git = (...a: string[]) => cp.execFileSync('git', ['-C', wt, ...a], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(wt, 'app.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return { repoCloneDir: clone, worktreePath: wt, sha: ref.sha };
  },
  removeWorktreeLocked: async (_o: string, _n: string, _c: string, wt: string) => {
    T.removed.push(wt);
  },
  scrubGitError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../../ai/provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../ai/provider.js')>();
  const fake = {
    id: 'claude',
    resolveModel: (c: any) => c.id ?? 'claude-opus-5-5',
    runAgent: async (spec: any) => {
      T.specs.push(spec);
      const step = T.behave[T.specs.length - 1] ?? T.behave.at(-1);
      await step?.(spec);
      const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 };
      spec.onProgress?.({ kind: 'step', lines: ['Edited a file'], text: '', usage });
      if (spec.abortController.signal.aborted) return { outcome: null };
      const outcome = {
        subtype: 'success',
        text: null,
        costUsd: 0.5,
        numTurns: 3,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      spec.onProgress?.({ kind: 'outcome', outcome });
      return { outcome };
    },
  };
  return { ...real, getProvider: () => fake, getActiveProvider: () => fake };
});

const { buildRepo, STORY_BUILD_TOOLS, STORY_BUILD_DISALLOWED_TOOLS } = await import('./build.js');
const { MAX_HOOK_REPAIRS } = await import('../agent.js');

afterAll(() => rmSync(T.root, { recursive: true, force: true }));

const submit = (spec: any, payload: any) => spec.tools.tools[0].handle(payload);
const writeIn = (spec: any, file: string, text: string) => writeFileSync(join(spec.cwd, file), text);

const PLAN: StoryBuildPlan = {
  revision: 2,
  summary: 'Add card refunds. The API gets an endpoint.',
  repos: [
    { ref: 'R1', repoId: 11, why: 'The endpoint.', branchSlug: 'refunds-api', steps: [{ title: 'Endpoint', files: ['app.ts'], change: 'Add it.', refs: ['AC1'] }], tests: ['A test'] },
    { ref: 'R2', repoId: 12, why: 'The button.', branchSlug: 'refunds-web', steps: [{ title: 'Button', files: ['app.ts'], change: 'Add it.', refs: ['AC2'] }], tests: [] },
  ],
  readOnlyRepos: [],
  criteria: [
    { ref: 'AC1', how: 'planned', repo: 'R1', reason: null },
    { ref: 'AC2', how: 'planned', repo: 'R2', reason: null },
  ],
  risks: [],
};

const recorded: any[] = [];
const ctx: any = {
  log: { warn: () => {}, info: () => {} },
  llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
  recordAiUsage: async (row: any) => {
    recorded.push(row);
  },
};

const build = (over: Record<string, unknown> = {}): any => ({
  id: 5,
  accountId: 1,
  workspaceId: 3,
  ident: 'jira:https://acme.atlassian.net#ACME-214',
  ticketKey: 'ACME-214',
  ticketTitle: 'Refunds by card',
  status: 'building',
  provider: 'claude',
  model: 'claude-opus-5-5',
  planJson: PLAN,
  acceptedRevision: 2,
  candidatesJson: [
    { ref: 'R1', repoId: 11, fullName: 'acme/api', source: 'picked', baseRef: 'main', baseSha: 'b1', stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
    { ref: 'R2', repoId: 12, fullName: 'acme/web', source: 'picked', baseRef: 'main', baseSha: 'b2', stackedOnPrId: null, stackedOnPrNumber: null, baseNote: null },
  ],
  coverageJson: {
    state: 'none',
    ticketReviewId: null,
    checkedAt: null,
    criteria: [
      { ref: 'AC1', text: 'A refund endpoint exists', verdict: 'not_checked', coveredByPrIds: [] },
      { ref: 'AC2', text: 'A refund button exists', verdict: 'not_checked', coveredByPrIds: [] },
    ],
    missing: [],
    existingPrs: [],
    note: null,
  },
  seedJson: { version: 1, story: { key: 'ACME-214', title: 'Refunds by card', text: 'Let support refund.', url: null }, criteria: [], comments: null, cards: [] },
  ...over,
});
const repoRow = (over: Record<string, unknown> = {}): any => ({
  id: 41,
  accountId: 1,
  buildId: 5,
  repoId: 12,
  ref: 'R2',
  buildOrder: 1,
  include: true,
  status: 'queued',
  baseRef: 'main',
  baseSha: 'b2',
  stackedOnPrId: null,
  branch: 'acme-214-refunds-web',
  worktreePath: null,
  checksWantedJson: [],
  ...over,
});
const args = (over: Record<string, unknown> = {}): any => ({
  accountId: 1,
  build: build(),
  repo: repoRow(),
  fullName: 'acme/web',
  earlier: [],
  docs: { included: '', superseded: '', pending: 0 },
  nonce: 'n0nce42',
  budgetLeftUsd: 20,
  onProgress: () => {},
  signal: new AbortController().signal,
  ...over,
});

beforeEach(() => {
  T.specs.length = 0;
  T.behave.length = 0;
  T.removed.length = 0;
  T.prepped.length = 0;
  T.checks = null;
  recorded.length = 0;
});

describe('buildRepo', () => {
  it('builds one repository: a write run on its worktree only, earlier trees read-only, no shell, the deny-list on', async () => {
    const earlierWt = realpathSync(mkdtempSync(join(tmpdir(), 'limn-earlier-')));
    T.behave.push((spec) => {
      writeIn(spec, 'refund.ts', 'export const refund = 1;\n');
      submit(spec, {
        summary: 'Added the refund button. It calls the new endpoint.',
        commitMessage: 'feat: refund button',
        changes: [{ path: 'refund.ts', summary: 'The button.', refs: ['AC2', 'AC9'] }],
      });
    });
    const progress: any[] = [];
    const res = await buildRepo(
      ctx,
      args({
        onProgress: (p: any) => progress.push(p),
        earlier: [{ repo: repoRow({ id: 40, repoId: 11, ref: 'R1', status: 'ready', summary: 'Endpoint done.', changeReportJson: { changes: [{ path: 'api.ts', summary: 'x', refs: [] }], unaddressed: [], notReported: [] } }), fullName: 'acme/api', worktreePath: earlierWt }],
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.filesChanged).toEqual(['refund.ts']);
    expect(res.patch).toContain('+export const refund = 1;');
    expect(res.summary).toBe('Added the refund button. It calls the new endpoint.');
    expect(res.commitMessage).toBe('feat: refund button');
    // AC9 was never shown: dropped. AC2 delivered.
    expect(res.changeReport).toEqual({ changes: [{ path: 'refund.ts', summary: 'The button.', refs: ['AC2'] }], unaddressed: [], notReported: [] });
    expect(res).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', costUsd: 0.5, inputTokens: 100, outputTokens: 20, numTurns: 3 });
    // The worktree is KEPT for the later repositories.
    expect(res.worktreePath).toBeTruthy();
    expect(existsSync(res.worktreePath!)).toBe(true);
    expect(T.removed).toEqual([]);
    // Fetched at the stored base, into the namespaced ref.
    expect(T.prepped[0]).toMatchObject({ owner: 'acme', name: 'web', ref: { remoteRef: 'refs/heads/main', destRef: 'refs/pierre/story-build-base', sha: 'b2' } });

    const spec = T.specs[0];
    expect(spec.kind).toBe('story_build');
    expect(spec.cwd).toBe(res.worktreePath);
    expect(spec.writeRoots).toEqual([res.worktreePath]);
    expect(spec.roots).toEqual([]);
    expect(spec.readOnlyRoots).toEqual([earlierWt]);
    expect(spec.protectWrites).toBe(true);
    expect(spec.claude.allowedTools).toEqual(STORY_BUILD_TOOLS);
    expect(spec.claude.disallowedTools).toEqual(STORY_BUILD_DISALLOWED_TOOLS);
    expect(spec.claude.disallowedTools).toContain('Bash');
    expect(spec.tools.server).toBe('build');
    expect(spec.tools.tools.map((t: any) => t.name)).toEqual(['submit_build']);
    expect(spec.usageRecord).toMatchObject({ feature: 'story_build', repoId: 12 });
    // The brief: this repository's refs, the earlier repository's report and read-only tree, fenced.
    expect(spec.prompt).toContain('YOUR REFS: AC2.');
    expect(spec.prompt).toContain(`its worktree is at ${earlierWt} (read only)`);
    expect(spec.prompt).toContain('---BEGIN AGREED PLAN n0nce42---');
    expect(spec.prompt).toContain('---BEGIN REPORT FROM R1 n0nce42---');
    expect(spec.system).toContain('NO shell here');
    // ONE ledger row, written by buildRepo (a Claude run does not record its own).
    expect(recorded).toEqual([expect.objectContaining({ accountId: 1, feature: 'story_build', seam: 'agent', costUsd: 0.5, repoId: 12, provider: 'claude' })]);
    expect(progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['preparing', 'building', 'capturing']));
    expect(progress.every((p) => p.repoId === 12)).toBe(true);
    rmSync(earlierWt, { recursive: true, force: true });
  });

  it('refuses a plan that changed since Accept, and a spent budget, before any checkout', async () => {
    expect(await buildRepo(ctx, args({ build: build({ acceptedRevision: 1 }) }))).toMatchObject({ ok: false, error: expect.stringMatching(/plan changed/) });
    expect(await buildRepo(ctx, args({ budgetLeftUsd: 0.1 }))).toMatchObject({ ok: false, error: 'The session budget is spent.' });
    expect(T.prepped).toEqual([]);
    expect(T.specs).toEqual([]);
  });

  it('refuses a nonce that appears in the story (it could close its own fence)', async () => {
    const res = await buildRepo(ctx, args({ nonce: 'support' }));
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/quoted safely/) });
    expect(T.specs).toEqual([]);
  });

  it('fails a repository that changed nothing, and releases its worktree', async () => {
    T.behave.push((spec) => submit(spec, { summary: 'It was already there.', commitMessage: 'x' }));
    const res = await buildRepo(ctx, args());
    expect(res).toMatchObject({ ok: false, error: 'Nothing was changed in acme/web. It was already there.', costUsd: 0.5 });
    expect(T.removed).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('fails a patch over STORY_BUILD_PATCH_MAX_BYTES', async () => {
    const saved = process.env.STORY_BUILD_PATCH_MAX_BYTES;
    process.env.STORY_BUILD_PATCH_MAX_BYTES = '200';
    try {
      T.behave.push((spec) => writeIn(spec, 'big.ts', 'x'.repeat(1000)));
      const res = await buildRepo(ctx, args());
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/too large to keep/) });
      expect(T.removed).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.STORY_BUILD_PATCH_MAX_BYTES;
      else process.env.STORY_BUILD_PATCH_MAX_BYTES = saved;
    }
  });

  it('a cancel is a clean cancelled result: the tree released, the spend still reported', async () => {
    const ac = new AbortController();
    T.behave.push((spec) => {
      writeIn(spec, 'half.ts', 'x\n');
      ac.abort();
      expect(spec.abortController.signal.aborted).toBe(true);
    });
    const res = await buildRepo(ctx, args({ signal: ac.signal }));
    expect(res).toMatchObject({ ok: false, cancelled: true, error: null });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(T.removed).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('releases the tree an earlier pass kept before building again (Retry)', async () => {
    T.behave.push((spec) => writeIn(spec, 'a.ts', 'a\n'));
    const old = join(T.root, 'acme__web', '.worktrees', 'old-1-1');
    const res = await buildRepo(ctx, args({ repo: repoRow({ worktreePath: old, status: 'queued' }) }));
    expect(res.ok).toBe(true);
    expect(T.removed).toEqual([old]);
  });
});

describe('"Run tests" in a build', () => {
  it('checks that cannot start never fail the repository: the note says why', async () => {
    T.checks = { ok: false, note: 'Tests can’t run here: no sandbox.', skipped: [] };
    T.behave.push((spec) => writeIn(spec, 'b.ts', 'b\n'));
    const res = await buildRepo(ctx, args({ repo: repoRow({ checksWantedJson: ['test'] }) }));
    expect(res.ok).toBe(true);
    expect(res.checks).toMatchObject({ requested: ['test'], ran: false, note: 'Tests can’t run here: no sandbox.' });
    // No run_check tool: the plain list, and the system prompt says nothing runs.
    expect(T.specs[0].claude.allowedTools).toEqual(STORY_BUILD_TOOLS);
    expect(T.specs[0].system).toContain('could not start');
  });

  it('a failing pre-commit hook goes back to the agent at most MAX_HOOK_REPAIRS times, then the build is kept', async () => {
    let hooks = 0;
    let verifies = 0;
    T.checks = {
      ok: true,
      session: {
        agentChecks: [{ name: 'test' }],
        agentTool: () => ({ names: ['test'], description: 'Run a check.', run: async () => ({ text: 'ok' }) }),
        specFile: join(T.root, 'spec.json'),
        notes: [],
        hook: { source: '.husky/pre-commit' },
        prepare: [],
        skipped: [],
        sandbox: 'seatbelt',
        excludesFile: undefined,
        verify: async () => {
          verifies++;
          return [{ name: 'test', kind: 'test', command: 'npm test', status: 'passed', exitCode: 0, durationMs: 5, output: '', truncated: false, note: null }];
        },
        runHook: async () => {
          hooks++;
          return { name: 'pre-commit', kind: 'hook', command: 'git commit', status: 'failed', exitCode: 1, durationMs: 5, output: 'lint: 1 error', truncated: false, note: null };
        },
        restoreGit: () => {},
        agentRuns: () => [],
        close: async () => {},
      },
    };
    T.behave.push((spec) => writeIn(spec, 'c.ts', 'c\n'));
    const res = await buildRepo(ctx, args({ repo: repoRow({ checksWantedJson: ['test'] }) }));
    expect(res.ok).toBe(true);
    // One build pass + MAX_HOOK_REPAIRS repair passes; the hook ran once more after the last repair.
    expect(T.specs).toHaveLength(1 + MAX_HOOK_REPAIRS);
    expect(hooks).toBe(MAX_HOOK_REPAIRS + 1);
    expect(verifies).toBe(2);
    expect(res.checks).toMatchObject({ ran: true, hookAttempts: MAX_HOOK_REPAIRS + 1, hook: { status: 'failed' } });
    // The repair prompt is the build's own (submit_build), the hook output fenced.
    expect(T.specs[1].prompt).toContain('call submit_build again');
    expect(T.specs[1].prompt).toMatch(/---BEGIN PRE-COMMIT HOOK OUTPUT \S+---\nlint: 1 error/);
    // With checks, run_check joins the allow list; Bash stays denied.
    expect(T.specs[0].claude.allowedTools).toContain('mcp__checks__run_check');
    expect(T.specs[0].claude.disallowedTools).toContain('Bash');
    // Spend: three passes, ONE ledger row.
    expect(res.costUsd).toBeCloseTo(1.5);
    expect(recorded).toHaveLength(1);
  });
});

describe('the tree shapes the build may release', () => {
  it('releaseStoryBuildWorktree ignores a path that is not a clone’s per-run tree', async () => {
    const { releaseStoryBuildWorktree } = await import('./build.js');
    await releaseStoryBuildWorktree('acme/web', '/Users/me/Projects/web');
    await releaseStoryBuildWorktree('acme/web', null);
    expect(T.removed).toEqual([]);
    mkdirSync(join(T.root, 'x', '.worktrees', 'e'), { recursive: true });
    await releaseStoryBuildWorktree('acme/web', join(T.root, 'x', '.worktrees', 'e'));
    expect(T.removed).toEqual([join(T.root, 'x', '.worktrees', 'e')]);
    void execFileSync;
  });
});
