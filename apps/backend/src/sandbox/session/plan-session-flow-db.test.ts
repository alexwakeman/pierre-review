// PLAN FIRST, END TO END over the REAL routes, manager, plan stage, validator, verifier and persistence on a
// scratch SQLite. The edges are fakes: the FAKE runtime, a SCRIPTED Claude stream (the recorded spike-1
// lines with the agent's text replaced turn by turn), the clone cache's blob reader and the budget gate.
//
//   start → boot → the opening turn sent UNPROMPTED → a plan block → revision 1 stored (host-verified code
//   evidence; the stored conversation has no JSON) → Start build refused → Approve refused (unanswered,
//   stale) → Agree → Reply → revision 2 (the answer carried) → Approve → PLAN.md, the planned PR rows, the
//   build report's checker and ONE build turn → the STACKED extraction with REAL GIT (Limn's own
//   EXTRACT_STACK_SCRIPT on local repositories shaped as the mirror makes them, the host's check against a
//   local clone playing the clone cache) → a turn that hit the turn cap with work left gets ONE automatic
//   continuation (the budget gate asked) → built, each planned PR ready with the host's patch and the build
//   report's words.
// Then: no block ⇒ the ONE repair turn asks the budget gate (refused ⇒ no turn, one line; allowed ⇒ one
// turn); an idle close in the plan stage keeps the plan (plan_ready, resumable); Resume sends no turn; the
// restart reconcile.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SandboxSessionStreamEvent, StoryBuild } from '@pierre-review/shared';
import { EXTRACT_SCRIPT } from './patches.js';
import { EXTRACT_STACK_SCRIPT, RESTORE_STACK_SCRIPT } from './stack.js';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-sandbox-session`}.plan-session-flow.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('../../coding/git-ops.js', () => ({ applyAndPushBranch: async () => ({}) }));
vi.mock('../../tracker/manual-links.js', () => ({ resolveTicketRefs: async () => ({ ok: true, body: { results: [] } }) }));
vi.mock('../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));
vi.mock('../../review/clone-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../review/clone-manager.js')>()),
  repoCloneDir: () => '/nonexistent/limn-test-clone',
  removeWorktreeLocked: async () => {},
}));

const IDENT = 'jira:https://acme.atlassian.net#ACME-400';
const IDENT2 = 'jira:https://acme.atlassian.net#ACME-401';
const SHA = { api: 'a'.repeat(40), web: 'b'.repeat(40) };
const EXPORT_TS = 'import { db } from "./db";\nexport const MAX_ROWS = 1000;\nexport const rows = () => db.take(MAX_ROWS);\n';

const OUT = readFileSync(fileURLToPath(new URL('../drivers/__fixtures__/claude-interactive.out.jsonl', import.meta.url)), 'utf8').split('\n').filter(Boolean);

/** One recorded chat turn (lines 1..11) with the agent's text replaced and its own message id. */
function chatTurnLines(text: string, n: number): string[] {
  return OUT.slice(1, 12).map((raw, i) => {
    const j = JSON.parse(raw.replaceAll('msg_011CgnbzreYJQFBV9v2cFSAN', `msg_T${n}`));
    if (i === 4) j.event.delta.text = text;
    if (i === 5) j.message.content[0].text = text;
    if (i === 10 && typeof j.result === 'string') j.result = text;
    return JSON.stringify(j);
  });
}

const PLAN = (over: Record<string, unknown> = {}) => ({
  schema: 'limn.plan/1',
  summary: 'Stream the rows from the API and add the button to the web app.',
  repos: [
    { repo: 'acme/api', why: 'The export endpoint.' },
    { repo: 'acme/web', why: 'The Download CSV button.' },
  ],
  criteria: [
    { ref: 'AC1', status: 'planned', how: 'Page through the rows in the endpoint.', prs: ['P1'] },
    { ref: 'AC2', status: 'planned', how: 'A button on the report page.', prs: ['P2'] },
  ],
  contentions: [
    {
      id: 'C1',
      about: ['AC1'],
      storySays: 'Stream every row',
      problem: 'The API caps every export at 1000 rows.',
      proposal: 'Page through all rows.',
      ifKept: 'Remove the cap.',
      evidence: [{ kind: 'code', repo: 'acme/api', path: 'src/export.ts', lines: [2, 2], quote: 'export const MAX_ROWS = 1000;' }],
    },
  ],
  stack: [
    { id: 'P1', repo: 'acme/api', title: 'Stream the export', contains: 'The endpoint.', criteria: ['AC1'], dependsOn: [] },
    { id: 'P2', repo: 'acme/web', title: 'Add the Download CSV button', contains: 'The button.', criteria: ['AC2'], dependsOn: ['P1'] },
  ],
  stackReason: null,
  ticketUpdate: { description: null, acceptanceCriteria: '1. Stream every row, in pages of 1000\n2. A Download CSV button', why: 'C1', contentions: ['C1'] },
  ...over,
});
const withBlock = (lead: string, plan: unknown): string => `${lead}\n\n\`\`\`limn-plan\n${JSON.stringify(plan)}\n\`\`\``;

let app: FastifyInstance;
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let M: typeof import('./manager.js');
let P: typeof import('./plan.js');
let fake: import('../runtime/fake.js').FakeRuntime;
let wsId = 0;
let scratch = '';
const sentToClaude: string[] = [];
/** What the agent answers to each chat turn, in order. */
const answers: string[] = [];
let gateAllows = true;
let docsBuilt = false;
const SECTION = '<!-- limn:section -->\n# Refunds\n\nRefunds are allowed for 14 days after the order.\n';
const LIB = {
  workspaceId: 1,
  dir: '/lib',
  docs: [{ slug: 'billing', title: 'Billing handbook', sections: [{ path: 'billing/sections/01-refunds.md', title: 'Refunds', summary: '', trail: [], headings: [] }] }],
  read: (p: string) => (p === 'billing/sections/01-refunds.md' ? SECTION : p === 'billing/CONTENTS.md' ? '# Contents' : null),
} as any;
const gateAsked: string[] = [];
/** The continuation's budget question (the manager's own gate seam). */
const continueAsked: string[] = [];
/** How each build turn ends, in order ('max_turns' hits the turn cap); default success. */
const buildOutcomes: string[] = [];
/** What the "agent" does in the local repositories during a build turn. */
let agentWork: (() => void) | null = null;
/** The build report the "agent" leaves (null: none). */
let buildReport: unknown = null;

// REAL GIT for the stacked extraction: per repository, the sandbox's clone ("box", the mirror's shape:
// refs/limn/base, the session branch checked out) and Limn's clone cache ("cache").
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GENV, encoding: 'utf8' }).trim();
const BOX: Record<string, string> = {};
const CACHE: Record<string, string> = {};
const REAL_BASE: Record<string, string> = {};
function realRepos(root: string): void {
  for (const name of ['api', 'web']) {
    const box = join(root, `box-${name}`);
    execFileSync('git', ['init', '-q', '-b', 'main', box], { env: GENV });
    writeFileSync(join(box, 'README.md'), `${name}\n`);
    sh(box, 'add', '-A');
    sh(box, 'commit', '-qm', 'base');
    REAL_BASE[`acme/${name}`] = sh(box, 'rev-parse', 'HEAD');
    sh(box, 'update-ref', 'refs/limn/base', 'HEAD');
    sh(box, 'checkout', '-q', '-b', 'limn/acme-400');
    CACHE[`acme/${name}`] = join(root, `cache-${name}`);
    execFileSync('git', ['clone', '-q', box, CACHE[`acme/${name}`]!], { env: GENV });
    BOX[name] = box;
  }
}
const boxOf = (repoPath: string): string => (repoPath.replace(/\/+$/, '').endsWith('api') ? BOX.api! : BOX.web!);

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
  // The docs copy made read only (root).
  rt.onExec((argv) => argv[0] === 'sh' && /chown -R root:root/.test(argv[2] ?? ''), { code: 0 });
  // The stacked extraction: Limn's own script, run on the local repository.
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === EXTRACT_STACK_SCRIPT, async (c) => {
    const box = boxOf(c.argv[4]!);
    try {
      c.stdout(execFileSync('sh', ['-c', EXTRACT_STACK_SCRIPT, 'sh', box, ...c.argv.slice(5)], { env: GENV, maxBuffer: 64 << 20 }));
      return 0;
    } catch (e: any) {
      c.stderr(String(e.stderr ?? e));
      return typeof e.status === 'number' ? e.status : 1;
    }
  });
  // Resume of an approved stack: Limn's own restore script on the local repository (the patch and the
  // message were copied into the fake sandbox; they are handed to the script from there).
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === RESTORE_STACK_SCRIPT, async (c) => {
    const files = rt.files(c.container);
    const patch = join(scratch, `restore-${Date.now()}-${Math.random()}.patch`);
    const msg = `${patch}.msg`;
    writeFileSync(patch, String(files.get(c.argv[6]!) ?? ''));
    writeFileSync(msg, String(files.get(c.argv[7]!) ?? 'x'));
    try {
      execFileSync('sh', ['-c', RESTORE_STACK_SCRIPT, 'sh', boxOf(c.argv[4]!), c.argv[5]!, patch, msg, c.argv[8]!], { env: GENV });
      return 0;
    } catch (e: any) {
      c.stderr(String(e.stderr ?? e));
      return 1;
    }
  });
  // The build report the agent left (`readBuildReport`'s read).
  rt.onExec((argv) => argv[0] === 'sh' && /^test -f "\$1" \|\| exit 4/.test(argv[2] ?? '') && /build-report\.json$/.test(argv[4] ?? ''), async (c) => {
    if (buildReport == null) return 4;
    c.stdout(JSON.stringify(buildReport));
    return 0;
  });
  rt.onExec((argv) => argv[0] === 'sh' && argv[2] === EXTRACT_SCRIPT, async (c) => {
    c.stdout(['@@LIMN-PATCH@@ commits', '0', '@@LIMN-PATCH@@ numstat', '@@LIMN-PATCH@@ messages', '', '@@LIMN-PATCH@@ patch', ''].join('\n'));
    return 0;
  });
  rt.onExec((argv) => argv[0] === 'claude', async (c) => {
    let n = 0;
    let build = false;
    for await (const line of c.stdin) {
      const msg = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype: string; mode?: string }; message?: { content: string } };
      if (msg.type === 'control_request') {
        if (msg.request!.subtype === 'initialize') c.stdout(`${OUT[0]}\n`);
        if (msg.request!.subtype === 'set_permission_mode') {
          build = true;
          c.stdout(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode: msg.request!.mode } } })}\n`);
        }
        continue;
      }
      if (msg.type !== 'user') continue;
      sentToClaude.push(String(msg.message?.content ?? ''));
      n += 1;
      if (build) {
        agentWork?.();
        const outcome = buildOutcomes.shift() ?? 'completed';
        for (let i = 48; i <= 79; i++) {
          if (i === 79 && outcome === 'max_turns') {
            const j = JSON.parse(OUT[i]!);
            c.stdout(`${JSON.stringify({ ...j, subtype: 'error_max_turns', is_error: true })}\n`);
          } else c.stdout(`${OUT[i]}\n`);
        }
        continue;
      }
      for (const l of chatTurnLines(answers.shift() ?? 'I have nothing to add.', n)) c.stdout(`${l}\n`);
    }
    return 0;
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'limn-plan-flow-'));
  realRepos(scratch);
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
    await db.insert(schema.repos).values({ accountId: 1, githubNodeId: `R-${name}`, owner: 'acme', name, defaultBranch: 'main', viewerPermission: 'WRITE' }).execute();
  }
  await q.resolveWorkspaceScope(1, null);

  M = await import('./manager.js');
  P = await import('./plan.js');
  const { createFakeRuntime } = await import('../runtime/fake.js');
  const { startEgress } = await import('../proxy/egress.js');
  fake = createFakeRuntime();
  scriptFake(fake);
  const claudeDir = join(scratch, 'claude');
  M.setSessionDepsForTests({
    runtime: () => fake,
    storyInputs: async (_c, _a, _w, ident) => ({ ticketKey: ident === IDENT ? 'ACME-400' : 'ACME-401', title: 'Export a report as CSV', empty: false }),
    readTicket: async (_c, _a, _w, ident) => ({
      ident,
      key: ident === IDENT ? 'ACME-400' : 'ACME-401',
      title: 'Export a report as CSV',
      url: null,
      description: 'Customers download any report as a CSV file.',
      acceptanceCriteriaText: '',
      criteria: [
        { n: 1, text: 'Stream every row' },
        { n: 2, text: 'A Download CSV button' },
      ],
      criteriaSource: 'brief' as const,
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
    usageSink: { record: async () => {}, noteClaudeRateLimit: () => {} },
    docsAvailable: async () => docsBuilt,
    automaticAllowed: async (_c, _a, provider) => {
      continueAsked.push(provider);
      return true;
    },
    chooseDocs: async () => ({ ok: true, lib: LIB, index: '# Index\n- billing', libraryHash: 'h1', choice: { source: 'whole', sections: ['billing/sections/01-refunds.md'] } }),
  });
  // The host's check, REAL, against the local clone cache. The fake mirror's base commit is a made-up sha,
  // so the check reads the repository's real base (the only stand-in on the host side).
  const { setStackSeamsForTests } = await import('./stack-turn.js');
  const { verifyStackBundle } = await import('../../coding/story-build/stack-verify.js');
  setStackSeamsForTests({ verify: async (_a, fullName, input) => verifyStackBundle({ ...input, gitDir: CACHE[fullName]!, baseSha: REAL_BASE[fullName]! }) });
  P.setPlanStageSeamsForTests({
    readBlob: async (_a, fullName, sha, path) => (fullName === 'acme/api' && sha === SHA.api && path === 'src/export.ts' ? Buffer.from(EXPORT_TS) : null),
    library: async () => LIB,
    automaticAllowed: async (_c, _a, provider) => {
      gateAsked.push(provider);
      return gateAllows;
    },
  });
  const ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    log: { info() {}, warn() {}, error() {} },
    accountIdOf: (req: any) => Number(req.headers['x-acct'] ?? 1),
    llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async () => {},
    github: {},
  };
  const Fastify = (await import('fastify')).default;
  const { registerSandboxSessionRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerSandboxSessionRoutes(app, ctx as never);
  await app.ready();
});

afterAll(async () => {
  await M?._closeAllSessionsForTest();
  M?.setSessionDepsForTests(null);
  P?.setPlanStageSeamsForTests(null);
  await app?.close();
  await closeDb?.();
  rmSync(scratch, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const post = (url: string, payload: any = {}, acct = 1) => app.inject({ method: 'POST', url, payload, headers: { 'x-acct': String(acct) } });
const get = (url: string, acct = 1) => app.inject({ method: 'GET', url, headers: { 'x-acct': String(acct) } });
const read = async (id: number): Promise<StoryBuild> => (await get(`/api/story-builds/${id}`)).json();

async function until(id: number, test: (b: StoryBuild) => boolean, what: string, ms = 10_000): Promise<StoryBuild> {
  const end = Date.now() + ms;
  for (;;) {
    await M._sessionsIdleForTest();
    const b = await read(id);
    if (test(b)) return b;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: sent ${sentToClaude.length} ${JSON.stringify(b.session?.conversation.slice(-6))} phase ${b.session?.phase}, plan ${JSON.stringify(b.session?.plan?.status)} ${b.session?.plan?.problem} ${b.error} ${JSON.stringify(b.session?.boot)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function rowOf(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.storyBuilds).where(eq(schema.storyBuilds.id, id)).execute())[0];
}

describe('plan first, end to end', () => {
  let id = 0;
  const frames: SandboxSessionStreamEvent[] = [];

  it('boots, sends the planning turn UNPROMPTED and stores revision 1 from the plan block', async () => {
    answers.push(withBlock('Two repositories, two pull requests. The cap on rows conflicts with AC1.', PLAN()));
    const r = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT });
    expect(r.statusCode, r.body).toBe(202);
    id = r.json().buildId;
    const b = await until(id, (x) => x.session?.phase === 'plan_ready', 'plan_ready');
    expect(b.status).toBe('plan_ready');
    // Nobody pressed anything: Limn sent the opening turn itself.
    expect(sentToClaude[0]).toMatch(/^Make the plan for this ticket now\. Do not change any file\./);
    const s = b.session!;
    expect(s.conversation[0]).toMatchObject({ kind: 'reader', text: 'Plan', build: false });
    const agent = s.conversation.find((c) => c.kind === 'agent')!;
    expect(agent).toMatchObject({ text: 'Two repositories, two pull requests. The cap on rows conflicts with AC1.\n\n(The plan went to Limn to check.)' });
    expect(JSON.stringify(s.conversation)).not.toContain('limn.plan/1');
    const plan = s.plan!;
    expect(plan).toMatchObject({ revisions: 1, unanswered: 1, status: 'ready', approvedRevision: null, withDocs: false, fillGaps: false });
    expect(plan.latest!.contentions[0]!.evidence[0]).toMatchObject({ kind: 'code', fullName: 'acme/api', path: 'src/export.ts', startLine: 2, endLine: 2, baseSha: SHA.api, excerpt: 'export const MAX_ROWS = 1000;' });
    expect(plan.latest!.criteria.map((c) => [c.ref, c.text, c.prs])).toEqual([
      ['AC1', 'Stream every row', ['P1']],
      ['AC2', 'A Download CSV button', ['P2']],
    ]);
    expect(plan.latest!.stack.map((p) => [p.key, p.fullName, p.branch])).toEqual([
      ['P1', 'acme/api', 'limn/acme-400'],
      ['P2', 'acme/web', 'limn/acme-400'],
    ]);
    expect(plan.latest!.ticketUpdate?.acceptanceCriteria).toBe('1. Stream every row, in pages of 1000\n2. A Download CSV button');
    // The checker and its context are in the sandbox; the planning turn was a chat turn (plan cost).
    const files = fake.files(`limn-${(await rowOf(id)).sandboxRef}-sandbox`);
    expect(files.has('/home/agent/.limn/plan-check.cjs')).toBe(true);
    expect(JSON.parse(String(files.get('/workspace/.limn/plan-context.json'))).criteria).toEqual(['AC1', 'AC2']);
    expect((await rowOf(id)).planCostUsd).toBeGreaterThan(0);
    expect(b.prs).toEqual([]);
    M.subscribeSession(id, 1, (e) => void frames.push(e));
  });

  it('Start build and Approve are refused until every point is answered, and on a stale revision', async () => {
    const build = await post(`/api/story-builds/${id}/build`, {});
    expect(build.statusCode).toBe(409);
    expect(build.json()).toEqual({ error: 'PlanNotApproved', message: 'Approve the plan to start the build.' });
    const unanswered = await post(`/api/story-builds/${id}/plan/approve`, { revision: 1 });
    expect(unanswered.statusCode).toBe(409);
    expect(unanswered.json()).toEqual({ error: 'PlanUnanswered', message: '1 point still to answer.' });
    const stale = await post(`/api/story-builds/${id}/plan/approve`, { revision: 9 });
    expect(stale.json().error).toBe('PlanStale');
    // Another account's id is not found.
    expect((await post(`/api/story-builds/${id}/plan/decisions`, { revision: 1, contentionId: 'C1', decision: 'agree' }, 2)).statusCode).toBe(404);
  });

  it('Agree is stored at once (no turn); a Reply is a revision turn; the answer carries to revision 2', async () => {
    const turnsBefore = sentToClaude.length;
    const d = await post(`/api/story-builds/${id}/plan/decisions`, { revision: 1, contentionId: 'C1', decision: 'agree' });
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ unanswered: 0, decisions: { C1: { decision: 'agree' } } });
    expect(sentToClaude.length).toBe(turnsBefore);
    expect(frames.some((f) => f.type === 'plan' && f.plan.unanswered === 0)).toBe(true);
    expect((await post(`/api/story-builds/${id}/plan/decisions`, { revision: 1, contentionId: 'C9', decision: 'agree' })).statusCode).toBe(404);

    answers.push(withBlock('Revised: the button has a tooltip now.', PLAN({ summary: 'Stream the rows; the button has a tooltip.' })));
    const r = await post(`/api/story-builds/${id}/plan/reply`, { revision: 1, contentionId: 'C1', text: 'Use pages of 500, not 1000.' });
    expect(r.statusCode).toBe(202);
    const b = await until(id, (x) => x.session?.plan?.revisions === 2 && x.session.phase === 'plan_ready', 'revision 2');
    const sent = sentToClaude.at(-1)!;
    expect(sent).toMatch(/^The reader answered your plan \(revision 1\):\n\n- C1: agreed\. Build your proposal\./);
    expect(sent).toContain("About C1, the reader says (the reader's words):\n````text\nUse pages of 500, not 1000.\n````");
    const plan = b.session!.plan!;
    expect(plan.latest!.revision).toBe(2);
    expect(plan.latest!.source).toBe('reply');
    expect(plan.decisions).toMatchObject({ C1: { decision: 'agree' } });
    expect(plan.unanswered).toBe(0);
    expect(plan.replies).toEqual([{ contentionId: 'C1', text: 'Use pages of 500, not 1000.', at: expect.any(String), revision: 1 }]);
    // An old revision stays readable.
    const old = await get(`/api/story-builds/${id}/plan?revision=1`);
    expect(old.json().revision.summary).toBe('Stream the rows from the API and add the button to the web app.');
  });

  it('Approve and start: PLAN.md, the planned PR rows, ONE build turn, the stacked extraction, one continuation', { timeout: 240_000 }, async () => {
    expect((await post(`/api/story-builds/${id}/plan/approve`, { revision: 1 })).json().error).toBe('PlanStale');
    // The "agent": a commit in acme/api; in acme/web an uncommitted file (folded into its one PR).
    agentWork = () => {
      if (sh(BOX.api!, 'rev-list', '--count', 'refs/limn/base..HEAD') === '0') {
        writeFileSync(join(BOX.api!, 'export.ts'), 'export const PAGE = 500;\n');
        sh(BOX.api!, 'add', '-A');
        sh(BOX.api!, 'commit', '-qm', 'Page through the export');
        writeFileSync(join(BOX.web!, 'button.tsx'), 'export const Download = 1;\n');
      }
    };
    // The first build turn hits the turn cap with P2 unfinished; the continuation finishes.
    buildOutcomes.push('max_turns', 'completed');
    buildReport = {
      prs: [
        { id: 'P1', status: 'done', summary: 'Pages through the rows, 500 at a time.', checks: [{ command: 'npm test', result: 'passed' }] },
        { id: 'P2', status: 'partly', summary: 'The Download CSV button.', checks: [] },
      ],
      criteria: [
        { ref: 'AC1', status: 'met', how: 'Pages of 500.' },
        { ref: 'AC2', status: 'partly', how: 'The button, no tooltip yet.' },
      ],
    };
    const turnsBefore = sentToClaude.length;
    const r = await post(`/api/story-builds/${id}/plan/approve`, { revision: 2, text: 'Keep the commits small.' });
    expect(r.statusCode).toBe(202);
    const b = await until(id, (x) => x.session?.phase === 'built' && sentToClaude.length === turnsBefore + 2, 'built after the continuation', 180_000);
    const sent = sentToClaude.at(-2)!;
    expect(sent).toMatch(/^The reader approved the plan \(revision 2\)\. Build it now\./);
    expect(sent).toContain('  - P1: `limn/acme-400` in acme/api');
    expect(sent).toContain('Finish with the build report: write `/workspace/.limn/build-report.json`');
    expect(sent).toContain('The reader adds:\n````text\nKeep the commits small.\n````');
    // ONE automatic continuation, the budget gate asked first; the second turn ended normally, so no more.
    expect(sentToClaude.at(-1)).toBe('Go on with the build from where you stopped. Follow PLAN.md, and finish with the build report.');
    expect(continueAsked).toEqual(['claude']);
    expect(b.session!.conversation.some((c) => c.kind === 'notice' && c.text === 'The build stopped at the turn limit with work left, so Limn asked the agent to go on (1 of 2).')).toBe(true);
    expect(b.session!.plan).toMatchObject({ status: 'approved', approvedRevision: 2 });
    expect(b.prs!.map((p) => [p.key, p.fullName, p.position, p.stackIndex, p.branch, p.status, p.criteria])).toEqual([
      ['P1', 'acme/api', 0, 1, 'limn/acme-400', 'ready', ['AC1']],
      ['P2', 'acme/web', 1, 1, 'limn/acme-400', 'ready', ['AC2']],
    ]);
    expect(b.prs![0]).toMatchObject({ filesChanged: ['export.ts'], summary: 'Pages through the rows, 500 at a time.', reported: 'done', checks: [{ command: 'npm test', result: 'passed', note: null }] });
    expect(b.prs![1]).toMatchObject({ filesChanged: ['button.tsx'], reported: 'partly', stat: { files: 1, commits: 1 } });
    // The patch is the host's, read from the PR route; the repository row holds the whole change.
    const diff = await get(`/api/story-builds/${id}/prs/${b.prs![0]!.id}/diff`);
    expect(diff.json().patch).toContain('+export const PAGE = 500;');
    expect(b.repos.map((x) => x.status)).toEqual(['ready', 'ready']);
    expect(frames.some((f) => f.type === 'prs' && f.prs.every((p) => p.status === 'ready'))).toBe(true);
    // The build report's checker and its context went in with PLAN.md.
    const files = fake.files(`limn-${(await rowOf(id)).sandboxRef}-sandbox`);
    expect(files.has('/home/agent/.limn/build-report-check.cjs')).toBe(true);
    expect(JSON.parse(String(files.get('/workspace/.limn/build-context.json')))).toEqual({ prs: ['P1', 'P2'], criteria: ['AC1', 'AC2'] });
    agentWork = null;
    buildReport = null;
    const plans = fake.files(`limn-${(await rowOf(id)).sandboxRef}-sandbox`).get('/workspace/PLAN.md');
    expect(String(plans)).toMatch(/The reader APPROVED this plan\. Build it\.[\s\S]*- C1 \(AC1\): The API caps every export at 1000 rows\.\n {2}AGREED: build this instead: Page through all rows\./);
    // Approved: the plan cannot change; a second approve is refused.
    expect((await post(`/api/story-builds/${id}/plan/decisions`, { revision: 2, contentionId: 'C1', decision: 'keep_story' })).statusCode).toBe(409);
    expect((await post(`/api/story-builds/${id}/plan/approve`, { revision: 2 })).statusCode).toBe(409);
  });

  it('an approved stack closed and RESUMED: each stored PR patch back as one commit on its branch', { timeout: 240_000 }, async () => {
    await M._idleCloseForTest(id);
    expect((await read(id)).session).toMatchObject({ phase: 'built', live: false, resumable: true });
    // A fresh clone: the session branch back at the base, nothing else.
    for (const box of [BOX.api!, BOX.web!]) {
      sh(box, 'reset', '-q', '--hard', 'refs/limn/base');
      sh(box, 'clean', '-qfdx');
    }
    expect((await post(`/api/story-builds/${id}/resume`)).statusCode).toBe(202);
    const b = await until(id, (x) => x.session?.live === true && x.session.phase === 'built', 'resumed', 120_000);
    expect(b.session!.mode).toBe('build');
    expect(sh(BOX.api!, 'diff', 'refs/limn/base', 'HEAD')).toContain('+export const PAGE = 500;');
    expect(sh(BOX.web!, 'log', '-1', '--format=%s')).toBe('Changes not committed in the sandbox');
    expect(sh(BOX.web!, 'show', '--stat', '--format=', 'HEAD')).toContain('button.tsx');
    expect((await post(`/api/story-builds/${id}/discard`)).statusCode).toBe(200);
  });
});

describe('no usable plan: the ONE repair turn and the budget gate', () => {
  it('refused by the gate: no turn, the stage says why, the session waits for the reader', async () => {
    gateAllows = false;
    gateAsked.length = 0;
    answers.push('I looked at the code. Here is my plan in words only.');
    const sentBefore = sentToClaude.length;
    const r = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT2 });
    const id = r.json().buildId;
    const b = await until(id, (x) => x.session?.phase === 'ready' && x.session.plan?.status === 'failed', 'failed plan');
    expect(gateAsked).toEqual(['claude']);
    // The opening turn only: no repair turn followed.
    expect(sentToClaude.length).toBe(sentBefore + 1);
    expect(b.session!.plan!.problem).toMatch(/^The agent did not submit a plan\./);
    expect(b.session!.conversation.some((c) => c.kind === 'notice' && /^The plan did not pass Limn's checks: The agent did not submit a plan\./.test(c.text))).toBe(true);

    // The reader's message is a revision turn; this time the gate allows ONE repair, which delivers.
    gateAllows = true;
    answers.push('Still thinking.', withBlock('Fixed.', PLAN()));
    expect((await post(`/api/story-builds/${id}/messages`, { text: 'Please send the plan block.' })).statusCode).toBe(202);
    const c = await until(id, (x) => x.session?.phase === 'plan_ready', 'plan after repair');
    expect(sentToClaude.at(-2)).toMatch(/^Please send the plan block\.\n\nEnd your answer with the plan in one ```limn-plan block/);
    expect(sentToClaude.at(-1)).toMatch(/^Limn could not use your plan\. Fix these problems:/);
    expect(c.session!.plan!.latest!.source).toBe('repair');
    expect(c.session!.plan!.revisions).toBe(1);
  });

  it('an idle close in the plan stage keeps the plan: plan_ready, resumable; Resume sends no turn', async () => {
    const id = (await rowOf((await (await get(`/api/story-builds?ident=${encodeURIComponent(IDENT2)}`)).json()).build.id)).id;
    await M._idleCloseForTest(id);
    const closed = await read(id);
    expect(closed.session).toMatchObject({ phase: 'plan_ready', live: false, resumable: true });
    expect(closed.session!.plan!.revisions).toBe(1);
    const sentBefore = sentToClaude.length;
    expect((await post(`/api/story-builds/${id}/resume`)).statusCode).toBe(202);
    const b = await until(id, (x) => x.session?.live === true && x.session.phase === 'plan_ready', 'resumed');
    expect(sentToClaude.length).toBe(sentBefore);
    expect(b.session!.mode).toBe('chat');
    const planMd = fake.files(`limn-${(await rowOf(id)).sandboxRef}-sandbox`).get('/workspace/PLAN.md');
    expect(String(planMd)).toMatch(/has NOT approved this plan yet/);
    // Approve on a closed session: "Resume the session first."
    await M._idleCloseForTest(id);
    const r = await post(`/api/story-builds/${id}/plan/approve`, { revision: 1 });
    expect(r.json()).toEqual({ error: 'NotLive', message: 'Resume the session first.' });
  });

  it('the restart reconcile keeps a plan-stage session as plan_ready', async () => {
    const id = (await (await get(`/api/story-builds?ident=${encodeURIComponent(IDENT2)}`)).json()).build.id;
    const { eq } = await import('drizzle-orm');
    await db.update(schema.storyBuilds).set({ sessionPhase: 'revising', status: 'planning', sandboxRef: 'gone' }).where(eq(schema.storyBuilds.id, id)).execute();
    await M.reconcileSessionsOnStartup({ db, schema, log: { info() {}, warn() {} } } as never);
    const row = await rowOf(id);
    expect([row.sessionPhase, row.status, row.sandboxRef]).toEqual(['plan_ready', 'plan_ready', null]);
  });
});

describe('Implement with docs', () => {
  it('refuses the docs start when no document is built; otherwise copies the docs in read only and checks docs evidence', async () => {
    const IDENT3 = 'jira:https://acme.atlassian.net#ACME-402';
    docsBuilt = false;
    const no = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT3, docs: true });
    expect(no.statusCode).toBe(400);
    expect(no.json()).toEqual({ error: 'NoDocs', message: 'No reference documents are built for this workspace.' });

    // Free a slot: the earlier sessions close.
    await M._closeAllSessionsForTest();
    docsBuilt = true;
    const plan = PLAN();
    (plan.contentions as any[])[0].evidence.push({ kind: 'docs', link: 'billing/sections/01-refunds.md', quote: 'Refunds are allowed for 14 days after the order.' });
    answers.push(withBlock('With the handbook.', plan));
    const r = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT3, docs: true });
    expect(r.statusCode, r.body).toBe(202);
    const id = r.json().buildId;
    const b = await until(id, (x) => x.session?.phase === 'plan_ready', 'docs plan');
    expect(b.session!.boot.map((x) => [x.key, x.state, x.detail])).toContainEqual(['docs', 'done', '1 section']);
    expect(b.session!.conversation[0]).toMatchObject({ kind: 'reader', text: 'Plan with docs' });
    expect(sentToClaude.at(-1)).toContain('Read `/home/agent/.limn/docs/INDEX.md`, the sections that apply, and `/workspace/DOCS.md`.');
    expect(b.session!.plan!.withDocs).toBe(true);
    expect(b.session!.plan!.latest!.contentions[0]!.evidence.map((e) => e.kind)).toEqual(['code', 'docs']);
    expect(b.session!.plan!.latest!.contentions[0]!.evidence[1]).toMatchObject({ kind: 'docs', path: 'billing/sections/01-refunds.md', docTitle: 'Billing handbook', verdict: 'contradicts' });
    const files = fake.files(`limn-${(await rowOf(id)).sandboxRef}-sandbox`);
    expect(String(files.get('/home/agent/.limn/docs/billing/sections/01-refunds.md'))).toBe(SECTION);
    expect(String(files.get('/workspace/TICKET.md'))).toContain('Reference documents for this ticket are in `/home/agent/.limn/docs/` (read only).');
    expect(String(files.get('/workspace/DOCS.md'))).toMatch(/Limn has no current docs check for this ticket/);
    expect((await rowOf(id)).withDocs).toBe(true);
  });
});
