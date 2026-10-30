// "IMPLEMENT STORY" — THE WHOLE FLOW, END TO END, over the REAL core client (a scratch SQLite), the REAL
// routes (session + docs + build-side), the REAL manager, the REAL docs run and the REAL push. Only the
// edges are fakes: the plan agent and the docs read (fake providers), the per-repository build (it needs a
// clone and a model), git's push + PR (`applyAndPushBranch`), the tracker link and GitHub's file read.
//
//   start → assess → plan → chat re-plan → docs run → decisions → re-plan with the docs → checks
//   preview → accept → build per repository (plan order, frozen docs, the earlier repo given to the later
//   one) → diff → retry through the manager's lane → push all (drafts, plan order, sibling links) →
//   discard.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { storyBuildDocsPending } from '@pierre-review/shared';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild`}.storybuild-e2e.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = vi.hoisted(() => ({ pushes: [] as any[], links: [] as any[], released: [] as string[], nextPr: 500, sync: null as null | ((name: string, n: number) => Promise<void>) }));

vi.mock('../git-ops.js', () => ({
  applyAndPushBranch: async (a: any) => {
    G.pushes.push(a);
    const n = G.nextPr++;
    // The new PR syncs (its row lands), then the push's after-sync step links the ticket.
    await G.sync?.(a.name, n);
    await a.afterSync?.(n);
    return { pushedBranch: a.branch, commitSha: `c${n}`, prNumber: n, prUrl: `https://github.com/${a.owner}/${a.name}/pull/${n}` };
  },
}));
vi.mock('../../tracker/manual-links.js', () => ({
  resolveTicketRefs: async (_ctx: unknown, accountId: number, prId: number, body: unknown) => {
    G.links.push({ accountId, prId, body });
    return { ok: true, body: { prId, provider: 'jira', results: [] } };
  },
}));
vi.mock('../../tracker/runtime.js', () => ({ trackerContext: () => ({}) }));
vi.mock('../../review/clone-manager.js', () => ({
  removeWorktreeLocked: async (_o: string, _n: string, _dir: string, wt: string) => {
    G.released.push(wt);
  },
  prepBranchWorktree: async () => {
    throw new Error('no checkout in this test');
  },
  scrubGitError: (e: unknown) => String(e),
}));

const IDENT = 'jira:https://acme.atlassian.net#ACME-300';

let app: FastifyInstance;
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let docsDir: string;
let M: typeof import('./manager.js');
let P: typeof import('./persist.js');
let D: typeof import('./docs.js');
let R: typeof import('./docs-runner.js');
let S: typeof import('./seams.js');
let wsId = 0;
let web = 0;
let api = 0;
const usage: any[] = [];
const planCalls: any[] = [];
const docsCalls: any[] = [];
const buildCalls: any[] = [];
const scratch: string[] = [];

const plan = (reply: string | null) => ({
  summary: 'The API gains a CSV export. The web app adds a Download button.',
  repos: [
    { ref: 'R1', why: 'The endpoint lives here.', branchSlug: 'csv-api', steps: [{ title: 'Add GET /export.csv', files: ['src/export.ts'], change: 'Stream rows.', refs: ['AC1'] }], tests: [] },
    { ref: 'R2', why: 'The button lives here.', branchSlug: 'csv-web', steps: [{ title: 'Download button', files: ['web/Report.tsx'], change: 'Link to it.', refs: ['AC2'] }], tests: [] },
  ],
  readOnlyRepos: [],
  criteria: [
    { ref: 'AC1', how: 'planned', repo: 'R1' },
    { ref: 'AC2', how: 'planned', repo: 'R2' },
  ],
  risks: [],
  reply,
});

const DOCS_PAYLOAD = {
  summary: 'The plan follows the export guide. The story asks for a wider file than the guide allows.',
  items: [
    { kind: 'superseded', about: 'AC1', note: 'The guide caps exports at 10,000 rows; the story streams them all.', refs: [{ link: 'exports/sections/01-exports.md', quote: 'Exports are capped at ten thousand rows' }] },
    { kind: 'suggestion', about: 'AC2', note: 'The guide names every download.', suggestion: 'Name the file after the report and the date.', refs: [{ link: 'exports/sections/01-exports.md', quote: 'Every download is named after its report' }] },
    { kind: 'grounded', about: 'story', note: 'Exports are CSV.', refs: [{ link: 'exports/sections/01-exports.md', quote: 'Every export is a CSV file' }] },
  ],
};

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  docsDir = mkdtempSync(join(tmpdir(), 'limn-storybuild-e2e-'));
  (await import('../../reference-docs/paths.js')).setDocsRootForTest(docsDir);
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  wsId = await q.ensureDefaultWorkspace(1);
  for (const name of ['web', 'api']) {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId: 1, githubNodeId: `R-${name}`, owner: 'acme', name, defaultBranch: 'main', viewerPermission: 'WRITE' })
      .returning()
      .execute();
    if (name === 'web') web = r.id;
    else api = r.id;
  }
  await q.resolveWorkspaceScope(1, null);
  G.sync = async (name, n) => {
    await db
      .insert(schema.pullRequests)
      .values({ accountId: 1, repoId: name === 'web' ? web : api, githubNodeId: `PR${n}`, number: n, title: 'x', state: 'open', openedAt: new Date(), updatedAt: new Date() })
      .execute();
  };

  // A built reference doc in the workspace's library (the docs run reads it for real).
  const lib = join(docsDir, '1', String(wsId), 'library', 'exports');
  mkdirSync(join(lib, 'sections'), { recursive: true });
  writeFileSync(join(lib, 'CONTENTS.md'), '# Export guide\n- [Exports](sections/01-exports.md)\n');
  writeFileSync(
    join(lib, 'sections', '01-exports.md'),
    '# Exports\n\nEvery export is a CSV file. Exports are capped at ten thousand rows. Every download is named after its report and the day it was made.\n',
  );
  await db
    .insert(schema.referenceDocs)
    .values({
      accountId: 1,
      workspaceId: wsId,
      slug: 'exports',
      title: 'Export guide',
      sourceKind: 'markdown',
      sourceName: 'exports.md',
      status: 'ready',
      progress: 100,
      sectionCount: 1,
      sections: [{ path: 'exports/sections/01-exports.md', title: 'Exports', summary: 'CSV exports', depth: 1, trail: [], headings: [], words: 26 }],
      builtAt: new Date(1_700_000_000_000),
    })
    .execute();

  M = await import('./manager.js');
  P = await import('./persist.js');
  D = await import('./docs.js');
  R = await import('./docs-runner.js');
  S = await import('./seams.js');

  // THE FAKE PROVIDERS: the plan agent and the docs read.
  M._setStoryBuildSeamsForTest({
    inputs: {
      story: {
        latestTicketReview: async () => null,
        ticketReviewTicket: async () => null,
        trackerStory: async () => ({ title: 'Export a report as CSV', description: 'Customers download any report as a CSV file.', acceptanceCriteria: '' }),
        trackerComments: async () => [],
        sprintStory: async () =>
          ({
            workspaceId: wsId,
            ident: IDENT,
            found: true,
            ticket: null,
            briefState: 'current',
            brief: { summary: 's', criteria: [{ n: 1, text: 'Stream every row' }, { n: 2, text: 'A Download CSV button' }], criteriaDerived: false, references: [], createdAt: '2026-10-01T00:00:00Z' },
            story: null,
          }) as any,
      },
      ticketPrIds: async () => [],
      ticketPrs: async () => [],
      cards: async () => [],
      url: async () => 'https://acme.atlassian.net/browse/ACME-300',
    },
    checkOut: async (a) => ({
      checkouts: a.candidates.map((c) => {
        const d = mkdtempSync(join(tmpdir(), 'sb-e2e-co-'));
        scratch.push(d);
        return { candidate: c, path: d, sha: `sha${c.repoId}`.padEnd(40, '0'), error: null };
      }),
      cleanup: async () => {},
    }),
    runPlanAgent: async (args) => {
      planCalls.push(args);
      const steered = /STEERING/.test(args.prompt);
      return { plan: plan(steered ? 'Done.' : null), designDropped: false, lastRefusal: null, aborted: false, costUsd: 0.5, inputTokens: 1000, outputTokens: 100, numTurns: 5, model: 'claude-opus-5-5', ledgerByProvider: false };
    },
    library: async () => null,
  });
  D._setBuildDocsSeamsForTest({
    complete: async () => {
      throw new Error('the whole library fits: no shortlist call');
    },
    runAgent: async (args: any) => {
      docsCalls.push(args);
      return { payload: DOCS_PAYLOAD, lastRefusal: null, aborted: false, costUsd: 0.2, inputTokens: 500, outputTokens: 50, numTurns: 2 };
    },
  });
  // The per-repository build (needs a clone + a model): a fake that keeps a worktree path and a patch.
  S.setStoryBuildDepsForTests({
    buildRepo: async (_ctx, a) => {
      buildCalls.push({ repoId: a.repo.repoId, earlier: a.earlier.map((e) => [e.repo.repoId, e.worktreePath]), checks: a.repo.checksWantedJson, docs: a.docs, nonce: a.nonce, branch: a.repo.branch });
      a.onProgress({ phase: 'building' });
      a.onProgress({ phase: 'running_checks' });
      return {
        ok: true,
        error: null,
        worktreePath: `/clones/acme__${a.fullName.split('/')[1]}/.worktrees/sb-${a.repo.id}-${buildCalls.length}`,
        patch: `diff --git a/f${a.repo.repoId}.ts b/f${a.repo.repoId}.ts\n+export const x = ${buildCalls.length};\n`,
        filesChanged: [`f${a.repo.repoId}.ts`],
        summary: `Built ${a.fullName}.`,
        commitMessage: 'feat: CSV export',
        changeReport: { changes: [{ path: `f${a.repo.repoId}.ts`, summary: 'x', refs: a.repo.ref === 'R1' ? ['AC1'] : ['AC2'] }], unaddressed: [], notReported: [] },
        checks: { ran: ['test'], passed: ['test'], failed: [], note: null } as any,
        provider: 'claude',
        model: 'claude-opus-5-5',
        effort: 'medium',
        costUsd: 1,
        inputTokens: 10,
        outputTokens: 5,
        numTurns: 3,
      };
    },
  });
  ctx = {
    db,
    schema,
    log: { info() {}, warn() {}, error() {} },
    accountIdOf: () => 1,
    llm: { detectAuth: () => ({ status: 'ok' }), detectProviderAuth: () => ({ status: 'ok' }) },
    recordAiUsage: async (row: any) => {
      usage.push(row);
    },
    github: { fetchRepoFiles: async () => ({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }) },
  };
  const Fastify = (await import('fastify')).default;
  const { registerStoryBuildRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerStoryBuildRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  M?._setStoryBuildSeamsForTest(null);
  D?._setBuildDocsSeamsForTest(null);
  S?.setStoryBuildDepsForTests(null);
  S?.registerStoryBuildLane(null);
  await app?.close();
  await closeDb?.();
  rmSync(docsDir, { recursive: true, force: true });
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const post = (url: string, payload: any = {}) => app.inject({ method: 'POST', url, payload });
const put = (url: string, payload: any) => app.inject({ method: 'PUT', url, payload });
const get = (url: string) => app.inject({ method: 'GET', url });
const idle = async (): Promise<void> => {
  await M._storyBuildIdleForTest();
  await R._storyBuildDocsIdleForTest();
};

describe('Implement story, end to end', () => {
  let id = 0;

  it('start → assess → plan: plan_ready with both repositories planned', async () => {
    const r = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT, docs: false, diagram: false });
    expect(r.statusCode).toBe(202);
    id = r.json().buildId;
    await idle();
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b).toMatchObject({ status: 'plan_ready', planRevision: 1, ticketKey: 'ACME-300', error: null });
    expect(b.repos.map((x: any) => [x.ref, x.status])).toEqual([
      ['R1', 'planned'],
      ['R2', 'planned'],
    ]);
    expect(planCalls).toHaveLength(1);
  });

  it('chat re-plans: revision 2, the reply in the transcript', async () => {
    expect((await post(`/api/story-builds/${id}/plan/message`, { text: 'Stream the rows.' })).statusCode).toBe(202);
    await idle();
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b.planRevision).toBe(2);
    expect(b.transcript.map((m: any) => m.role)).toEqual(['reader', 'claude']);
  });

  it('docs: a real run over the library stores the points with the default decisions', async () => {
    const r = await post(`/api/story-builds/${id}/docs`, {});
    expect(r.statusCode).toBe(202);
    // A re-plan waits while the docs run holds the session.
    await idle();
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b).toMatchObject({ docsStatus: 'ready', docsError: null });
    expect(b.docs.items.map((i: any) => [i.id, i.kind])).toEqual([
      ['D1', 'superseded'],
      ['D2', 'suggestion'],
      ['D3', 'grounded'],
    ]);
    expect(b.docsDecisions).toEqual({ D1: 'ignore', D2: 'include' });
    expect(docsCalls).toHaveLength(1);
    // Nothing decided since the docs were weighed, but the plan was made before them: D2 is pending.
    expect(storyBuildDocsPending(b.docs, b.docsDecisions)).toBe(1);
  });

  it('decisions, then a re-plan WITH the docs points (fenced): nothing pending after it', async () => {
    const shown = (await get(`/api/story-builds/${id}`)).json().docs;
    const d = await put(`/api/story-builds/${id}/docs/decisions`, { decisions: { D1: 'include' }, planRevision: shown.planRevision, runId: shown.runId });
    expect(d.json()).toEqual({ decisions: { D1: 'include', D2: 'include' } });
    expect((await post(`/api/story-builds/${id}/plan/message`, { text: 'Use the docs.' })).statusCode).toBe(202);
    await idle();
    const last = planCalls.at(-1);
    expect(last.prompt).toMatch(/---BEGIN DOCS POINTS THE READER INCLUDED [0-9a-f]+---/);
    expect(last.prompt).toContain('Name the file after the report and the date.');
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b.planRevision).toBe(3);
    expect(storyBuildDocsPending(b.docs, b.docsDecisions)).toBe(0);
  });

  it('the checks preview reads the project at its base', async () => {
    const r = await get(`/api/story-builds/${id}/repos/${api}/checks`);
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(r.json())).toContain('test');
  });

  it('accept → build per repository in plan order, frozen docs, the earlier repo given to the later', async () => {
    const r = await post(`/api/story-builds/${id}/accept`, {
      planRevision: 3,
      repos: [
        { repoId: api, include: true, branch: 'limn/acme-300-csv-api', checks: ['test'] },
        { repoId: web, include: true, branch: 'limn/acme-300-csv-web', checks: [] },
      ],
    });
    expect(r.statusCode).toBe(202);
    await idle();
    expect(buildCalls.map((c) => c.repoId)).toEqual([api, web]);
    expect(buildCalls[0].earlier).toEqual([]);
    expect(buildCalls[1].earlier).toEqual([[api, expect.stringMatching(/\.worktrees\/sb-/)]]);
    expect(buildCalls[0].checks).toEqual(['test']);
    // The frozen docs reach the build, fenced with the pass's own nonce.
    expect(buildCalls[0].docs.included).toContain(`---BEGIN DOCS POINTS THE READER INCLUDED ${buildCalls[0].nonce}---`);
    expect(buildCalls[0].docs.included).toContain('Name the file after the report and the date.');
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b).toMatchObject({ status: 'ready', acceptedRevision: 3, acceptedDocs: { D1: 'include', D2: 'include' } });
    expect(b.repos.map((x: any) => [x.repoId, x.status, x.hasPatch])).toEqual([
      [api, 'ready', true],
      [web, 'ready', true],
    ]);
    // Ledger: plan passes + the docs read here; the build's row is buildRepo's own (a fake writes none).
    expect(usage.map((u) => u.feature).sort()).toEqual(['story_build_docs', 'story_plan', 'story_plan', 'story_plan']);
    // Decisions are frozen now.
    expect((await put(`/api/story-builds/${id}/docs/decisions`, { decisions: { D1: 'ignore' }, planRevision: 0, runId: null })).statusCode).toBe(409);
  });

  it('the diff, then a retry through the manager lane (never 503)', async () => {
    const diff = (await get(`/api/story-builds/${id}/repos/${web}/diff`)).json();
    expect(diff.patch).toContain(`f${web}.ts`);
    const r = await post(`/api/story-builds/${id}/repos/${web}/retry`, {});
    expect(r.statusCode).toBe(202);
    await idle();
    expect(buildCalls).toHaveLength(3);
    expect(buildCalls[2]).toMatchObject({ repoId: web, earlier: [[api, expect.any(String)]] });
    expect((await get(`/api/story-builds/${id}`)).json().status).toBe('ready');
  });

  it('push all: drafts, in plan order, the later body linking the earlier PR, the ticket linked', async () => {
    const r = await post(`/api/story-builds/${id}/push`, { draft: true });
    expect(r.statusCode).toBe(200);
    const results = r.json().results;
    expect(results.map((x: any) => [x.repoId, x.outcome])).toEqual([
      [api, 'pushed'],
      [web, 'pushed'],
    ]);
    expect(G.pushes.map((p) => [p.name, p.branch, p.draft, p.title])).toEqual([
      ['api', 'limn/acme-300-csv-api', true, 'ACME-300: Export a report as CSV'],
      ['web', 'limn/acme-300-csv-web', true, 'ACME-300: Export a report as CSV'],
    ]);
    expect(G.pushes[1].body).toContain('acme/api#500');
    expect(G.links.map((l) => l.body)).toEqual([
      { refs: ['ACME-300'], link: true },
      { refs: ['ACME-300'], link: true },
    ]);
    const b = (await get(`/api/story-builds/${id}`)).json();
    expect(b.pushedAll).toBe(true);
    expect(b.repos.map((x: any) => x.status)).toEqual(['pushed', 'pushed']);
  });

  it('discard closes the session and frees the ticket', async () => {
    expect((await post(`/api/story-builds/${id}/discard`)).json()).toEqual({ status: 'discarded' });
    const again = await post('/api/story-builds', { workspaceId: wsId, ident: IDENT });
    expect(again.statusCode).toBe(202);
    expect(again.json().buildId).not.toBe(id);
    await idle();
  });
});
