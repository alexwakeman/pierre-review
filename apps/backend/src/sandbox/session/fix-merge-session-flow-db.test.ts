// AN AI FIX THAT RESOLVES MERGE CONFLICTS, end to end over the REAL ai-fix routes, manager, session machine,
// fix subject, seed, Claude driver (the recorded spike-1 stream) and push gate, on a scratch SQLite — with
// REAL GIT where the merge happens: the FAKE runtime answers each sandbox exec by running Limn's own script
// (fix-merge.ts) on a local repository shaped as the sandbox makes it, and the host's check
// (merge-verify.ts) runs against a local clone playing the clone cache. Only the agent's typing is a fake:
// `agentWork` edits the local repository before the build turn's extraction.
//
//   the picker offers "Resolve merge conflicts with main" first, ticked; a CI item and the merge together:
//   the base tip and the merge base come in through the mirror seams (pinned), Limn starts the merge,
//   FIX.md says to merge first; the agent's resolution passes Limn's check, the fix ON TOP is the patch, the
//   resolution diff is on the wire, and Push goes through `pushMerge` (never `applyAndPush`) with the PR
//   head and the base tip; a merge with a marker left is MERGE "not addressed" and refuses Push; a merge
//   the agent never committed refuses Push; a "new branch" push of a merge is refused.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiFix, AiFixPickerPreview, AiFixResponse, CiReviewItem } from '@pierre-review/shared';
import { EXTRACT_MERGE_SCRIPT, FETCH_INTO_REPO_SCRIPT, READ_OUT_SCRIPT, START_MERGE_FILE, START_MERGE_SCRIPT } from './fix-merge.js';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-fix-merge-session`}.fix-merge-flow.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.LIMN_AI_PROVIDER = 'claude';
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = vi.hoisted(() => ({ ci: [] as any[], prepared: [] as any[] }));

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

const OUT = readFileSync(fileURLToPath(new URL('../drivers/__fixtures__/claude-interactive.out.jsonl', import.meta.url)), 'utf8').split('\n').filter(Boolean);
// Limn's scripts write their two out-files here, not in the shared /tmp (another test file runs them too).
const OUTDIR = mkdtempSync(join(tmpdir(), 'limn-merge-flow-out-'));
const ENV = { ...process.env, LIMN_MERGE_OUT: OUTDIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const shRun = (cwd: string, script: string, args: string[]): { code: number; stdout: Buffer; stderr: string } => {
  try {
    return { code: 0, stdout: execFileSync('sh', ['-c', script, 'sh', ...args], { cwd, env: ENV, maxBuffer: 64 << 20 }), stderr: '' };
  } catch (e: any) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: Buffer.from(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
};

const BASE_FILE = 'export const limit = 10;\nexport const sep = ",";\n';
const PR_FILE = 'export const limit = 25;\nexport const pageSize = 50;\nexport const sep = ",";\n';
const MAIN_FILE = 'export const limit = 10; // the API caps it\nexport const sep = ",";\n';
const RESOLVED = 'export const limit = 25; // the API caps it\nexport const pageSize = 50;\nexport const sep = ",";\n';

let app: FastifyInstance;
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let F: typeof import('./fix.js');
let fake: import('../runtime/fake.js').FakeRuntime;
let api = 0;
let prA = 0;
let scratch = '';
let origin = '';
let cache = '';
let H = '';
let B = '';
let MB = '';
let reportAnswer: string | null = null;
let agentWork: (dir: string) => void = () => {};
const pushMerges: any[] = [];
const applies: any[] = [];
/** Sandbox path → the local repository standing in for it (one per boot). */
const local = new Map<string, string>();
let boots = 0;

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
  // The PR repository's clone (mirror.ts IN_SANDBOX_CLONE): a SHALLOW local repository at the PR head.
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
  // fix-merge.ts: the base tip and the merge base, fetched into the PR repository.
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
        if (build) emit(48, 79);
        else emit(1, 11);
      }
    }
    return 0;
  });
}

const ciItem = (id: number): CiReviewItem =>
  ({
    id, ciReviewId: 1, path: 'src/a.ts', line: 1, suggestion: null, ref: `F${id}`, checkName: 'test', jobId: id, step: 'Run tests',
    url: null, sent: true, carried: false, status: 'diagnosed', notCheckedReason: null, cause: 'A test fails.', explanation: null,
    category: 'test', fixableInPr: true, relatedFiles: [{ path: 'src/a.ts', line: 1 }], assessedAtHead: H,
  }) as CiReviewItem;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'limn-fix-merge-'));
  origin = join(scratch, 'origin');
  git(scratch, 'init', '-q', '-b', 'main', origin);
  git(origin, 'config', 'user.email', 'o@x');
  git(origin, 'config', 'user.name', 'o');
  writeFileSync(join(origin, 'config.ts'), BASE_FILE);
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'base');
  MB = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-qb', 'feature/export');
  writeFileSync(join(origin, 'config.ts'), PR_FILE);
  git(origin, 'commit', '-qam', 'pr');
  H = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  writeFileSync(join(origin, 'config.ts'), MAIN_FILE);
  git(origin, 'commit', '-qam', 'main');
  B = git(origin, 'rev-parse', 'HEAD');
  cache = join(scratch, 'cache');
  execFileSync('git', ['clone', '-q', '--no-checkout', `file://${origin}`, cache], { env: ENV });
  git(cache, 'fetch', '-q', 'origin', 'feature/export:refs/heads/feature/export');

  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  await q.ensureDefaultWorkspace(1);
  const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R-api', owner: 'acme', name: 'api', defaultBranch: 'main', viewerPermission: 'WRITE' }).returning().execute();
  api = r.id;
  await q.resolveWorkspaceScope(1, null);
  prA = (
    await db
      .insert(schema.pullRequests)
      .values({ accountId: 1, repoId: api, githubNodeId: 'PR-7', number: 7, title: 'Raise the export limit', body: null, state: 'open', headSha: H, baseRefName: 'main', mergeStateStatus: 'dirty', mergeable: 'conflicting', openedAt: new Date(), updatedAt: new Date() })
      .returning()
      .execute()
  )[0].id;

  M = await import('./manager.js');
  F = await import('./fix.js');
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
    log: { info() {}, warn() {}, error() {} },
    accountIdOf: () => 1,
    llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async () => {},
    github: {
      fetchPrHeadInfo: async () => ({ headSha: H, headRef: 'feature/export', headRepoFullName: 'acme/api', isFork: false, maintainerCanModify: false, baseRef: 'main' }),
      fetchPrDiff: async () => 'diff --git a/config.ts b/config.ts\n+x\n',
    },
    coding: {
      applyAndPush: async (a: any) => {
        applies.push(a);
        return { pushedBranch: 'feature/export', commitSha: 'c0ffee' };
      },
      pushMerge: async (a: any) => {
        pushMerges.push(a);
        return { pushedBranch: 'feature/export', commitSha: 'feed123' };
      },
    },
  };
  const Fastify = (await import('fastify')).default;
  const { registerAiFixRoutes } = await import('../../coding/ai-fix/routes.js');
  app = Fastify({ logger: false });
  registerAiFixRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await M?._closeAllSessionsForTest();
  M?.setSessionDepsForTests(null);
  F?.setFixSessionDepsForTests(null);
  await app?.close();
  await closeDb?.();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(OUTDIR, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const post = (url: string, payload: any = {}) => app.inject({ method: 'POST', url, payload });
const get = (url: string) => app.inject({ method: 'GET', url });
const readFix = async (): Promise<AiFix> => ((await get(`/api/pro/prs/${prA}/ai-fix`)).json() as AiFixResponse).fix!;
async function rowOf(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.aiFixes).where(eq(schema.aiFixes.id, id)).execute())[0];
}
async function until(test: (f: AiFix) => boolean, what: string): Promise<AiFix> {
  const end = Date.now() + 60_000;
  for (;;) {
    await M._sessionsIdleForTest();
    const f = await readFix();
    if (f && test(f)) return f;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: status ${f?.status}, phase ${f?.session?.phase}, error ${f?.error}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const notices = (f: AiFix): string[] => (f.session?.conversation ?? []).filter((c) => c.kind === 'notice').map((c) => (c as { text: string }).text);
const resolve = (dir: string, text: string): void => {
  writeFileSync(join(dir, 'config.ts'), text);
  git(dir, 'add', 'config.ts');
  git(dir, 'commit', '-q', '--no-edit');
};
async function startFix(include: string[]): Promise<number> {
  const r = await post(`/api/pro/prs/${prA}/ai-fix`, { seed: 'review', include });
  expect(r.statusCode).toBe(202);
  return r.json().fixId as number;
}

describe('the merge item in the fix picker', () => {
  it('is offered first and ticked when the PR conflicts and the reader can push; never with no conflict', async () => {
    G.ci = [ciItem(1)];
    const p = (await get(`/api/pro/prs/${prA}/ai-fix/preview`)).json() as AiFixPickerPreview;
    expect(p.items[0]).toMatchObject({ key: 'conflict:merge', section: 'conflicts', label: 'Resolve merge conflicts with main', defaultIncluded: true });
    expect(p.items.map((i) => i.key)).toEqual(['conflict:merge', 'ci:1']);
    // With no CI item and no review, the merge alone is still a fix (resolving conflicts needs neither).
    G.ci = [];
    const only = (await get(`/api/pro/prs/${prA}/ai-fix/preview`)).json() as AiFixPickerPreview;
    expect(only.items.map((i) => i.key)).toEqual(['conflict:merge']);
    const { eq } = await import('drizzle-orm');
    await db.update(schema.pullRequests).set({ mergeStateStatus: 'clean', mergeable: 'mergeable' }).where(eq(schema.pullRequests.id, prA)).execute();
    expect((await get(`/api/pro/prs/${prA}/ai-fix/preview`)).statusCode).toBe(409);
    await db.update(schema.pullRequests).set({ mergeStateStatus: 'dirty', mergeable: 'conflicting' }).where(eq(schema.pullRequests.id, prA)).execute();
  });
});

describe('a fix with the merge and a CI item', () => {
  let fixId = 0;
  it('merges in the sandbox first, checks it, stores the fix on top, and pushes through pushMerge', async () => {
    G.ci = [ciItem(1)];
    G.prepared.length = 0;
    agentWork = (dir) => {
      if (git(dir, 'rev-list', '--merges', '--count', 'HEAD') !== '0') return;
      resolve(dir, RESOLVED);
      writeFileSync(join(dir, 'fix.ts'), 'export const fixed = true;\n');
      git(dir, 'add', 'fix.ts');
      git(dir, 'commit', '-qm', 'fix: the failing test');
    };
    reportAnswer = JSON.stringify({
      summary: 'Merged main and fixed the test.',
      commitMessage: 'fix: the failing test',
      changes: [
        { path: 'config.ts', summary: 'Kept both: the raised limit and the cap comment.', refs: ['MERGE'] },
        { path: 'fix.ts', summary: 'Fixed the test.', refs: ['C1'] },
      ],
      unaddressed: [],
    });
    fixId = await startFix(['conflict:merge', 'ci:1']);
    const f = await until((x) => x.session?.phase === 'built', 'built');
    expect(f.status).toBe('succeeded');
    expect(f.reviewItems?.map((i) => [i.ref, i.kind])).toEqual([['MERGE', 'merge_conflicts'], ['C1', 'ci_failure']]);
    // The two commits came in through the mirror seams, pinned under the fix's own refs.
    expect(G.prepared.filter((r) => r.baseSha === B || r.baseSha === MB).map((r) => [r.baseSha, r.pinRef])).toEqual([
      [B, `refs/pierre/ai-fix/${fixId}/merge/base`],
      [MB, `refs/pierre/ai-fix/${fixId}/merge/merge-base`],
    ]);
    // FIX.md says to merge first, and names the commits.
    const copyIn = fake.calls.filter((c) => c.method === 'copyIn');
    const box = String(copyIn[copyIn.length - 1]!.args[0]);
    const copied = copyIn.flatMap((c) => (c.args[1] as string[]).map((path) => ({ path })));
    const mdPath = copied.map((x) => x.path).filter((x) => x.endsWith('/FIX.md')).pop()!;
    const fixMd = fake.files(box).get(mdPath)?.toString('utf8') ?? '';
    expect(fixMd).toContain(`## First: the merge conflicts (MERGE)`);
    expect(fixMd).toContain(`Limn has started a merge of \`main\` at ${B.slice(0, 7)}`);
    expect(fixMd.indexOf('## First: the merge conflicts')).toBeLessThan(fixMd.indexOf('## What to fix'));
    expect(fixMd).toContain('---BEGIN ITEM MERGE');
    expect(copied.some((x) => x.path === START_MERGE_FILE)).toBe(true);
    expect(notices(f).some((n) => n.startsWith(`Limn started the merge of main (${B.slice(0, 7)}): one file is in conflict (config.ts).`))).toBe(true);
    expect(notices(f)).toContain('Limn checked the merge commit: main is merged and the conflict is resolved.');
    expect(f.merge).toMatchObject({ baseRef: 'main', baseSha: B, conflictedFiles: ['config.ts'], status: 'valid', reason: null, resolutionFiles: ['config.ts'] });
    expect(f.merge?.resolutionDiff).toContain('+export const limit = 25; // the API caps it');
    expect(f.patch).toContain('fix.ts');
    expect(f.patch).not.toContain('config.ts');
    expect(f.filesChanged).toEqual(['fix.ts']);
    expect(f.changeReport?.changes.map((c) => [c.path, c.refs])).toEqual([['fix.ts', ['C1']], ['config.ts', ['MERGE']]]);
    expect(f.changeReport?.notReported).toEqual([]);
    const row = await rowOf(fixId);
    expect(typeof row.mergeBundle).toBe('string');

    // A merge pushes only onto the PR's own branch.
    const nb = await post(`/api/pro/ai-fixes/${fixId}/push`, { target: 'new', branch: 'x' });
    expect(nb.statusCode).toBe(409);
    const p = await post(`/api/pro/ai-fixes/${fixId}/push`, { target: 'existing' });
    expect(p.statusCode).toBe(200);
    expect(applies).toEqual([]);
    expect(pushMerges).toHaveLength(1);
    expect(pushMerges[0]).toMatchObject({ fixId, owner: 'acme', name: 'api', prNumber: 7, headSha: H, baseRef: 'main', baseSha: B, conflictedFiles: ['config.ts'], fixMessage: 'fix: the failing test' });
    expect(pushMerges[0].mergeMessage).toMatch(/^Merge main into this pull request\n\nConflicts resolved with Claude in Limn AI Fix\.$/);
    expect(Buffer.isBuffer(pushMerges[0].bundle) && pushMerges[0].bundle.length > 0).toBe(true);
    const after = await rowOf(fixId);
    expect(after.sessionPhase).toBe('pushed');
    expect(after.mergeBundle).toBeNull();
  });
});

describe('a merge Limn refuses', () => {
  beforeAll(async () => {
    // The first describe's session may still hold the PR when it failed half-way.
    const f = await readFix();
    if (f && f.session?.phase !== 'pushed') await post(`/api/pro/ai-fixes/${f.id}/discard`);
    await M._sessionsIdleForTest();
  });

  it('a marker left in: MERGE is "not addressed" with Limn\'s reason, and Push refuses', async () => {
    G.ci = [];
    agentWork = (dir) => {
      if (git(dir, 'rev-list', '--merges', '--count', 'HEAD') !== '0') return;
      git(dir, 'add', 'config.ts');
      git(dir, 'commit', '-q', '--no-edit');
    };
    reportAnswer = JSON.stringify({ summary: 'Merged.', commitMessage: 'merge', changes: [{ path: 'config.ts', summary: 'Resolved.', refs: ['MERGE'] }], unaddressed: [] });
    const fixId = await startFix(['conflict:merge']);
    const f = await until((x) => x.id === fixId && x.session?.phase === 'built', 'built');
    expect(f.merge).toMatchObject({ status: 'invalid', reason: 'config.ts still has a conflict marker in the merge commit.' });
    expect(f.changeReport?.unaddressed).toEqual([{ ref: 'MERGE', reason: 'Limn: config.ts still has a conflict marker in the merge commit.' }]);
    expect(f.changeReport?.changes.flatMap((c) => c.refs)).toEqual([]);
    expect(notices(f)).toContain('Nothing will be pushed: config.ts still has a conflict marker in the merge commit.');
    const p = await post(`/api/pro/ai-fixes/${fixId}/push`, { target: 'existing' });
    expect(p.statusCode).toBe(409);
    expect(pushMerges).toHaveLength(1);
    expect((await rowOf(fixId)).mergeBundle).toBeNull();
    await post(`/api/pro/ai-fixes/${fixId}/discard`);
  });

  it('a merge never committed: "not finished", nothing pushed', async () => {
    agentWork = (dir) => {
      writeFileSync(join(dir, 'config.ts'), RESOLVED);
      git(dir, 'add', 'config.ts');
    };
    reportAnswer = null;
    const fixId = await startFix(['conflict:merge']);
    const f = await until((x) => x.id === fixId && x.session?.phase === 'built', 'built');
    expect(f.merge).toMatchObject({ status: 'invalid', reason: 'The merge is not finished: the agent did not commit it.' });
    expect(f.changeReport?.unaddressed[0]?.ref).toBe('MERGE');
    expect((await post(`/api/pro/ai-fixes/${fixId}/push`, { target: 'existing' })).statusCode).toBe(409);
    expect(pushMerges).toHaveLength(1);
    expect(applies).toEqual([]);
    await post(`/api/pro/ai-fixes/${fixId}/discard`);
  });
});
