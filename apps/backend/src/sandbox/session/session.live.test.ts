// ONE REAL WORKSPACE SESSION, through the routes, on a real container daemon and the real Claude Code
// (the `live` project; runs only with LIMN_SANDBOX_LIVE_SESSION=1 and the reader's Claude sign-in in
// CLAUDE_CODE_OAUTH_TOKEN). A throw-away two-file git repository stands in for the clone cache (the
// mirror's `prepare` seam: a real shallow fetch from it); the ticket is a fixed one (no tracker call);
// nothing is pushed and nothing is written to a tracker.
//
//   boot → one chat message → Start build → the patch is in `…/diff` → discard → nothing left
//
// Every Docker resource carries `limn.test=1` and this run's own instance label, and is removed.
// The token is never printed: the check that it is in no sandbox file sends its tail over stdin.
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

const scratch = mkdtempSync(join(tmpdir(), 'limn-session-live-'));
const DB_PATH = join(scratch, 'db.sqlite');
if (wanted) {
  process.env.DATABASE_URL = DB_PATH;
  process.env.DISABLE_SCHEDULER = 'true';
  process.env.REVIEW_EFFORT = 'low';
  process.env.STORY_BUILD_MAX_TURNS = '6';
  delete process.env.LIMN_AI_DISABLED;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let rt: import('../runtime/types.js').SandboxRuntime;
let wsId = 0;
let repoId = 0;
const usage: any[] = [];
const IDENT = 'jira:https://limn-test.atlassian.net#TINY-1';

describe.skipIf(!daemon)('a workspace session, live', () => {
  beforeAll(async () => {
    // The throw-away repository (two files, one commit) the clone cache would hold.
    const repo = join(scratch, 'tiny');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# Tiny\n');
    writeFileSync(join(repo, 'src', 'hello.js'), "export const hello = () => 'hello';\n");
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim();
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const sha = git('rev-parse', 'HEAD');

    const { runMigrations } = await import('../../db/run-migrations.js');
    const client = await import('../../db/client.js');
    closeDb = client.closeDb;
    await runMigrations();
    const q = await import('../../db/queries.js');
    await client.db.insert(client.schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
    wsId = await q.ensureDefaultWorkspace(1);
    const [r] = await client.db
      .insert(client.schema.repos)
      .values({ accountId: 1, githubNodeId: 'R-tiny', owner: 'limn-test', name: 'tiny', defaultBranch: 'main', viewerPermission: 'WRITE' })
      .returning()
      .execute();
    repoId = r!.id;
    await q.resolveWorkspaceScope(1, null);

    const { createDockerRuntime } = await import('../runtime/docker.js');
    rt = createDockerRuntime({ instance: `test-${randomBytes(4).toString('hex')}`, extraLabels: { 'limn.test': '1' } });
    const { shallowFromClone } = await import('../workspace/mirror.js');
    const { defaultMirrorSeams } = await import('../workspace/mirror.js');
    M = await import('./manager.js');
    const claudeDir = join(scratch, 'claude');
    M.setSessionDepsForTests({
      // The chat → Start build flow (plan first has its own live test: plan-session.live.test.ts).
      planFirst: false,
      runtime: () => rt,
      storyInputs: async () => ({ ticketKey: 'TINY-1', title: 'Note the build in the README', empty: false }),
      readTicket: async () => ({
        ident: IDENT,
        key: 'TINY-1',
        title: 'Note the build in the README',
        url: null,
        description: 'Add one line to README.md that says the build ran.',
        acceptanceCriteriaText: '',
        criteria: [{ n: 1, text: 'README.md ends with the line "Built by Limn."' }],
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
      mirrorSeams: { prepare: async () => shallowFromClone(repo, sha), tarGitDir: defaultMirrorSeams.tarGitDir },
      credentialEnv: () => process.env,
      usageSink: { record: async (row) => void usage.push(row), noteClaudeRateLimit: () => {} },
    });
    const ctx = {
      db: client.db,
      schema: client.schema,
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
    const left = rt ? await rt.sweep([], { dryRun: true }) : null;
    if (left && left.containers.length + left.networks.length + left.volumes.length > 0) await rt.sweep([]);
    await app?.close();
    await closeDb?.();
    rmSync(scratch, { recursive: true, force: true });
    expect(left).toEqual({ containers: [], networks: [], volumes: [], images: [], errors: [] });
  }, 120_000);

  const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: payload as any });
  const read = async (id: number): Promise<StoryBuild> => (await app.inject({ method: 'GET', url: `/api/story-builds/${id}` })).json();
  async function until(id: number, test: (b: StoryBuild) => boolean, what: string, ms: number): Promise<StoryBuild> {
    const end = Date.now() + ms;
    for (;;) {
      const b = await read(id);
      if (test(b)) return b;
      if (b.session?.phase === 'failed') throw new Error(`failed while waiting for ${what}: ${b.error}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: phase ${b.session?.phase}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  it('boots, chats once, builds, extracts the patch and discards', async () => {
    const t0 = Date.now();
    const start = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT, provider: 'claude', model: 'claude-sonnet-5' });
    expect(start.statusCode).toBe(202);
    const id = start.json().buildId as number;
    const ready = await until(id, (b) => b.session?.phase === 'ready', 'ready', 10 * 60_000);
    const tReady = Date.now();
    expect(ready.session!.repos).toEqual([{ repoId, fullName: 'limn-test/tiny', path: '/workspace/limn-test/tiny', branch: 'TINY-1', baseSha: expect.stringMatching(/^[0-9a-f]{40}$/) }]);

    expect((await post(`/api/story-builds/${id}/messages`, { text: 'In one short sentence: which files are in the repository?' })).statusCode).toBe(202);
    const chatted = await until(id, (b) => b.session?.phase === 'ready' && b.session.conversation.some((c) => c.kind === 'turn'), 'the chat turn', 5 * 60_000);
    const answer = chatted.session!.conversation.filter((c) => c.kind === 'agent').map((c) => (c as { text: string }).text).join(' ');
    expect(answer.toLowerCase()).toMatch(/readme|hello/);

    // The real sign-in is in no file of the sandbox (its tail is sent over stdin, never printed).
    const box = `limn-${(await M.liveSandboxIds())[0]}-sandbox`;
    const tail = String(process.env.CLAUDE_CODE_OAUTH_TOKEN).slice(-24);
    const leak = await rt.run(box, ['bash', '-c', 'read -r N; grep -rIl -F -- "$N" /home/agent /workspace /tmp 2>/dev/null | wc -l'], { input: `${tail}\n` });
    expect(String(leak.stdout).trim()).toBe('0');

    expect(
      (await post(`/api/story-builds/${id}/build`, { text: 'Only append the line "Built by Limn." to README.md, then commit it with the message "docs: note the build". Do not run any other command.' })).statusCode,
    ).toBe(202);
    const built = await until(id, (b) => b.session?.phase === 'built', 'built', 8 * 60_000);
    const diff = (await app.inject({ method: 'GET', url: `/api/story-builds/${id}/diff` })).json();
    expect(diff.repos).toHaveLength(1);
    expect(diff.repos[0].patch).toContain('+Built by Limn.');
    expect(diff.repos[0].filesChanged).toEqual(['README.md']);
    expect(built.repos[0]).toMatchObject({ status: 'ready', hasPatch: true });

    const discarded = await post(`/api/story-builds/${id}/discard`);
    expect(discarded.statusCode).toBe(200);
    expect((await read(id)).session).toMatchObject({ phase: 'discarded', live: false });
    console.log(
      '[live session]',
      JSON.stringify({
        bootSeconds: Math.round((tReady - t0) / 1000),
        totalSeconds: Math.round((Date.now() - t0) / 1000),
        boot: ready.session!.boot.map((s) => `${s.key}:${s.state}`),
        turns: built.session!.spend.turns,
        costUsd: built.session!.spend.costUsd,
        ledger: usage.map((u) => [u.feature, u.model, u.costUsd]),
        commitMessage: built.repos[0]!.commitMessage,
        network: built.session!.network.map((n) => `${n.host}:${n.port} ${n.allowed ? 'allowed' : 'denied'} x${n.count}`),
      }),
    );
  }, 25 * 60_000);
});
