// ONE REAL AI FIX SESSION, through the ai-fix routes, on a real container daemon and the real Claude Code
// (the `live` project; runs only with LIMN_SANDBOX_LIVE=claude and the reader's Claude sign-in in
// CLAUDE_CODE_OAUTH_TOKEN). A throw-away git repository stands in for the clone cache: its PR head is
// reachable ONLY through `refs/pull/1/head` (no branch), as a fork's head is in the base repository.
// GitHub is a fake (head + diff); nothing is pushed and nothing is written anywhere but the scratch DB.
//
//   start (plain seed) → the fix runs at once in build mode → the agent writes the report and runs the
//   checker → the host validates it → the patch is stored → discard → nothing left
//
// Every Docker resource carries `limn.test=1` and this run's own instance label, and is removed.
// The token is never printed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiFix, AiFixResponse } from '@pierre-review/shared';

const wanted = process.env.LIMN_SANDBOX_LIVE === 'claude' && Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
const daemon = (() => {
  if (!wanted) return false;
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const scratch = mkdtempSync(join(tmpdir(), 'limn-fix-live-'));
const DB_PATH = join(scratch, 'db.sqlite');
if (wanted) {
  process.env.DATABASE_URL = DB_PATH;
  process.env.DISABLE_SCHEDULER = 'true';
  process.env.REVIEW_EFFORT = 'low';
  process.env.AI_FIX_MAX_TURNS = '12';
  process.env.LIMN_AI_PROVIDER = 'claude';
  delete process.env.LIMN_AI_DISABLED;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let F: typeof import('./fix.js');
let rt: import('../runtime/types.js').SandboxRuntime;
let prId = 0;
let headSha = '';
const usage: any[] = [];
const prepared: any[] = [];
/** What the repo store was asked for (the PR repository goes through it on Docker). */
const storeAsked: any[] = [];

describe.skipIf(!daemon)('an AI Fix session, live', () => {
  beforeAll(async () => {
    const repo = join(scratch, 'tiny');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# Tiny\n');
    writeFileSync(join(repo, 'src', 'hello.js'), "export const hello = () => 'helo';\n");
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('add', '.');
    git('commit', '-qm', 'init');
    // The PR's head: one commit on a branch, then the branch is deleted and only refs/pull/1/head keeps it.
    git('checkout', '-qb', 'feature/greeting');
    writeFileSync(join(repo, 'src', 'hello.js'), "export const hello = () => 'helo';\nexport const bye = () => 'bye';\n");
    git('commit', '-qam', 'feat: bye');
    headSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/pull/1/head', headSha);
    git('checkout', '-q', 'main');
    git('branch', '-qD', 'feature/greeting');
    const prDiff = git('diff', `main...${headSha}`);

    const { runMigrations } = await import('../../db/run-migrations.js');
    const client = await import('../../db/client.js');
    closeDb = client.closeDb;
    await runMigrations();
    const q = await import('../../db/queries.js');
    await client.db.insert(client.schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
    await q.ensureDefaultWorkspace(1);
    const [r] = await client.db
      .insert(client.schema.repos)
      .values({ accountId: 1, githubNodeId: 'R-tiny', owner: 'limn-test', name: 'tiny', defaultBranch: 'main', viewerPermission: 'WRITE' })
      .returning()
      .execute();
    await q.resolveWorkspaceScope(1, null);
    const [pr] = await client.db
      .insert(client.schema.pullRequests)
      .values({ accountId: 1, repoId: r!.id, githubNodeId: 'PR-1', number: 1, title: 'Add bye', body: 'Adds a bye function.', state: 'open', headSha, baseRefName: 'main', openedAt: new Date(), updatedAt: new Date() })
      .returning()
      .execute();
    prId = pr!.id;

    const { createDockerRuntime } = await import('../runtime/docker.js');
    rt = createDockerRuntime({ instance: `test-${randomBytes(4).toString('hex')}`, extraLabels: { 'limn.test': '1' } });
    const { shallowFromClone, defaultMirrorSeams } = await import('../workspace/mirror.js');
    const { defaultStoreSeams } = await import('../workspace/store.js');
    M = await import('./manager.js');
    F = await import('./fix.js');
    const claudeDir = join(scratch, 'claude');
    M.setSessionDepsForTests({
      runtime: () => rt,
      settings: async () => null,
      places: () => ({ claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [] }, home: '/nowhere', dataDir: '/nowhere/.limn' }),
      // The clone cache's role: a real shallow fetch of the requested commit (the PR head, by sha).
      mirrorSeams: {
        prepare: async (req) => {
          prepared.push(req);
          return shallowFromClone(repo, req.baseSha ?? git('rev-parse', 'main'));
        },
        tarGitDir: defaultMirrorSeams.tarGitDir,
      },
      // The repo store (Docker, since 8beb6142): the commit is the one asked for; its objects come from the
      // throw-away repo (as from Limn's clone cache), through the real maintenance-container fetch — never
      // Limn's real clone cache or GitHub. The store volume is this run's own (random instance), removed after.
      storeSeams: {
        resolveBase: async (req) => {
          storeAsked.push(req);
          return { sha: req.baseSha ?? git('rev-parse', 'main') };
        },
        checkLocal: async () => ({ ok: false, reason: 'not used' }),
        hydrateCache: async () => ({ gitDir: join(repo, '.git'), cleanup: async () => {} }),
        transfer: defaultStoreSeams.transfer,
      },
      credentialEnv: () => process.env,
      usageSink: { record: async (row) => void usage.push(row), noteClaudeRateLimit: () => {} },
    });
    F.setFixSessionDepsForTests({ contextTicket: async () => null });
    const ctx = {
      db: client.db,
      schema: client.schema,
      log: { info() {}, warn: (o: unknown, m?: string) => console.warn('[warn]', m ?? '', o instanceof Error ? o.message : ''), error() {} },
      accountIdOf: () => 1,
      llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
      recordAiUsage: async () => {},
      github: {
        fetchPrHeadInfo: async () => ({ headSha, headRef: 'feature/greeting', headRepoFullName: 'limn-test/tiny', isFork: false, maintainerCanModify: false, baseRef: 'main' }),
        fetchPrDiff: async () => `${prDiff}\n`,
      },
      coding: {
        applyAndPush: async () => {
          throw new Error('the live test never pushes');
        },
      },
    } as any;
    const Fastify = (await import('fastify')).default;
    const { registerAiFixRoutes } = await import('../../coding/ai-fix/routes.js');
    app = Fastify({ logger: false });
    registerAiFixRoutes(app, ctx);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await M?._closeAllSessionsForTest().catch(() => {});
    M?.setSessionDepsForTests(null);
    F?.setFixSessionDepsForTests(null);
    const left = rt ? await rt.sweep([], { dryRun: true }) : null;
    const store = rt?.repoStore ? await rt.repoStore.remove().catch((e: unknown) => ({ volumes: [], errors: [String(e)] })) : null;
    if (store) console.log('[live fix] store removed', JSON.stringify(store));
    if (left && left.containers.length + left.networks.length + left.volumes.length > 0) await rt.sweep([]);
    await app?.close();
    await closeDb?.();
    rmSync(scratch, { recursive: true, force: true });
    expect(left).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
  }, 120_000);

  const read = async (): Promise<AiFix> => ((await app.inject({ method: 'GET', url: `/api/pro/prs/${prId}/ai-fix` })).json() as AiFixResponse).fix!;
  async function until(test: (f: AiFix) => boolean, what: string, ms: number): Promise<AiFix> {
    const end = Date.now() + ms;
    for (;;) {
      const f = await read();
      if (f && test(f)) return f;
      if (f?.session?.phase === 'failed') throw new Error(`failed while waiting for ${what}: ${f.error}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: phase ${f?.session?.phase}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  it('fixes at once on the PR head, hands in a valid report, stores the patch, and discards', async () => {
    const t0 = Date.now();
    const start = await app.inject({
      method: 'POST',
      url: `/api/pro/prs/${prId}/ai-fix`,
      payload: { provider: 'claude', model: 'claude-sonnet-5', instruction: "In src/hello.js, hello() returns 'helo'. Make it return 'hello'. Change nothing else. Do not run tests: there are none." },
    });
    expect(start.statusCode).toBe(202);
    const built = await until((f) => f.session?.phase === 'built', 'built', 12 * 60_000);
    // The PR repository was mirrored at the PR head, asked through refs/pull/1/head: through the repo store
    // on Docker, else through the per-session copy.
    expect(storeAsked[0] ?? prepared[0]).toMatchObject({ baseSha: headSha, remoteRef: 'refs/pull/1/head' });
    expect(built.session!.repos[0]!.baseSha).toBe(headSha);
    expect(built.status).toBe('succeeded');
    expect(built.patch).toContain("+export const hello = () => 'hello';");
    expect(built.filesChanged).toEqual(['src/hello.js']);
    const notes = built.session!.conversation.filter((c) => c.kind === 'notice').map((c) => (c as { text: string }).text);
    // The report passed: no notice says it was missing or invalid, and it names the one file.
    expect(notes.filter((n) => /report/.test(n))).toEqual([]);
    expect(built.changeReport!.changes.map((c) => c.path)).toEqual(['src/hello.js']);
    const ranChecker = built.session!.conversation.some((c) => c.kind === 'tool' && /fix-report-check/.test(c.summary));

    const d = await app.inject({ method: 'POST', url: `/api/pro/ai-fixes/${built.id}/discard`, payload: {} });
    expect(d.statusCode).toBe(200);
    const after = await read();
    expect(after.status).toBe('cancelled');
    expect(after.session).toMatchObject({ phase: 'discarded', live: false });
    console.log(
      '[live fix]',
      JSON.stringify({
        totalSeconds: Math.round((Date.now() - t0) / 1000),
        boot: built.session!.boot.map((s) => `${s.key}:${s.state}`),
        turns: built.session!.spend.turns,
        costUsd: built.session!.spend.costUsd,
        ledger: usage.map((u) => [u.feature, u.model, u.costUsd, u.prId]),
        ranChecker,
        summary: built.summary,
        commitMessage: built.commitMessage,
        network: built.session!.network.map((n) => `${n.host}:${n.port} ${n.allowed ? 'allowed' : 'denied'} x${n.count}`),
      }),
    );
  }, 25 * 60_000);
});
