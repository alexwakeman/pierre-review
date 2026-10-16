// SEQUENCE DIAGRAMS over the REAL core client (a scratch SQLite). What is pinned:
//   1. ONE row per (account, kind, subject, fingerprint): a redraw at the same fingerprint rewrites
//      the row (outputs cleared); a new head is a new row.
//   2. The slot: a newer refused/failed run never hides the last good diagram, and `current` follows
//      the live fingerprint.
//   3. The daily cap counts review-started rows only, and not refusals.
//   4. Tenancy: another account's PR is a 404; its rows are invisible; a story ident with no members
//      in this account refuses with no run.
//   5. deleteRepo takes the PR's diagrams.
//
//   DATABASE_URL=<scratch> pnpm --filter @pierre-review/backend test diagrams/persist-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  persist.upsertQueuedDiagram(ctx, {
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
  it('one row per fingerprint; a redraw rewrites it', async () => {
    const id = await queue(1, prA, 'fp1');
    await persist.saveDiagramSuccess(ctx, 1, id, { title: 'T', caption: 'C', diagramType: 'sequenceDiagram', source: 'sequenceDiagram\n A->>B: x' }, { costUsd: 0.1 });
    const again = await queue(1, prA, 'fp1', 'manual');
    expect(again).toBe(id);
    const row = await persist.getDiagramRow(ctx, 1, id);
    expect(row).toMatchObject({ status: 'queued', trigger: 'manual', source: null, title: null, costUsd: null });
    expect(await persist.diagramExistsAt(ctx, 1, 'pr', String(prA), 'fp1')).toBe(true);
    expect(await persist.diagramExistsAt(ctx, 2, 'pr', String(prA), 'fp1')).toBe(false);
    expect(await persist.getDiagramRow(ctx, 2, id)).toBeNull();
    await persist.saveDiagramSuccess(ctx, 1, id, { title: 'T', caption: 'C', diagramType: 'sequenceDiagram', source: 'sequenceDiagram\n A->>B: x' }, {});
    const other = await queue(1, prA, 'fp2');
    expect(other).not.toBe(id);
  });

  it('the slot keeps the last good diagram under a newer refusal; current follows the fingerprint', async () => {
    const { slotFor } = await import('./routes.js');
    const latest = await persist.latestDiagram(ctx, 1, 'pr', String(prA));
    await persist.markDiagramRefused(ctx, 1, latest!.id, 'head_moved');
    const slot = await slotFor(ctx, 1, 'pr', String(prA), 'fp2');
    expect(slot.diagram).toMatchObject({ status: 'succeeded', current: false, source: 'sequenceDiagram\n A->>B: x' });
    expect(slot.latest).toMatchObject({ status: 'refused', refusal: 'head_moved', current: true, source: null });
    const cur = await slotFor(ctx, 1, 'pr', String(prA), 'fp1');
    expect(cur.diagram?.current).toBe(true);
    expect((await slotFor(ctx, 2, 'pr', String(prA), 'fp1')).diagram).toBeNull();
  });

  it('the daily cap counts review-started, non-refused rows', async () => {
    // fp1 (now manual) and fp2 (review, refused) ⇒ nothing counts yet.
    expect(await persist.countReviewDiagramsSince(ctx, 1, 0)).toBe(0);
    await queue(1, prA, 'fp3');
    expect(await persist.countReviewDiagramsSince(ctx, 1, 0)).toBe(1);
    expect(await persist.countReviewDiagramsSince(ctx, 1, Date.now() + 60_000)).toBe(0);
    expect(await persist.countReviewDiagramsSince(ctx, 2, 0)).toBe(0);
  });

  it('a restart fails what it orphaned', async () => {
    expect(await persist.reconcileOrphanedDiagrams(ctx)).toBeGreaterThanOrEqual(1);
    const latest = await persist.latestDiagram(ctx, 1, 'pr', String(prA));
    expect(latest?.status).toBe('failed');
  });
});

describe('routes', () => {
  it("GET answers this account's PR, and 404s another account's", async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/prs/${prA}/sequence-diagrams` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ prId: prA, stories: [] });
    expect(ok.json().pr.diagram.source).toContain('sequenceDiagram');
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
  it('deleteRepo takes the PR diagrams', async () => {
    const q = await import('../../db/queries.js');
    expect(await q.deleteRepo(repoA, 1)).toBe(true);
    const rows = await db.select().from(schema.sequenceDiagrams).execute();
    expect(rows.filter((r: any) => r.prId === prA)).toEqual([]);
  });
});
