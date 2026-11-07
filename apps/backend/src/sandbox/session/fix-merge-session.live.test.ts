// ONE REAL AI FIX SESSION THAT RESOLVES A MERGE CONFLICT, through the ai-fix routes, on a real container
// daemon and the real Claude Code (the `live` project; runs only with LIMN_SANDBOX_LIVE=claude and the
// reader's Claude sign-in in CLAUDE_CODE_OAUTH_TOKEN). A throw-away git repository stands in for the clone
// cache: the PR head is reachable ONLY through `refs/pull/1/head`; `main` moved on and conflicts with it on
// the SAME line, where the PR also adds the next line — the case a "take both" resolution gets wrong by
// keeping `limit` twice. GitHub is a fake; nothing is pushed.
//
//   start (the merge item only) → Limn starts the merge in the sandbox (the image's own git) → the agent
//   resolves and commits the merge → the host checks the bundle (parents, markers) → valid → the merge's
//   file has `limit` ONCE, the PR's new line and main's comment → discard → nothing left
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

const scratch = mkdtempSync(join(tmpdir(), 'limn-fix-merge-live-'));
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
let baseSha = '';
let mergeBase = '';
let repoDir = '';
let gitIn: (...a: string[]) => string = () => '';
const usage: any[] = [];
const prepared: any[] = [];

describe.skipIf(!daemon)('an AI Fix session that resolves a merge conflict, live', () => {
  beforeAll(async () => {
    const repo = join(scratch, 'tiny');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const BASE = "export const name = 'report';\nexport const limit = 10;\nexport const sep = ',';\n";
    writeFileSync(join(repo, 'src', 'config.js'), BASE);
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('add', '.');
    git('commit', '-qm', 'init');
    mergeBase = git('rev-parse', 'HEAD');
    // The PR: raise the limit, and add the page size right after it.
    git('checkout', '-qb', 'feature/limit');
    writeFileSync(join(repo, 'src', 'config.js'), "export const name = 'report';\nexport const limit = 25;\nexport const pageSize = 50;\nexport const sep = ',';\n");
    git('commit', '-qam', 'feat: raise the limit');
    headSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/pull/1/head', headSha);
    git('checkout', '-q', 'main');
    git('branch', '-qD', 'feature/limit');
    // main: a note on the SAME line.
    writeFileSync(join(repo, 'src', 'config.js'), "export const name = 'report';\nexport const limit = 10; // the API caps it at 100\nexport const sep = ',';\n");
    git('commit', '-qam', 'docs: note the cap');
    baseSha = git('rev-parse', 'HEAD');
    repoDir = repo;
    gitIn = git;
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
      .values({ accountId: 1, repoId: r!.id, githubNodeId: 'PR-1', number: 1, title: 'Raise the limit', body: 'Raises the export limit.', state: 'open', headSha, baseRefName: 'main', mergeStateStatus: 'dirty', mergeable: 'conflicting', openedAt: new Date(), updatedAt: new Date() })
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
      // The repo store (Docker): the commit is the one asked for; its objects come from the throw-away repo
      // (as from Limn's clone cache), through the real maintenance-container fetch. The store volume is
      // this run's own (random instance) and is removed after.
      storeSeams: {
        resolveBase: async (req) => ({ sha: req.baseSha ?? git('rev-parse', 'main') }),
        checkLocal: async () => ({ ok: false, reason: 'not used' }),
        hydrateCache: async () => ({ gitDir: join(repo, '.git'), cleanup: async () => {} }),
        transfer: defaultStoreSeams.transfer,
      },
      credentialEnv: () => process.env,
      usageSink: { record: async (row) => void usage.push(row), noteClaudeRateLimit: () => {} },
    });
    const { verifyMergeBundle } = await import('../../coding/ai-fix/merge-verify.js');
    F.setFixSessionDepsForTests({
      contextTicket: async () => null,
      // The clone cache's role for the merge: the base tip and the merge base, from the throw-away repo.
      mergePlan: async () => ({ baseSha, mergeBaseSha: git('merge-base', headSha, baseSha) }),
      // The host's check, for real, in that repo (it holds the PR head and the base tip).
      verifyMerge: async (a) =>
        verifyMergeBundle({ gitDir: repo, bundle: a.bundle, headSha: a.headSha, baseSha: a.baseSha, baseRef: a.baseRef, conflictedFiles: a.conflictedFiles, resultRef: `refs/pierre/ai-fix/${a.fixId}/merge/result` }),
    });
    const ctx = {
      db: client.db,
      schema: client.schema,
      log: { info() {}, warn: (o: unknown, m?: string) => console.warn('[warn]', m ?? '', o instanceof Error ? o.message : ''), error() {} },
      accountIdOf: () => 1,
      llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
      recordAiUsage: async () => {},
      github: {
        fetchPrHeadInfo: async () => ({ headSha, headRef: 'feature/limit', headRepoFullName: 'limn-test/tiny', isFork: false, maintainerCanModify: false, baseRef: 'main' }),
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
    if (store) console.log('[live merge fix] store removed', JSON.stringify(store));
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

  it('merges main in the sandbox, resolves the conflict without a duplicated line, and the host check passes', async () => {
    const t0 = Date.now();
    const start = await app.inject({
      method: 'POST',
      url: `/api/pro/prs/${prId}/ai-fix`,
      payload: { provider: 'claude', model: 'claude-sonnet-5', seed: 'review', include: ['conflict:merge'] },
    });
    expect(start.statusCode).toBe(202);
    const built = await until((f) => f.session?.phase === 'built', 'built', 15 * 60_000);
    const notes = built.session!.conversation.filter((c) => c.kind === 'notice').map((c) => (c as { text: string }).text);
    // Everything first, so a failed check below still leaves the evidence (one model run per try).
    const { db: db0, schema: schema0 } = await import('../../db/client.js');
    const { eq: eq0 } = await import('drizzle-orm');
    const row0 = (await db0.select().from(schema0.aiFixes).where(eq0(schema0.aiFixes.id, built.id)).execute())[0]!;
    let merged0 = '';
    if (row0.mergeBundle) {
      writeFileSync(join(scratch, 'peek.bundle'), Buffer.from(row0.mergeBundle, 'base64'));
      gitIn('fetch', '-q', join(scratch, 'peek.bundle'), '+refs/limn/out:refs/heads/peek');
      merged0 = gitIn('show', 'peek:src/config.js');
    }
    console.log('[live merge fix] evidence', JSON.stringify({ notes, merge: { ...built.merge, resolutionDiff: built.merge?.resolutionDiff?.slice(0, 2000) }, report: built.changeReport, merged: merged0, error: built.error, tools: built.session!.conversation.filter((c) => c.kind === 'tool').map((c) => (c as { summary: string }).summary).slice(0, 40) }));
    // The PR repository came through the repo store; the two merge commits through the mirror seams.
    expect(prepared.map((p) => p.baseSha)).toEqual([baseSha, mergeBase]);
    expect(notes).toContain(`Limn started the merge of main (${baseSha.slice(0, 7)}): one file is in conflict (src/config.js).`);
    expect(built.merge).toMatchObject({ baseRef: 'main', baseSha, conflictedFiles: ['src/config.js'], status: 'valid', reason: null });
    expect(notes).toContain('Limn checked the merge commit: main is merged and the conflict is resolved.');
    expect(built.status).toBe('succeeded');

    // The commits themselves, out of the stored bundle: the merge's parents and its file.
    const { db, schema } = await import('../../db/client.js');
    const { eq } = await import('drizzle-orm');
    const row = (await db.select().from(schema.aiFixes).where(eq(schema.aiFixes.id, built.id)).execute())[0]!;
    const bundleFile = join(scratch, 'out.bundle');
    writeFileSync(bundleFile, Buffer.from(row.mergeBundle!, 'base64'));
    gitIn('fetch', '-q', bundleFile, '+refs/limn/out:refs/heads/checked');
    const merge = gitIn('rev-list', '--first-parent', '--merges', 'checked', `^${headSha}`).split('\n').pop()!;
    expect(gitIn('rev-list', '--parents', '-n', '1', merge).split(' ').slice(1)).toEqual([headSha, baseSha]);
    const file = gitIn('show', `${merge}:src/config.js`);
    expect(file).not.toMatch(/^(<{7}|={7}|>{7})/m);
    expect(file.match(/^export const limit\b/gm)).toHaveLength(1);
    expect(file).toMatch(/^export const pageSize = 50;$/m);
    expect(file).toMatch(/the API caps it at 100/);
    expect(file.split('\n').filter((l) => l.trim() !== '')).toHaveLength(4);
    expect(built.merge?.resolutionDiff).toContain('src/config.js');

    const d = await app.inject({ method: 'POST', url: `/api/pro/ai-fixes/${built.id}/discard`, payload: {} });
    expect(d.statusCode).toBe(200);
    const after = await read();
    expect(after.status).toBe('cancelled');
    expect(after.session).toMatchObject({ phase: 'discarded', live: false });
    console.log(
      '[live merge fix]',
      JSON.stringify({
        totalSeconds: Math.round((Date.now() - t0) / 1000),
        boot: built.session!.boot.map((s) => `${s.key}:${s.state}`),
        turns: built.session!.spend.turns,
        costUsd: built.session!.spend.costUsd,
        ledger: usage.map((u) => [u.feature, u.model, u.costUsd, u.prId]),
        mergedFile: file,
        report: built.changeReport,
        summary: built.summary,
        repoPath: repoDir,
        network: built.session!.network.map((n) => `${n.host}:${n.port} ${n.allowed ? 'allowed' : 'denied'} x${n.count}`),
      }),
    );
  }, 25 * 60_000);
});
