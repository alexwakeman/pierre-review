// EVERY END REMOVES THE SANDBOX (docs/SANDBOX.md § Every end removes the sandbox). Each way a session
// can end, on the REAL manager and a scratch SQLite, with the FAKE runtime (its `resources()` is the
// leak detector) and a STUB agent driver whose turns the test holds and releases:
//
//   discard · the idle close (no work ⇒ failed; work ⇒ built, then Resume starts a sandbox again) · the
//   agent ending · a failed boot after the network was made · a turn past its cap (it stops; one that
//   will not stop closes the session) · "Stop all" (a running turn's work is kept) · the shutdown
//   teardown · the 'exit' fallback · a removal the daemon refused, then the periodic sweep · the sweep
//   gate (a session booted during a sweep waits for it) · the count Settings shows.
// The AI Fix ends (push, an unattended fix, Stop) are in fix-session-flow-db.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SandboxTurnOutcome } from '@pierre-review/shared';
import type { SandboxAgentDriver, SandboxTurnEnd } from '../drivers/types.js';
import { EXTRACT_SCRIPT } from './patches.js';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-sandbox-cleanup`}.sandbox-cleanup-flow.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('../../tracker/manual-links.js', () => ({ resolveTicketRefs: async () => ({ ok: true, body: { results: [] } }) }));
vi.mock('../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));
vi.mock('../../review/clone-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../review/clone-manager.js')>()),
  repoCloneDir: () => '/nonexistent/limn-test-clone',
  removeWorktreeLocked: async () => {},
}));

const SHA = 'c'.repeat(40);
const PATCH = 'diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n';
const out = (patch: string): string =>
  ['@@LIMN-PATCH@@ commits', patch ? '1' : '0', '@@LIMN-PATCH@@ numstat', ...(patch ? ['1\t0\ta.ts'] : []), '@@LIMN-PATCH@@ messages', '', '@@LIMN-PATCH@@ patch', patch].join('\n');

let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let J: typeof import('./janitor.js');
let fake: import('../runtime/fake.js').FakeRuntime;
let baseDeps: Partial<import('./manager.js').SessionDeps>;
let wsId = 0;
let repoId = 0;
let scratch = '';
let n = 0;
let patchOut = '';

/** The stub agent: every turn ends at once unless `hold`; `interrupt` ends a held turn unless `deaf`. */
const A = { hold: false, deaf: false, drivers: [] as Array<{ exit: () => void; end: (o: SandboxTurnOutcome) => void }> };

function stubDriver(choice: any, startMode: 'chat' | 'build'): SandboxAgentDriver {
  let mode = startMode;
  let busy = false;
  let pending: ((o: SandboxTurnOutcome) => void) | null = null;
  let exit!: () => void;
  const exited = new Promise<void>((r) => (exit = r));
  const end = (o: SandboxTurnOutcome): void => {
    const p = pending;
    pending = null;
    p?.(o);
  };
  A.drivers.push({ exit, end });
  return {
    provider: 'claude',
    choice,
    mode: () => mode,
    agentRef: () => 'agent-1',
    busy: () => busy,
    send: () =>
      new Promise<SandboxTurnEnd>((res) => {
        busy = true;
        pending = (outcome) => {
          busy = false;
          res({ turn: 1, mode, outcome, usage: null, text: 'Done.', changedInChat: [] });
        };
        if (!A.hold) end('completed');
      }),
    async startBuild() {
      mode = 'build';
    },
    async interrupt() {
      if (!A.deaf) end('interrupted');
    },
    async close() {
      A.deaf = false;
      end('interrupted');
      exit();
    },
    exited,
  };
}

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
  rt.onExec((argv) => argv[0] === 'sh' && /tar -x/.test(argv[2] ?? ''), async (c) => {
    for await (const _l of c.stdin) void _l;
    c.stdout(`${c.argv[6]}\n`);
    return 0;
  });
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === EXTRACT_SCRIPT, async (c) => {
    c.stdout(patchOut);
    return 0;
  });
  rt.onExec((argv) => argv[0] === 'sh' && /git apply --index --binary/.test(argv[2] ?? ''), { code: 0 });
}

const ticket = (ident: string) => ({
  ident,
  key: ident.split('#')[1]!,
  title: 'Export a report as CSV',
  url: 'https://acme.atlassian.net/browse/X',
  description: 'Customers download any report as a CSV file.',
  acceptanceCriteria: '',
  acceptanceCriteriaText: '',
  criteria: [{ n: 1, text: 'Stream every row' }],
  criteriaSource: 'brief' as const,
  openPoints: [],
  comments: null,
  prs: [],
  gaps: null,
  fresh: true,
  readAt: null,
});

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'limn-session-cleanup-'));
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  wsId = await q.ensureDefaultWorkspace(1);
  const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R-api', owner: 'acme', name: 'api', defaultBranch: 'main', viewerPermission: 'WRITE' }).returning().execute();
  repoId = r.id;
  await q.resolveWorkspaceScope(1, null);

  M = await import('./manager.js');
  J = await import('./janitor.js');
  const { createFakeRuntime } = await import('../runtime/fake.js');
  const { setSandboxRuntimeForTests } = await import('../runtime/index.js');
  const { startEgress } = await import('../proxy/egress.js');
  fake = createFakeRuntime();
  scriptFake(fake);
  setSandboxRuntimeForTests(fake);
  const claudeDir = join(scratch, 'claude');
  baseDeps = {
    planFirst: false,
    runtime: () => fake,
    storyInputs: async (_c, _a, _w, ident) => ({ ticketKey: ident.split('#')[1]!, title: 'T', empty: false }),
    readTicket: async (_c, _a, _w, ident) => ticket(ident),
    coverage: async () => null,
    settings: async () => null,
    ticketPrs: async () => [],
    places: () => ({ claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [] }, home: '/nowhere', dataDir: '/nowhere/.limn' }),
    mirrorSeams: {
      prepare: async () => ({ sha: SHA, dir: '/fake', cleanup: async () => {} }),
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
    startAgent: async (o) => stubDriver(o.choice, o.mode ?? 'chat'),
    credentialEnv: () => ({}),
    usageSink: { record: async () => {}, noteClaudeRateLimit: () => {} },
  };
  M.setSessionDepsForTests(baseDeps);
  ctx = { db, schema, log: { info() {}, warn() {}, error() {} }, recordAiUsage: async () => {}, github: {} };
});

afterEach(async () => {
  A.hold = false;
  A.deaf = false;
  patchOut = '';
  fake.failDestroy(false);
  M.setSessionDepsForTests(baseDeps);
  await M._closeAllSessionsForTest();
  M._resetRemovalForTest();
  delete process.env.LIMN_SANDBOX_MAX_SESSIONS;
});

afterAll(async () => {
  await M?._closeAllSessionsForTest();
  M?.setSessionDepsForTests(null);
  const { setSandboxRuntimeForTests } = await import('../runtime/index.js');
  setSandboxRuntimeForTests(null);
  await closeDb?.();
  rmSync(scratch, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

async function rowOf(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.storyBuilds).where(eq(schema.storyBuilds.id, id)).execute())[0];
}

const resourcesOf = (sid: string) => fake.resources().filter((x) => x.sessionId === sid);
const live = () => fake.resources().filter((x) => x.kind !== 'image');

async function until<T>(fn: () => Promise<T> | T, test: (v: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const v = await fn();
    if (test(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A new session, booted to `ready` (chat mode, no turn). Returns its row id and sandbox id. */
async function startReady(): Promise<{ id: number; sid: string }> {
  n += 1;
  const r = await M.startSession(ctx, {
    accountId: 1,
    workspaceId: wsId,
    memberRepoIds: [repoId],
    ident: `jira:https://acme.atlassian.net#CLN-${n}`,
    ticketKey: `CLN-${n}`,
    ticketTitle: 'T',
    action: 'implement',
    choice: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' } as any,
  });
  if (r.outcome !== 'started') throw new Error(`not started: ${r.outcome}`);
  const row = await until(() => rowOf(r.id), (x) => x.sessionPhase === 'ready' || x.sessionPhase === 'failed', 'ready');
  expect(row.sessionPhase).toBe('ready');
  expect(resourcesOf(row.sandboxRef).length).toBeGreaterThan(0);
  return { id: r.id, sid: row.sandboxRef as string };
}

/** Start build, wait for the build turn to end (`built`, the patch stored). */
async function build(id: number): Promise<void> {
  patchOut = out(PATCH);
  const r = await M.startSessionBuild(ctx, 1, id, null);
  expect(r.status).toBe('queued');
  await until(() => rowOf(id), (x) => x.sessionPhase === 'built', 'built');
}

describe('every end removes the sandbox', () => {
  it('the idle timeout is ONE constant, 15 minutes; a turn is capped at 120', async () => {
    expect(M.idleLine(15)).toBe('Closed after 15 minutes with nothing happening.');
    const { sessionLimits } = await import('./limits.js');
    expect(sessionLimits({}).idleMs).toBe(15 * 60_000);
    expect(sessionLimits({}).turnMaxMs).toBe(120 * 60_000);
    expect(sessionLimits({ LIMN_SANDBOX_IDLE_MINUTES: '5' }).idleMs).toBe(5 * 60_000);
  });

  it('discard: the container, the proxy, the network and the volume go', async () => {
    const { id, sid } = await startReady();
    expect(resourcesOf(sid).map((r) => r.role).sort()).toEqual(['network', 'proxy', 'sandbox', 'volume']);
    await M.discardSession(ctx, 1, id);
    expect(resourcesOf(sid)).toEqual([]);
    expect((await rowOf(id)).sessionPhase).toBe('discarded');
    expect(M._undestroyedForTest()).toEqual([]);
  });

  it('idle with no work: closed as failed, nothing left', async () => {
    const { id, sid } = await startReady();
    await M._idleCloseForTest(id);
    expect(resourcesOf(sid)).toEqual([]);
    const row = await rowOf(id);
    expect(row.sessionPhase).toBe('failed');
    expect(row.sandboxRef).toBeNull();
  });

  it('idle with stored work (a kept session): the sandbox goes, the changes stay; Resume starts a new one on demand', async () => {
    const { id, sid } = await startReady();
    await build(id);
    await M._idleCloseForTest(id);
    expect(resourcesOf(sid)).toEqual([]);
    expect((await rowOf(id)).sessionPhase).toBe('built');
    expect(M.isSessionLive(id)).toBe(false);
    const r = await M.resumeSession(ctx, 1, id);
    expect(r).toEqual({ status: 'queued', id });
    const row = await until(() => rowOf(id), (x) => x.sessionPhase === 'built' && x.sandboxRef != null && M.isSessionLive(id), 'resumed');
    expect(resourcesOf(row.sandboxRef).some((x) => x.role === 'sandbox')).toBe(true);
    await M.discardSession(ctx, 1, id);
    expect(resourcesOf(row.sandboxRef)).toEqual([]);
  });

  it('the agent ending on its own closes the session and removes the sandbox', async () => {
    const { id, sid } = await startReady();
    A.drivers.at(-1)!.exit();
    await until(() => rowOf(id), (x) => x.sessionPhase === 'failed', 'closed');
    expect(resourcesOf(sid)).toEqual([]);
  });

  it('a boot that fails after the network was made removes what it made', async () => {
    M.setSessionDepsForTests({
      ...baseDeps,
      startEgress: async () => {
        throw new Error('The proxy would not start.');
      },
    });
    n += 1;
    const r = await M.startSession(ctx, { accountId: 1, workspaceId: wsId, memberRepoIds: [repoId], ident: `jira:https://acme.atlassian.net#CLN-${n}`, ticketKey: `CLN-${n}`, ticketTitle: 'T', action: 'implement', choice: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' } as any });
    if (r.outcome !== 'started') throw new Error('not started');
    await until(() => rowOf(r.id), (x) => x.sessionPhase === 'failed', 'failed');
    const made = fake.calls.filter((c) => c.method === 'createNetwork').at(-1)!.args[0] as { sessionId: string };
    expect(resourcesOf(made.sessionId)).toEqual([]);
  });

  it('a turn past its cap stops; the stopped turn keeps the session (and its sandbox) for the next message', async () => {
    const { id, sid } = await startReady();
    A.hold = true;
    expect((await M.sendSessionMessage(ctx, 1, id, 'go')).status).toBe('queued');
    await until(() => M.liveSession(`story:${id}`)?.driver?.busy() === true, Boolean, 'the turn running');
    // The grace: the interrupted turn ends within it, so the session stays.
    await M._turnTimeoutForTest(`story:${id}`, 300);
    await until(() => rowOf(id), (x) => x.sessionPhase === 'ready', 'the turn ended');
    expect(M.isSessionLive(id)).toBe(true);
    expect(M.liveSession(`story:${id}`)!.state.conversation.some((i: any) => i.kind === 'notice' && /without finishing, so it was stopped/.test(i.text))).toBe(true);
    expect(resourcesOf(sid).length).toBeGreaterThan(0);
  });

  it('a turn past its cap that will not stop: the session closes and the sandbox goes', async () => {
    const { id, sid } = await startReady();
    A.hold = true;
    A.deaf = true;
    expect((await M.sendSessionMessage(ctx, 1, id, 'go')).status).toBe('queued');
    await until(() => M.liveSession(`story:${id}`)?.driver?.busy() === true, Boolean, 'the turn running');
    await M._turnTimeoutForTest(`story:${id}`, 0);
    expect(resourcesOf(sid)).toEqual([]);
    const row = await rowOf(id);
    expect(row.sessionPhase).toBe('failed');
    expect(row.error).toMatch(/^The agent worked for 120 minutes without finishing, so it was stopped\./);
  });

  it('"Stop all": a running build turn is stopped and its work stored (built, resumable); every sandbox goes; the count reads 0', async () => {
    process.env.LIMN_SANDBOX_MAX_SESSIONS = '2';
    const a = await startReady();
    const b = await startReady();
    expect(await J.runningSandboxes({ backends: [fake] })).toEqual({ running: 2, problem: null });
    A.hold = true;
    patchOut = out(PATCH);
    expect((await M.startSessionBuild(ctx, 1, a.id, null)).status).toBe('queued');
    await until(() => M.liveSession(`story:${a.id}`)?.driver?.busy() === true, Boolean, 'the build turn running');
    const r = await J.stopAllSandboxes({ backends: [fake] });
    expect(r).toEqual({ stopped: 2, running: 0, problem: null });
    expect(live()).toEqual([]);
    const ra = await rowOf(a.id);
    expect(ra.sessionPhase).toBe('built');
    expect(ra.error).toBe(`${M.STOPPED_LINE} ${M.KEPT_LINE}`);
    expect((await rowOf(b.id)).sessionPhase).toBe('failed');
    expect(M.openSessionCount()).toBe(0);
  });

  it('"Stop all" also removes a leftover no session owns (a crash\'s), and only this install\'s labelled ones', async () => {
    fake.plant({ kind: 'container', name: 'limn-gone1-sandbox', sessionId: 'gone1', role: 'sandbox' });
    fake.plant({ kind: 'network', name: 'limn-gone1-net', sessionId: 'gone1', role: 'network' });
    expect(await J.runningSandboxes({ backends: [fake] })).toEqual({ running: 1, problem: null });
    const r = await J.stopAllSandboxes({ backends: [fake] });
    expect(r).toEqual({ stopped: 1, running: 0, problem: null });
    expect(live()).toEqual([]);
  });

  it('the count says when no runtime answers', async () => {
    fake.setDetection({ daemonReachable: false, available: false, problem: 'Docker is not running.' });
    try {
      expect(await J.runningSandboxes({ backends: [fake] })).toEqual({ running: null, problem: 'No container runtime answers.' });
    } finally {
      fake.setDetection({ daemonReachable: true, available: true, problem: null });
    }
  });

  it('Limn stopping (a signal): every live sandbox is removed, with no row written (the restart reconcile settles it)', async () => {
    const { id, sid } = await startReady();
    expect(await M.teardownSandboxesForShutdown(5_000)).toBe(1);
    expect(resourcesOf(sid)).toEqual([]);
    expect((await rowOf(id)).sessionPhase).toBe('ready');
  });

  it("the process's 'exit' force-removes the containers of a session still there", async () => {
    const { sid } = await startReady();
    M.destroyLeftSync();
    expect(fake.calls.filter((c) => c.method === 'destroySync').at(-1)!.args[0]).toEqual([sid]);
    expect(resourcesOf(sid).filter((x) => x.kind === 'container')).toEqual([]);
  });

  it('a removal the daemon refused is left for the periodic sweep, which removes it and then rests', async () => {
    const { id, sid } = await startReady();
    fake.failDestroy(true);
    await M.discardSession(ctx, 1, id);
    fake.failDestroy(false);
    expect(resourcesOf(sid).length).toBeGreaterThan(0);
    expect(M._undestroyedForTest()).toEqual([sid]);
    expect(M.sandboxesNeedSweep()).toBe(true);
    const swept = await J.sandboxJanitorTick({ backends: [fake] });
    expect(swept?.containers.sort()).toEqual([`limn-${sid}-proxy`, `limn-${sid}-sandbox`]);
    expect(resourcesOf(sid)).toEqual([]);
    expect(M.sandboxesNeedSweep()).toBe(false);
    // Rested: the next tick starts nothing.
    const sweeps = fake.calls.filter((c) => c.method === 'sweep').length;
    expect(await J.sandboxJanitorTick({ backends: [fake] })).toBeNull();
    expect(fake.calls.filter((c) => c.method === 'sweep').length).toBe(sweeps);
  });

  it('the periodic sweep keeps a live session; a session booted during a sweep waits for it', async () => {
    const a = await startReady();
    const swept = await J.sandboxJanitorTick({ backends: [fake], force: true });
    expect(swept?.containers).toEqual([]);
    expect(resourcesOf(a.sid).length).toBeGreaterThan(0);

    // A sweep that hangs: a session started meanwhile creates nothing until it ends.
    let release: () => void = () => {};
    const slow = { ...fake, sweep: async (liveIds: Iterable<string>, o?: { dryRun?: boolean }) => (await new Promise<void>((r) => (release = r)), fake.sweep(liveIds, o)) };
    const detects = fake.calls.filter((c) => c.method === 'detect').length;
    const tick = J.sandboxJanitorTick({ backends: [slow as typeof fake], force: true });
    await until(() => fake.calls.filter((c) => c.method === 'detect').length, (x) => x > detects, 'the sweep started');
    const networksBefore = fake.calls.filter((c) => c.method === 'createNetwork').length;
    n += 1;
    process.env.LIMN_SANDBOX_MAX_SESSIONS = '2';
    const r = await M.startSession(ctx, { accountId: 1, workspaceId: wsId, memberRepoIds: [repoId], ident: `jira:https://acme.atlassian.net#CLN-${n}`, ticketKey: `CLN-${n}`, ticketTitle: 'T', action: 'implement', choice: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' } as any });
    expect(r.outcome).toBe('started');
    await new Promise((res) => setTimeout(res, 50));
    expect(fake.calls.filter((c) => c.method === 'createNetwork').length).toBe(networksBefore);
    release();
    await tick;
    const id = (r as { id: number }).id;
    const row = await until(() => rowOf(id), (x) => x.sessionPhase === 'ready', 'ready after the sweep');
    expect(resourcesOf(row.sandboxRef).length).toBeGreaterThan(0);
  });
});
