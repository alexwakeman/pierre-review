// ONE REAL PLAN-FIRST SESSION, through the routes, on a real container daemon and the real Claude Code (the
// `live` project; runs only with LIMN_SANDBOX_LIVE_SESSION=1 and the reader's Claude sign-in in
// CLAUDE_CODE_OAUTH_TOKEN). Two throw-away git repositories stand in for the clone cache (the mirror's
// `prepare` seam, and the plan evidence's blob reader); the ticket is a fixed one whose AC2 deliberately
// contradicts the code. Nothing is built, pushed or written to a tracker.
//
//   boot → Limn sends the planning turn UNPROMPTED → the agent's ```limn-plan block → the host verifies
//   it → revision 1: one bullet per AC, a code-evidenced point of contention on AC2, one PR per repository
//   it changes → discard → nothing left.
//
// It also records spike S1 (docs/limn-implement-plan-first.md § 1): which tools the agent could run in
// Claude's plan mode (Bash in particular), from the conversation's tool rows.
// Every Docker resource carries `limn.test=1` and this run's own instance label, and is removed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StoryBuild } from '@pierre-review/shared';

const wanted = process.env.LIMN_SANDBOX_LIVE_SESSION === '1' && Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
const daemon = (() => {
  if (!wanted) return false;
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

const scratch = mkdtempSync(join(tmpdir(), 'limn-plan-live-'));
const DB_PATH = join(scratch, 'db.sqlite');
if (wanted) {
  process.env.DATABASE_URL = DB_PATH;
  process.env.DISABLE_SCHEDULER = 'true';
  process.env.REVIEW_EFFORT = 'low';
  process.env.STORY_BUILD_MAX_TURNS = '16';
  delete process.env.LIMN_AI_DISABLED;
}
const MODEL = process.env.LIMN_PLAN_LIVE_MODEL ?? 'claude-sonnet-5';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let P: typeof import('./plan.js');
let rt: import('../runtime/types.js').SandboxRuntime;
let wsId = 0;
const repos: Record<string, { dir: string; sha: string }> = {};
const IDENT = 'jira:https://limn-test.atlassian.net#TINY-2';

function makeRepo(name: string, files: Record<string, string>): void {
  const dir = join(scratch, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git('add', '.');
  git('commit', '-qm', 'init');
  repos[name] = { dir, sha: git('rev-parse', 'HEAD') };
}

describe.skipIf(!daemon)('a plan-first session, live', () => {
  beforeAll(async () => {
    makeRepo('api', {
      'README.md': '# API\nServes report exports.\n',
      'src/export.js': "// The export endpoint.\nexport const MAX_EXPORT_ROWS = 500;\nexport function exportRows(rows) {\n  return rows.slice(0, MAX_EXPORT_ROWS);\n}\n",
    });
    makeRepo('web', {
      'README.md': '# Web\nThe report page.\n',
      'src/report-page.js': "// The report page.\nexport function buttons() {\n  return ['Print'];\n}\n",
    });

    const { runMigrations } = await import('../../db/run-migrations.js');
    const client = await import('../../db/client.js');
    closeDb = client.closeDb;
    await runMigrations();
    const q = await import('../../db/queries.js');
    await client.db.insert(client.schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
    wsId = await q.ensureDefaultWorkspace(1);
    for (const name of ['api', 'web']) {
      await client.db.insert(client.schema.repos).values({ accountId: 1, githubNodeId: `R-${name}`, owner: 'limn-test', name, defaultBranch: 'main', viewerPermission: 'WRITE' }).execute();
    }
    await q.resolveWorkspaceScope(1, null);

    const { createDockerRuntime } = await import('../runtime/docker.js');
    rt = createDockerRuntime({ instance: `test-${randomBytes(4).toString('hex')}`, extraLabels: { 'limn.test': '1' } });
    const { shallowFromClone, defaultMirrorSeams } = await import('../workspace/mirror.js');
    const { defaultStoreSeams } = await import('../workspace/store.js');
    const { readBlobAt } = await import('../../coding/story-build/plan-blobs.js');
    M = await import('./manager.js');
    P = await import('./plan.js');
    const claudeDir = join(scratch, 'claude');
    M.setSessionDepsForTests({
      runtime: () => rt,
      storyInputs: async () => ({ ticketKey: 'TINY-2', title: 'Export a report as CSV', empty: false }),
      readTicket: async () => ({
        ident: IDENT,
        key: 'TINY-2',
        title: 'Export a report as CSV',
        url: null,
        description: 'As a user, I want to download a report as a CSV file, so that I can open it in a spreadsheet.',
        acceptanceCriteriaText: '',
        criteria: [
          { n: 1, text: 'GIVEN the report page WHEN it loads THEN it shows a "Download CSV" button next to "Print"' },
          { n: 2, text: 'The API already exports up to 10000 rows in one file, so the API needs no change' },
        ],
        criteriaSource: 'brief',
        openPoints: [],
        comments: null,
        prs: [],
        gaps: null,
        fresh: true,
        readAt: null,
      }),
      coverage: async () => null,
      settings: async () => null,
      ticketPrs: async () => [],
      places: () => ({ claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [] }, home: '/nowhere', dataDir: '/nowhere/.limn' }),
      mirrorSeams: { prepare: async (req) => shallowFromClone(repos[req.name]!.dir, repos[req.name]!.sha), tarGitDir: defaultMirrorSeams.tarGitDir },
      // The kept repo store reads the throw-away repositories, not GitHub.
      storeSeams: {
        resolveBase: async (req) => ({ sha: repos[req.name]!.sha }),
        checkLocal: defaultStoreSeams.checkLocal,
        hydrateCache: async (req) => ({ gitDir: join(repos[req.name]!.dir, '.git'), cleanup: async () => {} }),
        transfer: defaultStoreSeams.transfer,
      },
      credentialEnv: () => process.env,
    });
    // The clone cache's blob reader, on the throw-away repositories (the same git reads).
    P.setPlanStageSeamsForTests({ readBlob: async (_a, fullName, sha, path) => readBlobAt(repos[fullName.split('/')[1]!]!.dir, sha, path) });
    const ctx = {
      db: client.db,
      schema: client.schema,
      runTransaction: client.runTransaction,
      log: { info() {}, warn: (o: unknown, m?: string) => console.warn('[warn]', m ?? '', o instanceof Error ? o.message : ''), error() {} },
      accountIdOf: () => 1,
      llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
      recordAiUsage: async () => {},
      github: {},
    } as any;
    const Fastify = (await import('fastify')).default;
    const { registerSandboxSessionRoutes } = await import('./routes.js');
    app = Fastify({ logger: false });
    registerSandboxSessionRoutes(app, ctx);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await M?._closeAllSessionsForTest().catch(() => {});
    M?.setSessionDepsForTests(null);
    P?.setPlanStageSeamsForTests(null);
    const left = rt ? await rt.sweep([], { dryRun: true }) : null;
    if (left && left.containers.length + left.networks.length + left.volumes.length > 0) await rt.sweep([]);
    // The kept repo store is this run's own (random instance): removed too.
    const store = rt?.repoStore ? await rt.repoStore.remove().catch((e: unknown) => ({ volumes: [], errors: [String(e)] })) : null;
    expect(store?.errors ?? []).toEqual([]);
    await app?.close();
    await closeDb?.();
    rmSync(scratch, { recursive: true, force: true });
    expect(left).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
  }, 120_000);

  const read = async (id: number): Promise<StoryBuild> => (await app.inject({ method: 'GET', url: `/api/story-builds/${id}` })).json();
  async function until(id: number, test: (b: StoryBuild) => boolean, what: string, ms: number): Promise<StoryBuild> {
    const end = Date.now() + ms;
    for (;;) {
      const b = await read(id);
      if (test(b)) return b;
      if (b.session?.phase === 'failed') throw new Error(`failed while waiting for ${what}: ${b.error} ${JSON.stringify(b.session.notes)} ${JSON.stringify(b.session.boot)}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: phase ${b.session?.phase}, plan ${b.session?.plan?.status} ${b.session?.plan?.problem}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  it('plans unprompted: one bullet per AC, a code-evidenced contention on AC2, one PR per changed repository', async () => {
    const t0 = Date.now();
    const start = await app.inject({ method: 'POST', url: '/api/story-builds', payload: { workspaceId: wsId, ident: IDENT, provider: 'claude', model: MODEL } });
    expect(start.statusCode, start.body).toBe(202);
    const id = start.json().buildId as number;
    // Nobody sends a message: the opening turn is Limn's own.
    const b = await until(id, (x) => x.session?.phase === 'plan_ready' || (x.session?.phase === 'ready' && x.session.plan?.status === 'failed'), 'the plan', 15 * 60_000);
    const s = b.session!;
    const tools = s.conversation.filter((c) => c.kind === 'tool').map((c) => {
      const t = c as { tool: string; summary: string; ok: boolean | null };
      return `${t.tool}:${t.ok}:${t.summary.slice(0, 80)}`;
    });
    console.log(
      '[live plan]',
      JSON.stringify(
        {
          seconds: Math.round((Date.now() - t0) / 1000),
          phase: s.phase,
          stage: s.plan?.status,
          problem: s.plan?.problem,
          revisions: s.plan?.revisions,
          spend: s.spend,
          tools,
          notices: s.conversation.filter((c) => c.kind === 'notice').map((c) => (c as { text: string }).text),
          plan: s.plan?.latest,
        },
        null,
        1,
      ),
    );
    expect(s.conversation[0]).toMatchObject({ kind: 'reader', text: 'Plan' });
    expect(s.phase).toBe('plan_ready');
    const plan = s.plan!.latest!;
    expect(plan.criteria.map((c) => c.ref)).toEqual(['AC1', 'AC2']);
    const c = plan.contentions.find((x) => x.about.some((a) => /AC2/i.test(a)));
    expect(c, 'a point of contention on AC2').toBeTruthy();
    expect(c!.evidence.some((e) => e.kind === 'code' && e.fullName === 'limn-test/api' && e.excerpt.includes('MAX_EXPORT_ROWS = 500'))).toBe(true);
    const perRepo = new Map<string, number>();
    for (const p of plan.stack) perRepo.set(p.fullName, (perRepo.get(p.fullName) ?? 0) + 1);
    expect([...perRepo.values()].every((n) => n === 1)).toBe(true);
    expect(plan.stack.map((p) => p.fullName)).toContain('limn-test/web');
    // A point of contention ⇒ a draft ticket update (required by the validator since this test first ran).
    expect(plan.ticketUpdate).not.toBeNull();
    expect(JSON.stringify(s.conversation)).not.toContain('"schema":"limn.plan/1"');
    expect((await app.inject({ method: 'POST', url: `/api/story-builds/${id}/discard` })).statusCode).toBe(200);
  }, 25 * 60_000);
});
