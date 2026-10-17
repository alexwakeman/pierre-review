// SEQUENCE DIAGRAMS over the REAL core client (a scratch SQLite). What is pinned:
//   1. ONE row per RUN: a redraw at the same fingerprint is a new row, so the good diagram stays
//      shown while it runs and after it fails.
//   2. The slot: a newer refused/failed run never hides the last good diagram, and `current` follows
//      the live fingerprint.
//   3. The daily cap counts review-started rows that ran the model (not the free refusals).
//   4. Tenancy: another account's PR is a 404; its rows are invisible; a story ident with no members
//      in this account refuses with no run.
//   5. deleteRepo takes the PR's diagrams and the story diagrams naming its PRs.
//
//   DATABASE_URL=<scratch> pnpm --filter @pierre-review/backend test diagrams/persist-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-diagrams'}.diagrams-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let app: FastifyInstance;
let ctx: any;
let persist: typeof import('./persist.js');
let repoA = 0;
let prA = 0;
let prB = 0;
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const DESIGN = {
  acts: [{ id: 'a1', title: 'Import' }],
  layers: ['domain' as const],
  cells: [
    { id: 'c1', act: 'a1', layer: 'domain' as const, label: 'Parse rows', pattern: 'Pipeline', change: 'new' as const, pr: null, files: ['src/a.ts'] },
  ],
  arrows: [],
};

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  for (const id of [1, 2]) {
    await db.insert(schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  const [ra] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_a' }).returning().execute();
  const [rb] = await db.insert(schema.repos).values({ accountId: 2, owner: 'acme', name: 'api', githubNodeId: 'R_a' }).returning().execute();
  repoA = ra.id;
  await q.ensureDefaultWorkspace(1);
  await q.ensureDefaultWorkspace(2);
  await q.ensureRepoMemberships(1);
  await q.ensureRepoMemberships(2);
  const pr = async (accountId: number, repoId: number, node: string, files: unknown) =>
    (
      await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: node,
          accountId,
          repoId,
          number: 7,
          title: 't',
          state: 'open',
          isDraft: false,
          headSha: HEAD,
          openedAt: new Date(),
          updatedAt: new Date(),
          files,
          additions: 3,
          deletions: 0,
          changedFiles: 1,
        })
        .returning()
        .execute()
    )[0].id;
  prA = await pr(1, repoA, 'PR_A', [{ path: 'README.md', additions: 3, deletions: 0 }]);
  prB = await pr(2, rb.id, 'PR_B', [{ path: 'src/a.ts', additions: 3, deletions: 0 }]);

  const ts = await import('../../tracker/ticket-source.js');
  ts._overrideTicketSourceForTest({ ticketsForPr: async () => [], ticketMembers: async () => [] });
  persist = await import('./persist.js');
  ctx = {
    db,
    schema,
    log: { info() {}, warn() {}, error() {} },
    accountIdOf: () => 1,
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    recordAiUsage: async () => {},
  };
  const Fastify = (await import('fastify')).default;
  const { registerSequenceDiagramRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerSequenceDiagramRoutes(app, ctx);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const queue = (accountId: number, prId: number, fingerprint: string, trigger: 'review' | 'manual' = 'review') =>
  persist.insertQueuedDiagram(ctx, {
    accountId,
    kind: 'pr',
    subject: String(prId),
    prId,
    ticketKey: null,
    fingerprint,
    headSha: fingerprint === 'fp2' ? HEAD2 : HEAD,
    members: null,
    trigger,
    model: 'claude-sonnet-5',
  });

describe('storage', () => {
  it('one row per run: a redraw at the same head never clears the good diagram, even when it fails', async () => {
    const { slotFor } = await import('./routes.js');
    const id = await queue(1, prA, 'fp1');
    await persist.saveDiagramSuccess(ctx, 1, id, { title: 'T', caption: 'C', design: DESIGN }, { costUsd: 0.1 });
    const again = await queue(1, prA, 'fp1', 'manual');
    expect(again).not.toBe(id);
    expect(await persist.getDiagramRow(ctx, 1, id)).toMatchObject({ status: 'succeeded', design: DESIGN, source: null, diagramType: 'design' });
    const drawing = await slotFor(ctx, 1, 'pr', String(prA), 'fp1');
    expect(drawing.diagram).toMatchObject({ id, status: 'succeeded', current: true, design: DESIGN });
    expect(drawing.latest).toMatchObject({ id: again, status: 'queued', trigger: 'manual', current: true });
    await persist.markDiagramFailed(ctx, 1, again, 'boom', { costUsd: 0.05 }, 'invalid_diagram');
    const failed = await slotFor(ctx, 1, 'pr', String(prA), 'fp1');
    expect(failed.diagram).toMatchObject({ id, design: DESIGN });
    expect(failed.latest).toMatchObject({ id: again, status: 'failed', refusal: 'invalid_diagram' });
    expect(await persist.diagramExistsAt(ctx, 1, 'pr', String(prA), 'fp1')).toBe(true);
    expect(await persist.diagramExistsAt(ctx, 2, 'pr', String(prA), 'fp1')).toBe(false);
    expect(await persist.getDiagramRow(ctx, 2, id)).toBeNull();
    const other = await queue(1, prA, 'fp2');
    expect(other).not.toBe(id);
  });

  it('the slot keeps the last good diagram under a newer refusal; current follows the fingerprint', async () => {
    const { slotFor } = await import('./routes.js');
    const latest = await persist.latestDiagram(ctx, 1, 'pr', String(prA));
    await persist.markDiagramRefused(ctx, 1, latest!.id, 'head_moved');
    const slot = await slotFor(ctx, 1, 'pr', String(prA), 'fp2');
    expect(slot.diagram).toMatchObject({ status: 'succeeded', current: false, design: DESIGN });
    expect(slot.latest).toMatchObject({ status: 'refused', refusal: 'head_moved', current: true, design: null });
    const cur = await slotFor(ctx, 1, 'pr', String(prA), 'fp1');
    expect(cur.diagram?.current).toBe(true);
    expect((await slotFor(ctx, 2, 'pr', String(prA), 'fp1')).diagram).toBeNull();
  });

  it('the daily cap counts review-started rows that ran the model, not the free refusals', async () => {
    // fp1 review (succeeded) counts; fp1 manual (failed) is a click; fp2 review refused head_moved is free.
    expect(await persist.countReviewDiagramsSince(ctx, 1, 0)).toBe(1);
    await queue(1, prA, 'fp3');
    expect(await persist.countReviewDiagramsSince(ctx, 1, 0)).toBe(2);
    // A billed run whose answer failed validation still counts.
    const bad = await queue(1, prA, 'fp4');
    await persist.markDiagramFailed(ctx, 1, bad, 'invalid', { costUsd: 0.2 }, 'invalid_diagram');
    expect(await persist.countReviewDiagramsSince(ctx, 1, 0)).toBe(3);
    const free = await queue(1, prA, 'fp5');
    await persist.markDiagramRefused(ctx, 1, free, 'no_code');
    expect(await persist.countReviewDiagramsSince(ctx, 1, 0)).toBe(3);
    expect(await persist.countReviewDiagramsSince(ctx, 1, Date.now() + 60_000)).toBe(0);
    expect(await persist.countReviewDiagramsSince(ctx, 2, 0)).toBe(0);
  });

  it('a Mermaid-era row (no design) is no diagram: the slot reads past it, both succeeded and failed', async () => {
    const { slotFor } = await import('./routes.js');
    // A PR with only a retired Mermaid diagram (and a later Mermaid-era failure) reads as nothing.
    const [legacy] = await db
      .insert(schema.sequenceDiagrams)
      .values([
        { accountId: 1, kind: 'pr', subject: '9999', prId: 9999, fingerprint: 'old', trigger: 'review', status: 'succeeded', model: 'm', diagramType: 'sequenceDiagram', source: 'sequenceDiagram\n A->>B: x', createdAt: new Date(Date.now() - 2000) },
        { accountId: 1, kind: 'pr', subject: '9999', prId: 9999, fingerprint: 'old', trigger: 'review', status: 'failed', model: 'm', error: 'x', createdAt: new Date(Date.now() - 1000) },
      ])
      .returning()
      .execute();
    expect(legacy.id).toBeGreaterThan(0);
    expect(await slotFor(ctx, 1, 'pr', '9999', 'new')).toEqual({ diagram: null, latest: null });
    expect(await persist.latestDiagram(ctx, 1, 'pr', '9999')).toBeNull();
    // A design-era run on the same subject shows, with the old rows still ignored beneath it.
    const id = await persist.insertQueuedDiagram(ctx, {
      accountId: 1, kind: 'pr', subject: '9999', prId: 9999, ticketKey: null, fingerprint: 'new', headSha: HEAD, members: null, trigger: 'manual', model: 'claude-sonnet-5',
    });
    const queued = await slotFor(ctx, 1, 'pr', '9999', 'new');
    expect(queued.diagram).toBeNull();
    expect(queued.latest).toMatchObject({ id, status: 'queued', design: null });
    await persist.saveDiagramSuccess(ctx, 1, id, { title: 'T', caption: null, design: DESIGN }, {});
    expect((await slotFor(ctx, 1, 'pr', '9999', 'new')).diagram).toMatchObject({ id, design: DESIGN, current: true });
    await db.delete(schema.sequenceDiagrams).where(eq(schema.sequenceDiagrams.subject, '9999')).execute();
  });

  it('a restart fails what it orphaned', async () => {
    expect(await persist.reconcileOrphanedDiagrams(ctx)).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(schema.sequenceDiagrams).execute();
    expect(rows.find((r: any) => r.fingerprint === 'fp3')?.status).toBe('failed');
    expect(rows.some((r: any) => r.status === 'queued' || r.status === 'running')).toBe(false);
    // A restart-killed run does not count as drawn, so the next review draws that head again …
    expect(await persist.diagramExistsAt(ctx, 1, 'pr', String(prA), 'fp3')).toBe(false);
    // … while a run that failed on its own still does (only a click redraws it).
    expect(await persist.diagramExistsAt(ctx, 1, 'pr', String(prA), 'fp4')).toBe(true);
  });
});

describe('routes', () => {
  it("GET answers this account's PR, and 404s another account's", async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/prs/${prA}/sequence-diagrams` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ prId: prA, stories: [] });
    expect(ok.json().pr.diagram.design).toEqual(DESIGN);
    expect(ok.json().pr.diagram).not.toHaveProperty('source');
    expect((await app.inject({ method: 'GET', url: `/api/prs/${prB}/sequence-diagrams` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/prs/${prB}/sequence-diagrams/redraw` })).statusCode).toBe(404);
  });

  it('a Redraw of a docs-only PR refuses no_code with no run', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/prs/${prA}/sequence-diagrams/redraw` });
    expect(r.json()).toEqual({ outcome: 'refused', diagramId: null, refusal: 'no_code' });
  });

  it('a story with no members here refuses too_few_prs; a pasted ident is a 400', async () => {
    const ident = 'jira:https://acme.atlassian.net#ABC-1';
    const get = await app.inject({ method: 'GET', url: `/api/sequence-diagrams/story?ident=${encodeURIComponent(ident)}` });
    expect(get.json()).toMatchObject({ ident, memberCount: 0, diagram: null, latest: null });
    const post = await app.inject({ method: 'POST', url: '/api/sequence-diagrams/story/redraw', payload: { ident } });
    expect(post.json()).toMatchObject({ outcome: 'refused', refusal: 'too_few_prs' });
    const bad = await app.inject({ method: 'POST', url: '/api/sequence-diagrams/story/redraw', payload: { ident: 'manual:1:abcdef12' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('delete paths', () => {
  it('deleteRepo takes the PR diagrams and every story diagram naming one of its PRs', async () => {
    const q = await import('../../db/queries.js');
    const member = (prId: number) => ({ prId, repo: 'acme/api', number: 7, title: 't', state: 'open', headSha: HEAD });
    const story = (accountId: number, subject: string, members: unknown[]) =>
      persist.insertQueuedDiagram(ctx, {
        accountId,
        kind: 'story',
        subject,
        prId: null,
        ticketKey: 'ABC-1',
        fingerprint: `sfp-${subject}`,
        headSha: null,
        members: members as any,
        trigger: 'review',
        model: 'claude-sonnet-5',
      });
    const named = await story(1, 'jira:https://acme.atlassian.net#ABC-1', [member(prA), member(999_001)]);
    const unrelated = await story(1, 'jira:https://acme.atlassian.net#ABC-2', [member(999_001), member(999_002)]);
    // Another account's story naming the same numeric id is not this account's to delete.
    const foreign = await story(2, 'jira:https://acme.atlassian.net#ABC-1', [member(prA), member(prB)]);
    expect(await q.deleteRepo(repoA, 1)).toBe(true);
    const rows = await db.select().from(schema.sequenceDiagrams).execute();
    expect(rows.filter((r: any) => r.prId === prA)).toEqual([]);
    const ids = rows.map((r: any) => r.id);
    expect(ids).not.toContain(named);
    expect(ids).toContain(unrelated);
    expect(ids).toContain(foreign);
  });
});
