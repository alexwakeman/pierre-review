// DEPENDENCY AUTOMATION ON THE SANDBOX ROUTE, end to end with NO CLICK: the REAL dependency tick
// (merge/dependency-automation.ts), the REAL ai-fix manager, session machine, fix subject, seed, Claude driver
// (the recorded spike-1 stream) and the REAL push code (coding/ai-fix/push.ts), on a scratch SQLite — with
// REAL GIT where the merge happens: the FAKE runtime answers each sandbox exec by running Limn's own scripts
// (fix-merge.ts, patches.ts) on a local repository shaped as the sandbox makes it, and the host's check
// (merge-verify.ts) runs against a local clone playing the clone cache. The edges are fakes: GitHub (the
// live PR read, head, diff), the push itself (`ctx.coding.pushMerge` / `applyAndPush`), the CI review's
// items, the live CI read, and the agent's typing (`agentWork` edits the local repository).
//
//   conflict only → ONE unattended session with the merge item → Limn's check passes → pushed (pushMerge,
//     pinned to the PR head and the checked commits), no click → "Resolved with Claude and pushed …";
//   CI only → ONE unattended session (plain seed, the live log excerpt) → the patch pushed onto the PR's own
//     branch (applyAndPush, compare-and-set on the head) → "Fixed with Claude and pushed …";
//   conflicting AND red → ONE session with the merge item AND the CI review's fixable item (merge first),
//     ONE `ai_resolve` row (one AI run), pushed through pushMerge;
//   a merge Limn refuses (a marker left) → nothing pushed, the reason in the dependency log;
//   a person's Stop while the unattended turn runs → "Cancelled.", nothing pushed, never retried at the head.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiReviewItem } from '@pierre-review/shared';
import { EXTRACT_MERGE_SCRIPT, FETCH_INTO_REPO_SCRIPT, READ_OUT_SCRIPT, START_MERGE_FILE, START_MERGE_SCRIPT } from './fix-merge.js';
import { EXTRACT_SCRIPT } from './patches.js';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-fix-deps-session`}.fix-deps-flow.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.LIMN_AI_PROVIDER = 'claude';
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = vi.hoisted(() => ({ ci: [] as any[], prepared: [] as any[], head: '', live: null as any }));

vi.mock('../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));
vi.mock('../../review/clone-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../review/clone-manager.js')>()),
  repoCloneDir: () => '/nonexistent/limn-test-clone',
  removeWorktreeLocked: async () => {},
  prepBranchWorktree: async () => {
    throw new Error('the session test never checks out on the host');
  },
}));
vi.mock('../../review/ci-review/persist.js', async (orig) => ({
  ...(await orig<typeof import('../../review/ci-review/persist.js')>()),
  getFixableCiItemsForPr: async () => G.ci,
}));
// GitHub, for the dependency tick: the live PR read only. Nothing here writes to GitHub.
vi.mock('../../github/mutations.js', async (orig) => ({
  ...(await orig<typeof import('../../github/mutations.js')>()),
  fetchPrForAutomation: vi.fn(async () => G.live),
  submitPrReview: vi.fn(async () => {
    throw new Error('the test never approves');
  }),
  addIssueComment: vi.fn(async () => {
    throw new Error('the test never comments');
  }),
  updatePullRequestBody: vi.fn(async () => {
    throw new Error('the test never edits a body');
  }),
}));
vi.mock('../../auth/account.js', async (orig) => ({
  ...(await orig<typeof import('../../auth/account.js')>()),
  getAccessToken: vi.fn(async () => 'gho_test'),
  getAccountUserId: vi.fn(async () => null),
}));
vi.mock('../../sync/pr-settle.js', async (orig) => ({
  ...(await orig<typeof import('../../sync/pr-settle.js')>()),
  notePrChangedForPr: vi.fn(async () => {}),
  schedulePrSettle: vi.fn(),
}));

const OUT = readFileSync(fileURLToPath(new URL('../drivers/__fixtures__/claude-interactive.out.jsonl', import.meta.url)), 'utf8').split('\n').filter(Boolean);
const OUTDIR = mkdtempSync(join(tmpdir(), 'limn-deps-flow-out-'));
const ENV = { ...process.env, LIMN_MERGE_OUT: OUTDIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const shRun = (cwd: string, script: string, args: string[]): { code: number; stdout: Buffer; stderr: string } => {
  try {
    return { code: 0, stdout: execFileSync('sh', ['-c', script, 'sh', ...args], { cwd, env: ENV, maxBuffer: 64 << 20 }), stderr: '' };
  } catch (e: any) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: Buffer.from(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
};

const BASE_FILE = '{ "dependencies": { "lodash": "4.17.20" } }\n';
const PR_FILE = '{ "dependencies": { "lodash": "4.17.21" } }\n';
const MAIN_FILE = '{ "dependencies": { "lodash": "4.17.20", "zod": "3.0.0" } }\n';
const RESOLVED = '{ "dependencies": { "lodash": "4.17.21", "zod": "3.0.0" } }\n';
const TITLE = 'Bump lodash from 4.17.20 to 4.17.21';

let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let F: typeof import('./fix.js');
let AF: typeof import('../../coding/ai-fix/manager.js');
let auto: typeof import('../../merge/dependency-automation.js');
let fake: import('../runtime/fake.js').FakeRuntime;
let api = 0;
let prId = 0;
let botId = 0;
let wsId = 0;
let scratch = '';
let origin = '';
let cache = '';
let H = '';
let B = '';
let MB = '';
let reportAnswer: string | null = null;
let agentWork: (dir: string) => void = () => {};
/** While set, a user turn waits for it (a turn provably running). */
let gate: Promise<void> | null = null;
const pushMerges: any[] = [];
const applies: any[] = [];
const local = new Map<string, string>();
let boots = 0;
const log = { info() {}, warn() {}, error() {} } as any;

function scriptFake(rt: import('../runtime/fake.js').FakeRuntime): void {
  rt.onExec((argv) => argv[0] === 'node' && argv[1] === '-e', async (c) => {
    for await (const _l of c.stdin) void _l;
    c.stdout('{"ok":true}');
    return 0;
  });
  const follow = rt.followLogs.bind(rt);
  rt.followLogs = (container, o) => {
    const h = follow(container, o);
    setTimeout(() => rt.emitLog(container, '{"t":"x","kind":"ready","count":11}'), 1);
    return h;
  };
  rt.onExec((argv) => argv[0] === 'sh' && /git config --global user\.name/.test(argv[2] ?? ''), { code: 0 });
  // The PR repository's clone: a SHALLOW local repository at the PR head.
  rt.onExec((argv) => argv[0] === 'sh' && /git checkout --quiet -B "\$branch"/.test(argv[2] ?? ''), async (c) => {
    for await (const _l of c.stdin) void _l;
    const [dest, branch, sha] = [c.argv[4]!, c.argv[5]!, c.argv[6]!];
    const dir = join(scratch, `sb${++boots}`);
    git(scratch, 'init', '-q', dir);
    git(dir, 'config', 'user.email', 'sandbox@limn.invalid');
    git(dir, 'config', 'user.name', 'Limn sandbox');
    git(dir, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', `file://${origin}`, `${sha}:refs/limn/base`);
    git(dir, 'checkout', '-q', '-B', branch, sha);
    local.set(dest, dir);
    c.stdout(`${sha}\n`);
    return 0;
  });
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === FETCH_INTO_REPO_SCRIPT, async (c) => {
    for await (const _l of c.stdin) void _l;
    const [path, ref, sha] = [c.argv[4]!, c.argv[5]!, c.argv[6]!];
    git(local.get(path)!, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', `file://${origin}`, `${sha}:${ref}`);
    c.stdout(`${sha}\n`);
    return 0;
  });
  rt.onExec((argv) => argv[0] === 'sh' && argv[1] === START_MERGE_FILE, async (c) => {
    const dir = local.get(c.argv[2]!)!;
    const r = shRun(dir, START_MERGE_SCRIPT, [dir, c.argv[3]!]);
    c.stdout(r.stdout);
    c.stderr(r.stderr);
    return r.code;
  });
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === EXTRACT_MERGE_SCRIPT, async (c) => {
    const dir = local.get(c.argv[4]!)!;
    agentWork(dir);
    const r = shRun(dir, EXTRACT_MERGE_SCRIPT, [dir]);
    c.stdout(r.stdout);
    c.stderr(r.stderr);
    return r.code;
  });
  // A fix with no merge: Limn's own patch extraction, for real, on the local repository.
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === EXTRACT_SCRIPT, async (c) => {
    const dir = local.get(c.argv[4]!)!;
    agentWork(dir);
    const r = shRun(dir, EXTRACT_SCRIPT, [dir]);
    c.stdout(r.stdout);
    c.stderr(r.stderr);
    return r.code;
  });
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === READ_OUT_SCRIPT, async (c) => {
    const r = shRun(scratch, READ_OUT_SCRIPT, [join(OUTDIR, c.argv[4]!.split('/').pop()!), c.argv[5]!]);
    c.stdout(r.stdout);
    return r.code;
  });
  rt.onExec((argv) => argv[0] === 'sh' && /head -c/.test(argv[2] ?? '') && argv[2] !== READ_OUT_SCRIPT, async (c) => {
    if (reportAnswer == null) return 4;
    c.stdout(reportAnswer);
    return 0;
  });
  rt.onExec((argv) => argv[0] === 'rm' && argv[1] === '-f', { code: 0 });
  rt.onExec((argv) => argv[0] === 'pkill', { code: 0 });
  rt.onExec((argv) => argv[0] === 'claude', async (c) => {
    let build = c.argv.includes('bypassPermissions') && c.argv[c.argv.indexOf('--permission-mode') + 1] === 'bypassPermissions';
    const emit = (a: number, b: number): void => {
      for (let i = a; i <= b; i++) c.stdout(`${OUT[i]}\n`);
    };
    for await (const line of c.stdin) {
      const msg = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype: string } };
      const kind = msg.type === 'control_request' ? msg.request!.subtype : msg.type;
      if (kind === 'initialize') emit(0, 0);
      else if (kind === 'set_permission_mode') {
        build = true;
        c.stdout(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode: 'bypassPermissions' } } })}\n`);
      } else if (kind === 'interrupt') {
        c.stdout(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } })}\n`);
      } else if (kind === 'user') {
        const g = gate;
        void (async () => {
          if (g) await g;
          try {
            if (build) emit(48, 79);
            else emit(1, 11);
          } catch {
            /* the session closed meanwhile */
          }
        })();
      }
    }
    return 0;
  });
}

const ciItem = (id: number): CiReviewItem =>
  ({
    id, ciReviewId: 1, path: 'package.json', line: 1, suggestion: null, ref: `F${id}`, checkName: 'test', jobId: id, step: 'Run tests',
    url: null, sent: true, carried: false, status: 'diagnosed', notCheckedReason: null, cause: 'zod is missing from the lock file.', explanation: null,
    category: 'test', fixableInPr: true, relatedFiles: [{ path: 'package.json', line: 1 }], assessedAtHead: H,
  }) as CiReviewItem;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'limn-fix-deps-'));
  origin = join(scratch, 'origin');
  git(scratch, 'init', '-q', '-b', 'main', origin);
  git(origin, 'config', 'user.email', 'o@x');
  git(origin, 'config', 'user.name', 'o');
  writeFileSync(join(origin, 'package.json'), BASE_FILE);
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'base');
  MB = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-qb', 'dependabot/npm_and_yarn/lodash-4.17.21');
  writeFileSync(join(origin, 'package.json'), PR_FILE);
  git(origin, 'commit', '-qam', TITLE);
  H = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  writeFileSync(join(origin, 'package.json'), MAIN_FILE);
  git(origin, 'commit', '-qam', 'add zod');
  B = git(origin, 'rev-parse', 'HEAD');
  cache = join(scratch, 'cache');
  execFileSync('git', ['clone', '-q', '--no-checkout', `file://${origin}`, cache], { env: ENV });
  git(cache, 'fetch', '-q', 'origin', 'dependabot/npm_and_yarn/lodash-4.17.21:refs/heads/dependabot/npm_and_yarn/lodash-4.17.21');

  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  const { eq } = await import('drizzle-orm');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  wsId = await q.ensureDefaultWorkspace(1);
  const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R-api', owner: 'acme', name: 'api', defaultBranch: 'main', viewerPermission: 'WRITE' }).returning().execute();
  api = r.id;
  await q.resolveWorkspaceScope(1, null);
  botId = (await db.insert(schema.users).values({ githubLogin: 'dependabot[bot]', isBot: true }).returning().execute())[0].id;
  await db
    .insert(schema.workspaceReviewers)
    .values({ accountId: 1, workspaceId: wsId, authorUserId: botId, automated: true, role: 'dependency', confidence: 'high', source: 'auto', kind: 'dependabot' })
    .execute();
  prId = (
    await db
      .insert(schema.pullRequests)
      .values({
        accountId: 1, repoId: api, githubNodeId: 'PR-7', number: 7, title: TITLE, body: 'Bumps lodash from 4.17.20 to 4.17.21.',
        authorId: botId, state: 'open', isDraft: false, headSha: H, headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21', baseRefName: 'main',
        ciStatus: 'success', reviewDecision: 'review_required', mergeStateStatus: 'dirty', mergeable: 'conflicting', openedAt: new Date(), updatedAt: new Date(),
      })
      .returning()
      .execute()
  )[0].id;
  // No limn/deps lines: the team-claims switch off (nothing read or posted on GitHub).
  await db.update(schema.workspaces).set({ teamClaimsEnabled: false }).where(eq(schema.workspaces.id, wsId)).execute();

  M = await import('./manager.js');
  F = await import('./fix.js');
  AF = await import('../../coding/ai-fix/manager.js');
  auto = await import('../../merge/dependency-automation.js');
  const { createFakeRuntime } = await import('../runtime/fake.js');
  const { startEgress } = await import('../proxy/egress.js');
  const { verifyMergeBundle } = await import('../../coding/ai-fix/merge-verify.js');
  fake = createFakeRuntime();
  scriptFake(fake);
  const claudeDir = join(scratch, 'claude');
  M.setSessionDepsForTests({
    runtime: () => fake,
    settings: async () => null,
    places: () => ({ claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [] }, home: '/nowhere', dataDir: '/nowhere/.limn' }),
    mirrorSeams: {
      prepare: async (req) => {
        G.prepared.push(req);
        return { sha: req.baseSha!, dir: '/fake', cleanup: async () => {} };
      },
      async *tarGitDir() {
        yield Buffer.from('tar');
      },
    },
    startEgress: (o) =>
      startEgress({
        ...o,
        credentialsFor: () => ({ creds: { anthropicOauth: 'REAL-SECRET', anthropicApiKey: null }, problem: null }),
        store: { list: async () => [], add: async (_a, _w, rule) => ({ ok: true, rule, added: true }) },
      }),
    credentialEnv: () => ({}),
    usageSink: { record: async () => {}, noteClaudeRateLimit: () => {} },
  });
  F.setFixSessionDepsForTests({
    contextTicket: async () => null,
    mergePlan: async () => ({ baseSha: B, mergeBaseSha: MB }),
    verifyMerge: async (a) =>
      verifyMergeBundle({ gitDir: cache, bundle: a.bundle, headSha: a.headSha, baseSha: a.baseSha, baseRef: a.baseRef, conflictedFiles: a.conflictedFiles, resultRef: `refs/pierre/ai-fix/${a.fixId}/merge/result` }),
  });
  ctx = {
    db,
    schema,
    log,
    accountIdOf: () => 1,
    llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async () => {},
    github: {
      fetchPrHeadInfo: async () => ({ headSha: H, headRef: 'dependabot/npm_and_yarn/lodash-4.17.21', headRepoFullName: 'acme/api', isFork: false, maintainerCanModify: false, baseRef: 'main' }),
      fetchPrDiff: async () => 'diff --git a/package.json b/package.json\n+x\n',
    },
    coding: {
      applyAndPush: async (a: any) => {
        applies.push(a);
        return { pushedBranch: 'dependabot/npm_and_yarn/lodash-4.17.21', commitSha: 'c0ffee1234567' };
      },
      pushMerge: async (a: any) => {
        pushMerges.push(a);
        return { pushedBranch: 'dependabot/npm_and_yarn/lodash-4.17.21', commitSha: 'feed1234567' };
      },
    },
  };
});

afterAll(async () => {
  auto?.__testing.reset();
  await M?._closeAllSessionsForTest();
  M?.setSessionDepsForTests(null);
  F?.setFixSessionDepsForTests(null);
  await closeDb?.();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(OUTDIR, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const LATER = () => Date.now() + 2 * 60 * 60_000;
const actions = async (): Promise<any[]> => db.select().from(schema.dependencyAutomationActions).execute();
const aiRows = async (): Promise<any[]> => (await actions()).filter((r) => r.action === 'ai_resolve' || r.action === 'ai_fix');
async function lastFix(): Promise<any> {
  const { desc, eq } = await import('drizzle-orm');
  return (await db.select().from(schema.aiFixes).where(eq(schema.aiFixes.prId, prId)).orderBy(desc(schema.aiFixes.id)).limit(1).execute())[0];
}
async function setPr(set: Record<string, unknown>): Promise<void> {
  const { eq } = await import('drizzle-orm');
  await db.update(schema.pullRequests).set(set).where(eq(schema.pullRequests.id, prId)).execute();
}
async function tickAndSettle(): Promise<void> {
  await auto.runDependencyAutomationTick(log, LATER());
  await auto.__testing.settle(60_000);
  await M._sessionsIdleForTest();
}
const resolveMerge = (dir: string, text: string): void => {
  writeFileSync(join(dir, 'package.json'), text);
  git(dir, 'add', 'package.json');
  git(dir, 'commit', '-q', '--no-edit');
};

beforeEach(async () => {
  auto.__testing.reset();
  auto.bindDependencyAutomationAi(ctx);
  // The live CI read (the CI fix's proof) is GitHub's: one failing check with its log excerpt.
  auto.__testing.setAiFixDeps({
    readFailures: async () => ({ failures: [{ checkName: 'test', step: 'Run tests', excerpt: "Cannot find module 'zod'" }], otherFailing: [] }),
    pollMs: 20,
  });
  await db.delete(schema.dependencyAutomationActions).execute();
  await db.delete(schema.autoMergePolicySkips).execute();
  // Dependabot was asked to rebase at this head long ago: the conflict steps go straight to the AI.
  await db.insert(schema.dependencyAutomationActions).values({ accountId: 1, prId, headSha: H, action: 'rebase_request', state: 'done' }).execute();
  await auto.setDependencyAutomation(1, wsId, {
    autoApprove: false,
    autoResolveConflicts: true,
    autoFix: true,
    maxLevel: 'major',
    securityOnly: false,
    ecosystems: null,
    trustedBotIds: [botId],
  });
  G.ci = [];
  G.live = { state: 'open', isDraft: false, headSha: H, headRef: 'dependabot/npm_and_yarn/lodash-4.17.21', baseRef: 'main', isFork: false, title: TITLE, body: 'Bumps lodash from 4.17.20 to 4.17.21.', authorLogin: 'dependabot[bot]', labels: [] };
  pushMerges.length = 0;
  applies.length = 0;
  gate = null;
  agentWork = () => {};
  reportAnswer = null;
});

describe('dependency automation on the sandbox route, no click', () => {
  it('conflict only: ONE unattended session merges, Limn checks it, and it is pushed onto the bot\'s branch', async () => {
    await setPr({ ciStatus: 'success', mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    agentWork = (dir) => {
      if (git(dir, 'rev-list', '--merges', '--count', 'HEAD') === '0') resolveMerge(dir, RESOLVED);
    };
    reportAnswer = JSON.stringify({ summary: 'Merged main.', commitMessage: 'merge main', changes: [{ path: 'package.json', summary: 'Kept lodash 4.17.21 and zod.', refs: ['MERGE'] }], unaddressed: [] });
    await tickAndSettle();
    const fix = await lastFix();
    expect(fix).toMatchObject({ trigger: 'auto', seed: 'plain', status: 'succeeded', sessionPhase: 'pushed' });
    expect(JSON.parse(fix.reviewItems).map((i: any) => i.ref)).toEqual(['MERGE']);
    // Pushed with no click: the merge, pinned to the PR head, the base tip and the commits Limn checked.
    expect(pushMerges).toHaveLength(1);
    const merge = fix.mergeJson;
    expect(pushMerges[0]).toMatchObject({ fixId: fix.id, prNumber: 7, headSha: H, baseRef: 'main', baseSha: B, expectedMergeSha: merge.mergeSha, expectedResultSha: merge.resultSha });
    expect(applies).toEqual([]);
    expect(await aiRows()).toEqual([expect.objectContaining({ action: 'ai_resolve', state: 'done', resultSha: 'feed1234567', detail: 'Resolved with Claude and pushed feed123' })]);
  });

  it('CI only: ONE unattended session fixes it and the patch is pushed onto the PR\'s own branch, compare-and-set on the head', async () => {
    await setPr({ ciStatus: 'failure', mergeStateStatus: 'blocked', mergeable: 'mergeable' });
    agentWork = (dir) => {
      writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
    };
    reportAnswer = JSON.stringify({ summary: 'Updated the lock file.', commitMessage: 'fix: update the lock file', changes: [{ path: 'package-lock.json', summary: 'Regenerated.', refs: [] }], unaddressed: [] });
    await tickAndSettle();
    const fix = await lastFix();
    expect(fix).toMatchObject({ trigger: 'auto', seed: 'plain', status: 'succeeded', sessionPhase: 'pushed' });
    expect(fix.prompt).toContain("Cannot find module 'zod'");
    expect(pushMerges).toEqual([]);
    expect(applies).toHaveLength(1);
    expect(applies[0]).toMatchObject({ baseSha: H, target: { kind: 'existing', headRef: 'dependabot/npm_and_yarn/lodash-4.17.21' } });
    expect(applies[0].patch).toContain('package-lock.json');
    expect(await aiRows()).toEqual([expect.objectContaining({ action: 'ai_fix', state: 'done', resultSha: 'c0ffee1234567', detail: 'Fixed with Claude and pushed c0ffee1' })]);
  });

  it('conflicting AND red: ONE session with the merge and the CI item (merge first), ONE run counted, pushed', async () => {
    await setPr({ ciStatus: 'failure', mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    G.ci = [ciItem(1)];
    agentWork = (dir) => {
      if (git(dir, 'rev-list', '--merges', '--count', 'HEAD') !== '0') return;
      resolveMerge(dir, RESOLVED);
      writeFileSync(join(dir, 'package-lock.json'), '{ "lockfileVersion": 3, "zod": "3.0.0" }\n');
      git(dir, 'add', 'package-lock.json');
      git(dir, 'commit', '-qm', 'fix: add zod to the lock file');
    };
    reportAnswer = JSON.stringify({
      summary: 'Merged main, then fixed the lock file.',
      commitMessage: 'fix: add zod to the lock file',
      changes: [
        { path: 'package.json', summary: 'Kept lodash 4.17.21 and zod.', refs: ['MERGE'] },
        { path: 'package-lock.json', summary: 'Added zod.', refs: ['C1'] },
      ],
      unaddressed: [],
    });
    await tickAndSettle();
    const fix = await lastFix();
    expect(fix).toMatchObject({ trigger: 'auto', seed: 'review', sourceReviewId: null, status: 'succeeded', sessionPhase: 'pushed' });
    expect(JSON.parse(fix.reviewItems).map((i: any) => [i.ref, i.kind])).toEqual([['MERGE', 'merge_conflicts'], ['C1', 'ci_failure']]);
    // Limn's preamble, then "merge first", then the items.
    expect(fix.prompt).toMatch(/^This pull request is a dependency update opened by Dependabot\. It conflicts with main, and its CI fails\./);
    expect(fix.prompt).toContain('Resolve the merge conflicts (MERGE) first');
    expect(fix.patch).toContain('package-lock.json');
    expect(fix.patch).not.toContain('package.json\n');
    expect(pushMerges).toHaveLength(1);
    expect(pushMerges[0]).toMatchObject({ fixId: fix.id, headSha: H, baseSha: B, fixMessage: 'fix: add zod to the lock file' });
    // ONE row, one AI run against the cap: no separate CI fix.
    expect(await aiRows()).toEqual([expect.objectContaining({ action: 'ai_resolve', state: 'done', detail: 'Resolved conflicts and fixed CI with Claude and pushed feed123' })]);
    // A later tick at the same head starts nothing.
    const before = (await lastFix()).id;
    await tickAndSettle();
    expect((await lastFix()).id).toBe(before);
  });

  it('a merge Limn refuses: nothing pushed, the reason in the dependency log, never retried at the head', async () => {
    await setPr({ ciStatus: 'success', mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    agentWork = (dir) => {
      if (git(dir, 'rev-list', '--merges', '--count', 'HEAD') !== '0') return;
      git(dir, 'add', 'package.json');
      git(dir, 'commit', '-q', '--no-edit');
    };
    reportAnswer = JSON.stringify({ summary: 'Merged.', commitMessage: 'merge', changes: [{ path: 'package.json', summary: 'Resolved.', refs: ['MERGE'] }], unaddressed: [] });
    await tickAndSettle();
    const fix = await lastFix();
    expect(fix.mergeJson).toMatchObject({ status: 'invalid', reason: 'package.json still has a conflict marker in the merge commit.' });
    expect(pushMerges).toEqual([]);
    expect(applies).toEqual([]);
    expect(await aiRows()).toEqual([
      expect.objectContaining({ action: 'ai_resolve', state: 'failed', detail: 'Not pushed: package.json still has a conflict marker in the merge commit.' }),
    ]);
    await tickAndSettle();
    expect((await lastFix()).id).toBe(fix.id);
  });

  it("a person's Stop while the unattended turn runs wins: cancelled, nothing pushed, never retried at the head", async () => {
    await setPr({ ciStatus: 'success', mergeStateStatus: 'dirty', mergeable: 'conflicting' });
    agentWork = (dir) => {
      if (git(dir, 'rev-list', '--merges', '--count', 'HEAD') === '0') resolveMerge(dir, RESOLVED);
    };
    reportAnswer = JSON.stringify({ summary: 'Merged.', commitMessage: 'merge', changes: [{ path: 'package.json', summary: 'Resolved.', refs: ['MERGE'] }], unaddressed: [] });
    let release: () => void = () => {};
    gate = new Promise<void>((r) => (release = r));
    await auto.runDependencyAutomationTick(log, LATER());
    const end = Date.now() + 30_000;
    let fixId: number | null = null;
    while (Date.now() < end) {
      fixId = (await lastFix())?.id ?? null;
      if (fixId != null && F.fixTurnRunning(fixId)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fixId != null && F.fixTurnRunning(fixId)).toBe(true);
    expect(await AF.requestFixCancel(ctx, 1, prId)).toBe(true);
    release();
    await auto.__testing.settle(60_000);
    await M._sessionsIdleForTest();
    expect((await lastFix()).status).toBe('cancelled');
    expect(pushMerges).toEqual([]);
    expect(await aiRows()).toEqual([expect.objectContaining({ action: 'ai_resolve', state: 'failed', detail: 'Cancelled.' })]);
    gate = null;
    await tickAndSettle();
    expect((await lastFix()).id).toBe(fixId);
  });
});
