// A WORKSPACE SESSION, END TO END (the successor of coding/story-build/e2e-flow-db.test.ts), over the
// REAL routes, the REAL manager, the REAL egress / workspace mirror / seed / Claude driver / patch parser
// and the REAL push code on a scratch SQLite. The edges are fakes: the FAKE runtime (no daemon), the
// recorded spike-1 Claude stream replayed turn by turn, git's push + PR (`applyAndPushBranch`), the
// tracker link, the ticket read and the clone cache.
//
//   start → boot (runtime, image, network, ticket, proxy, sandbox, repos, agent) → ready → one chat
//   message (a second while it runs is refused) → Start build (the ticket read again: a changed AC list
//   is one notice, TICKET.md rewritten) → build turn → patches stored per repository → diff → Push (the
//   existing route; draft) → pushed → discard (nothing left) → the stream of a closed session.
// Then the limits: no runtime, the open-session cap, one build at a time, the idle teardown, the
// restart reconcile and Resume from stored patches.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SandboxSessionStreamEvent, StoryBuild } from '@pierre-review/shared';
import { EXTRACT_SCRIPT } from './patches.js';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-sandbox-session`}.sandbox-session-flow.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = vi.hoisted(() => ({ pushes: [] as any[], nextPr: 700, sync: null as null | ((name: string, n: number) => Promise<void>) }));

vi.mock('../../coding/git-ops.js', () => ({
  applyAndPushBranch: async (a: any) => {
    G.pushes.push(a);
    const n = G.nextPr++;
    await G.sync?.(a.name, n);
    await a.afterSync?.(n);
    return { pushedBranch: a.branch, commitSha: `c${n}`, prNumber: n, prUrl: `https://github.com/${a.owner}/${a.name}/pull/${n}` };
  },
}));
vi.mock('../../tracker/manual-links.js', () => ({ resolveTicketRefs: async () => ({ ok: true, body: { results: [] } }) }));
vi.mock('../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));
vi.mock('../../review/clone-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../review/clone-manager.js')>()),
  repoCloneDir: () => '/nonexistent/limn-test-clone',
  removeWorktreeLocked: async () => {},
  prepBranchWorktree: async () => {
    throw new Error('the session test never checks out on the host');
  },
}));

const IDENT = 'jira:https://acme.atlassian.net#ACME-300';
const IDENT2 = 'jira:https://acme.atlassian.net#ACME-301';
const SHA = { api: 'a'.repeat(40), web: 'b'.repeat(40) };

const OUT = readFileSync(fileURLToPath(new URL('../drivers/__fixtures__/claude-interactive.out.jsonl', import.meta.url)), 'utf8').split('\n').filter(Boolean);
/** The recorded stream, by the stdin line that releases it: start, chat turn 1, Start build, build turn. */
const SEGMENTS: Array<{ wait: string; lines: [number, number]; hold?: boolean }> = [
  { wait: 'initialize', lines: [0, 0] },
  // Held until the test releases it, so a second message provably arrives while the turn runs.
  { wait: 'user', lines: [1, 11], hold: true },
  { wait: 'set_permission_mode', lines: [46, 47] },
  { wait: 'user', lines: [48, 79] },
];

const API_PATCH = 'diff --git a/src/export.ts b/src/export.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/export.ts\n@@ -0,0 +1 @@\n+export const csv = true;\n';

let app: FastifyInstance;
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let fake: import('../runtime/fake.js').FakeRuntime;
let wsId = 0;
let api = 0;
let web = 0;
let scratch = '';
const usage: any[] = [];
const sentToClaude: string[] = [];
let ticketReads = 0;
let releaseTurn: () => void = () => {};
const held = new Promise<void>((r) => (releaseTurn = r));
let extractAnswer: (path: string) => string = () => '';

const ticket = (n: number) => ({
  ident: IDENT,
  key: 'ACME-300',
  title: 'Export a report as CSV',
  url: 'https://acme.atlassian.net/browse/ACME-300',
  description: 'Customers download any report as a CSV file.',
  acceptanceCriteria: '',
  acceptanceCriteriaText: '',
  criteria: Array.from({ length: n }, (_, i) => ({ n: i + 1, text: ['Stream every row', 'A Download CSV button', 'Name the file after the report'][i]! })),
  criteriaSource: 'brief' as const,
  openPoints: [],
  comments: null,
  prs: [],
  gaps: null,
  fresh: true,
  readAt: null,
});

const out = (patch: string, files: string[], msg: string): string =>
  [
    '@@LIMN-PATCH@@ commits',
    patch ? '1' : '0',
    '@@LIMN-PATCH@@ numstat',
    ...files.map((f) => `1\t0\t${f}`),
    '@@LIMN-PATCH@@ messages',
    msg ? `${msg}\n\x1e` : '',
    '@@LIMN-PATCH@@ patch',
    patch,
  ].join('\n');

function scriptFake(rt: import('../runtime/fake.js').FakeRuntime): void {
  // The proxy: its control port answers, and it prints `ready`.
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
  // The workspace mirror inside the sandbox.
  rt.onExec((argv) => argv[0] === 'sh' && /git config --global user\.name/.test(argv[2] ?? ''), { code: 0 });
  rt.onExec((argv) => argv[0] === 'sh' && /tar -x/.test(argv[2] ?? ''), async (c) => {
    for await (const _l of c.stdin) void _l;
    c.stdout(`${c.argv[6]}\n`);
    return 0;
  });
  // The patch extraction, per repository path.
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === EXTRACT_SCRIPT, async (c) => {
    c.stdout(extractAnswer(c.argv[4]!));
    return 0;
  });
  // Resume's restore.
  rt.onExec((argv) => argv[0] === 'sh' && /git apply --index --binary/.test(argv[2] ?? ''), { code: 0 });
  // Claude Code: the recorded stream, one segment per stdin line of the expected kind.
  rt.onExec((argv) => argv[0] === 'claude', async (c) => {
    let at = 0;
    for await (const line of c.stdin) {
      const msg = JSON.parse(line) as { type: string; request?: { subtype: string }; message?: { content: string } };
      const kind = msg.type === 'control_request' ? msg.request!.subtype : msg.type;
      if (msg.type === 'user') sentToClaude.push(String(msg.message?.content ?? ''));
      const seg = SEGMENTS[at];
      if (!seg || seg.wait !== kind) continue;
      at += 1;
      if (seg.hold) await held;
      for (let i = seg.lines[0]; i <= seg.lines[1]; i++) c.stdout(`${OUT[i]}\n`);
    }
    return 0;
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'limn-session-flow-'));
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  wsId = await q.ensureDefaultWorkspace(1);
  for (const name of ['api', 'web']) {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId: 1, githubNodeId: `R-${name}`, owner: 'acme', name, defaultBranch: 'main', viewerPermission: 'WRITE' })
      .returning()
      .execute();
    if (name === 'api') api = r.id;
    else web = r.id;
  }
  await q.resolveWorkspaceScope(1, null);
  G.sync = async (name, n) => {
    await db
      .insert(schema.pullRequests)
      .values({ accountId: 1, repoId: name === 'web' ? web : api, githubNodeId: `PR${n}`, number: n, title: 'x', state: 'open', openedAt: new Date(), updatedAt: new Date() })
      .execute();
  };

  M = await import('./manager.js');
  const { createFakeRuntime } = await import('../runtime/fake.js');
  const { startEgress } = await import('../proxy/egress.js');
  fake = createFakeRuntime();
  scriptFake(fake);
  const claudeDir = join(scratch, 'claude');
  M.setSessionDepsForTests({
    // The flow before plan first (an older session's turns); plan-session-flow-db.test.ts covers plan first.
    planFirst: false,
    runtime: () => fake,
    storyInputs: async (_c, _a, _w, ident) => ({ ticketKey: ident === IDENT ? 'ACME-300' : 'ACME-301', title: 'Export a report as CSV', empty: false }),
    readTicket: async () => {
      ticketReads += 1;
      // The build's re-read finds a third criterion (open points and criteria change in flight).
      return ticket(ticketReads === 1 ? 2 : 3);
    },
    coverage: async () => null,
    settings: async () => null,
    ticketPrs: async () => [],
    places: () => ({ claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [] }, home: '/nowhere', dataDir: '/nowhere/.limn' }),
    mirrorSeams: {
      prepare: async (req) => ({ sha: req.name === 'api' ? SHA.api : SHA.web, dir: '/fake', cleanup: async () => {} }),
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
    usageSink: { record: async (r) => void usage.push(r), noteClaudeRateLimit: () => {} },
  });
  ctx = {
    db,
    schema,
    log: { info() {}, warn() {}, error() {} },
    accountIdOf: (req: any) => Number(req.headers['x-acct'] ?? 1),
    llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async () => {},
    github: {},
  };
  const Fastify = (await import('fastify')).default;
  const { registerSandboxSessionRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerSandboxSessionRoutes(app, ctx);
  await app.ready();
});

afterEach(() => {
  delete process.env.LIMN_SANDBOX_MAX_SESSIONS;
});

afterAll(async () => {
  await M?._closeAllSessionsForTest();
  M?.setSessionDepsForTests(null);
  await app?.close();
  await closeDb?.();
  rmSync(scratch, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const post = (url: string, payload: any = {}, acct = 1) => app.inject({ method: 'POST', url, payload, headers: { 'x-acct': String(acct) } });
const get = (url: string, acct = 1) => app.inject({ method: 'GET', url, headers: { 'x-acct': String(acct) } });
const read = async (id: number): Promise<StoryBuild> => (await get(`/api/story-builds/${id}`)).json();

async function until(id: number, test: (b: StoryBuild) => boolean, what: string): Promise<StoryBuild> {
  const end = Date.now() + 10_000;
  for (;;) {
    await M._sessionsIdleForTest();
    const b = await read(id);
    if (test(b)) return b;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: phase ${b.session?.phase}, error ${b.error}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a workspace session, end to end', () => {
  let id = 0;
  const frames: SandboxSessionStreamEvent[] = [];

  it('starts: 202, then boots every step to ready with the repositories mirrored and one row each', async () => {
    const r = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT });
    expect(r.statusCode).toBe(202);
    id = r.json().buildId;
    // A second click while it is open answers the same session.
    const again = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ outcome: 'already_open', buildId: id });

    const b = await until(id, (x) => x.session?.phase === 'ready', 'ready');
    expect(b.status).toBe('plan_ready');
    const s = b.session!;
    expect(s.boot.map((x) => [x.key, x.state])).toEqual([
      ['runtime', 'done'],
      ['image', 'done'],
      ['ticket', 'done'],
      ['network', 'done'],
      ['proxy', 'done'],
      ['sandbox', 'done'],
      ['repos', 'done'],
      ['services', 'skipped'],
      ['agent', 'done'],
    ]);
    expect(s.live).toBe(true);
    expect(s.mode).toBe('chat');
    expect(s.provider).toBe('claude');
    expect(s.credentialLine).toMatch(/stays on this computer/);
    expect(s.repos.map((x) => [x.fullName, x.path, x.branch, x.baseSha])).toEqual([
      ['acme/api', '/workspace/acme/api', 'limn/acme-300', SHA.api],
      ['acme/web', '/workspace/acme/web', 'limn/acme-300', SHA.web],
    ]);
    expect(b.repos.map((x) => [x.fullName, x.status, x.baseSha, x.branch])).toEqual([
      ['acme/api', 'planned', SHA.api, 'limn/acme-300'],
      ['acme/web', 'planned', SHA.web, 'limn/acme-300'],
    ]);
    // The seed is at the root, outside every repository; the model credential never reached the sandbox.
    const files = fake.files(`limn-${(await rowOf(id)).sandboxRef}-sandbox`);
    expect([...files.keys()].filter((p) => p.startsWith('/workspace/') && !p.includes('/acme/')).sort()).toEqual(['/workspace/AGENTS.md', '/workspace/CLAUDE.md', '/workspace/TICKET.md']);
    const started = fake.calls.find((c) => c.method === 'startSandbox')!.args[0] as { env: Record<string, string> };
    expect(JSON.stringify(started.env)).not.toContain('REAL-SECRET');
    expect(started.env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^limn-placeholder-/);
    // Never on the wire: the seed, a patch.
    expect(JSON.stringify(b)).not.toContain('seedJson');
    M.subscribeSession(id, 1, (e) => void frames.push(e));
  });

  it('one chat message is one turn; a second while it runs is refused', async () => {
    const r = await post(`/api/story-builds/${id}/messages`, { text: 'Reply with the single word: alpha.' });
    expect(r.statusCode).toBe(202);
    const busy = await post(`/api/story-builds/${id}/messages`, { text: 'and again' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('AgentBusy');
    expect((await post(`/api/story-builds/${id}/messages`, { text: '   ' })).statusCode).toBe(400);
    // Start build is refused while the chat turn runs too.
    expect((await post(`/api/story-builds/${id}/build`, {})).json().error).toBe('AgentBusy');
    releaseTurn();
    const b = await until(id, (x) => x.session?.phase === 'ready' && x.session.conversation.some((c) => c.kind === 'turn'), 'the chat turn');
    const kinds = b.session!.conversation.map((c) => c.kind);
    expect(kinds).toEqual(['reader', 'agent', 'turn']);
    expect(b.session!.conversation[1]).toMatchObject({ kind: 'agent', text: 'alpha.' });
    expect(b.session!.spend.turns).toBe(1);
    expect(b.planCostUsd).toBeCloseTo(0.101772, 6);
    // The stream carried the live partials and the stored items.
    expect(frames.some((f) => f.type === 'agent' && f.event.type === 'text' && f.event.partial)).toBe(true);
    expect(frames.some((f) => f.type === 'phase' && f.phase === 'chatting')).toBe(true);
    expect(frames.some((f) => f.type === 'item' && f.item.kind === 'agent')).toBe(true);
  });

  it('Start build reads the ticket again, says the criteria changed, builds, and stores the patches per repository', async () => {
    extractAnswer = (path) => (path.endsWith('/api') ? out(API_PATCH, ['src/export.ts'], 'feat: CSV export') : out('', [], ''));
    const r = await post(`/api/story-builds/${id}/build`, {});
    expect(r.statusCode).toBe(202);
    // Pressed twice: the build has started.
    const b = await until(id, (x) => x.session?.phase === 'built', 'built');
    expect(b.status).toBe('ready');
    expect(b.session!.mode).toBe('build');
    const notices = b.session!.conversation.filter((c) => c.kind === 'notice').map((c) => (c as { text: string }).text);
    expect(notices).toContain('The acceptance criteria changed since the session started: there are now 3.');
    expect(notices).toContain('Changes stored: acme/api (1 file).');
    // The fresh ticket went into TICKET.md; the build instruction says to read it again.
    const box = `limn-${(await rowOf(id)).sandboxRef}-sandbox`;
    expect(fake.files(box).get('/workspace/TICKET.md')!.toString()).toContain('Name the file after the report');
    expect(sentToClaude.at(-1)).toMatch(/^TICKET\.md was read again just now/);
    const repos = new Map(b.repos.map((x) => [x.fullName, x]));
    expect(repos.get('acme/api')).toMatchObject({ status: 'ready', hasPatch: true, filesChanged: ['src/export.ts'], commitMessage: 'feat: CSV export', summary: 'done.' });
    expect(repos.get('acme/web')).toMatchObject({ status: 'skipped', hasPatch: false });
    // The session's spend is the sum of its turns' ledger rows (the recorded build turn's figure is the
    // process total minus the chat turn's, as the driver computes it).
    expect(b.session!.spend.costUsd).toBeCloseTo(usage.reduce((a, u) => a + u.costUsd, 0), 6);
    expect(b.session!.spend.turns).toBe(2);
    expect(usage.map((u) => u.feature)).toEqual(['story_plan', 'story_build']);
    const again = await post(`/api/story-builds/${id}/build`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('NotReady');
  });

  it('the diff routes serve the stored patch; Push (the existing route) opens a draft and the session reads pushed', async () => {
    const all = (await get(`/api/story-builds/${id}/diff`)).json();
    expect(all.repos).toEqual([{ repoId: api, fullName: 'acme/api', baseSha: SHA.api, patch: API_PATCH, filesChanged: ['src/export.ts'], insertions: 1, deletions: 0 }]);
    const one = (await get(`/api/story-builds/${id}/repos/${api}/diff`)).json();
    expect(one.patch).toBe(API_PATCH);
    const pushed = await post(`/api/story-builds/${id}/repos/${api}/push`, {});
    expect(pushed.statusCode).toBe(200);
    expect(pushed.json().results[0]).toMatchObject({ outcome: 'pushed', prNumber: 700 });
    expect(G.pushes[0]).toMatchObject({ owner: 'acme', name: 'api', baseSha: SHA.api, baseRef: 'main', patch: API_PATCH, branch: 'limn/acme-300', draft: true, title: 'ACME-300: Export a report as CSV' });
    expect(G.pushes[0].body).toContain('[ACME-300: Export a report as CSV](https://acme.atlassian.net/browse/ACME-300)');
    const b = await read(id);
    expect(b.session!.phase).toBe('pushed');
    expect(b.pushedAll).toBe(true);
  });

  it('discard tears everything down; the stream of a closed session is one snapshot then done', async () => {
    const sid = (await rowOf(id)).sandboxRef as string;
    const r = await post(`/api/story-builds/${id}/discard`);
    expect(r.statusCode).toBe(200);
    expect(fake.resources().filter((x) => x.sessionId === sid)).toEqual([]);
    expect(frames.at(-1)).toEqual({ type: 'done' });
    const b = await read(id);
    expect(b.status).toBe('discarded');
    expect(b.session).toMatchObject({ phase: 'discarded', live: false });
    const s = await get(`/api/story-builds/${id}/stream`);
    expect(s.headers['content-type']).toMatch(/text\/event-stream/);
    const events = s.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'done']);
    // Another account sees nothing of it.
    expect((await get(`/api/story-builds/${id}`, 2)).statusCode).toBe(404);
    expect((await post(`/api/story-builds/${id}/messages`, { text: 'x' }, 2)).statusCode).toBe(404);
  });
});

async function rowOf(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.storyBuilds).where(eq(schema.storyBuilds.id, id)).execute())[0];
}

describe('limits, teardown, restart and resume', () => {
  it('no runtime: 409 NoRuntime with its line, and no row', async () => {
    fake.setDetection({ available: false, problem: 'Docker is not running.' });
    const before = (await db.select().from(schema.storyBuilds).execute()).length;
    const r = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT2 });
    fake.setDetection({ available: true, problem: null });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'NoRuntime', message: 'Docker is not running.' });
    expect((await db.select().from(schema.storyBuilds).execute()).length).toBe(before);
  });

  it('caps the open sessions, and closes an idle one (no patch ⇒ failed, the work is gone)', async () => {
    process.env.LIMN_SANDBOX_MAX_SESSIONS = '1';
    ticketReads = 0;
    const a = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT });
    expect(a.statusCode).toBe(202);
    const id = a.json().buildId;
    const b = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT2 });
    expect(b.statusCode).toBe(409);
    expect(b.json()).toEqual({ error: 'TooManySessions', message: 'A session is already open. Discard one first.' });
    await until(id, (x) => x.session?.phase === 'ready', 'ready');
    const sid = (await rowOf(id)).sandboxRef as string;
    await M._idleCloseForTest(id);
    const after = await read(id);
    expect(after.session).toMatchObject({ phase: 'failed', live: false, resumable: false });
    expect(after.error).toBe(`Closed after 60 minutes with nothing happening. ${M.GONE_LINE}`);
    expect(fake.resources().filter((x) => x.sessionId === sid)).toEqual([]);
    // The ticket is free again.
    expect(M.openSessionCount()).toBe(0);
  });

  it('the restart reconcile keeps a session with patches (built, resumable) and fails one without; Resume boots it again with the patches', async () => {
    const { insertStoryBuild, upsertStoryBuildRepo, updateStoryBuild, updateStoryBuildRepo } = await import('../../coding/story-build/persist.js');
    const mk = async (ident: string, key: string) => {
      const c = await insertStoryBuild(ctx, { accountId: 1, workspaceId: wsId, ident, ticketKey: key, ticketTitle: 'T', wantDiagram: false, wantDocs: false, provider: 'claude', model: 'claude-sonnet-5', session: { effort: 'medium', lastActiveAt: new Date() } });
      await updateStoryBuild(ctx, 1, c.id, { sessionPhase: 'building', status: 'building', sandboxRef: 'sb-gone' });
      return c.id;
    };
    const kept = await mk('jira:https://acme.atlassian.net#ACME-310', 'ACME-310');
    const lost = await mk('jira:https://acme.atlassian.net#ACME-311', 'ACME-311');
    const row = await upsertStoryBuildRepo(ctx, { accountId: 1, buildId: kept, repoId: api, ref: 'R1', buildOrder: 0, include: true, status: 'ready', baseRef: 'main', baseSha: SHA.api, stackedOnPrId: null, branch: 'limn/acme-310' });
    await updateStoryBuildRepo(ctx, 1, row, { patch: API_PATCH, commitMessage: 'feat: kept' });
    expect(await M.reconcileSessionsOnStartup(ctx)).toBe(2);
    const k = await read(kept);
    expect(k.session).toMatchObject({ phase: 'built', live: false, resumable: true });
    expect(k.status).toBe('ready');
    expect(k.error).toBe(`${M.RESTART_LINE} ${M.KEPT_LINE}`);
    const l = await read(lost);
    expect(l.session!.phase).toBe('failed');
    expect(l.error).toBe(`${M.RESTART_LINE} ${M.GONE_LINE}`);
    // Run twice: nothing moves.
    expect(await M.reconcileSessionsOnStartup(ctx)).toBe(0);
    // Only a session with stored changes resumes.
    expect((await post(`/api/story-builds/${lost}/resume`)).json().error).toBe('NotResumable');

    const execsBefore = fake.calls.length;
    const r = await post(`/api/story-builds/${kept}/resume`);
    expect(r.statusCode).toBe(202);
    const b = await until(kept, (x) => x.session?.phase === 'built' && x.session.live, 'resumed');
    expect(b.session!.mode).toBe('build');
    expect(b.session!.boot.map((s) => s.key)).toContain('patches');
    const restored = fake.calls.slice(execsBefore).filter((c) => c.method === 'exec' && /git apply --index/.test(String((c.args[1] as string[])[2])));
    expect(restored).toHaveLength(1);
    expect((restored[0]!.args[1] as string[])[4]).toBe('/workspace/acme/api');
    // The repository row kept its base and patch (never reset to `planned`).
    expect(b.repos.find((x) => x.repoId === api)).toMatchObject({ status: 'ready', baseSha: SHA.api, hasPatch: true });
    expect((await post(`/api/story-builds/${kept}/discard`)).statusCode).toBe(200);
  });
});
