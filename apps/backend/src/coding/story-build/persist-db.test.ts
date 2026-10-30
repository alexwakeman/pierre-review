// "IMPLEMENT STORY" STORAGE over the REAL core client (a scratch SQLite, migrations applied). Pinned:
//   1. THE CLAIM: one open session per ticket (the partial unique index in 0149) — a second insert answers
//      `already_open` with the first id; a closed (discarded) session frees the ticket for a new one.
//   2. TENANCY: every getter/updater scoped by account (another account reads null, writes nothing); the
//      composite FKs refuse a cross-account workspace or repository id.
//   3. THE WIRE: `toStoryBuild` never carries the patch, the frozen seed or a worktree path; repos come in
//      build order; docs decisions are the stored ones over the defaults; `pushedAll` is derived.
//   4. deleteRepo takes the repository's build rows but leaves the session.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.DATABASE_URL ?? '/tmp/pierre-storybuild'}.storybuild-persist.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let P: typeof import('./persist.js');
let deleteRepo: (id: number, accountId: number) => Promise<boolean>;
const ws: Record<number, number> = {};
const repo: Record<number, number[]> = {};
const IDENT = 'jira:https://acme.atlassian.net#ACME-214';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../../db/queries.js');
  ({ deleteRepo } = await import('../../db/queries.js'));
  for (const acct of [1, 2]) {
    await db
      .insert(schema.accounts)
      .values({ id: acct, githubUserId: `N${acct}`, githubLogin: `u${acct}`, isLocal: acct === 1 })
      .onConflictDoNothing()
      .execute();
    ws[acct] = await ensureDefaultWorkspace(acct);
    repo[acct] = [];
    for (const name of ['web', 'api']) {
      const [r] = await db
        .insert(schema.repos)
        .values({ accountId: acct, githubNodeId: `R${acct}${name}`, owner: 'acme', name: `${name}${acct}` })
        .returning()
        .execute();
      repo[acct]!.push(r.id);
    }
  }
  ctx = { db, schema };
  P = await import('./persist.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const start = (acct = 1) =>
  P.insertStoryBuild(ctx, {
    accountId: acct,
    workspaceId: ws[acct]!,
    ident: IDENT,
    ticketKey: 'ACME-214',
    ticketTitle: 'Refunds by card',
    wantDiagram: true,
    wantDocs: false,
    provider: 'claude',
    model: 'claude-opus-5-5',
  });

describe('story build storage', () => {
  let buildId = 0;

  it('claims ONE open session per ticket', async () => {
    const first = await start();
    expect(first.outcome).toBe('started');
    buildId = first.id;
    expect(await start()).toEqual({ outcome: 'already_open', id: buildId });
    // Another account's same ident is its own ticket.
    expect((await start(2)).outcome).toBe('started');
  });

  it('scopes every read and write to the account', async () => {
    expect(await P.getStoryBuildRow(ctx, 2, buildId)).toBeNull();
    expect(await P.updateStoryBuild(ctx, 2, buildId, { status: 'failed' })).toBe(false);
    expect((await P.getStoryBuildRow(ctx, 1, buildId))?.status).toBe('assessing');
  });

  it('refuses a cross-account repository through the composite FK', async () => {
    await expect(
      P.upsertStoryBuildRepo(ctx, {
        accountId: 1,
        buildId,
        repoId: repo[2]![0]!,
        ref: 'R1',
        buildOrder: 0,
        include: true,
        status: 'planned',
        baseRef: 'main',
        baseSha: 'a'.repeat(40),
        stackedOnPrId: null,
        branch: null,
      }),
    ).rejects.toThrow();
  });

  it('maps a session to the wire without the patch, the seed or a worktree path', async () => {
    const [web, api] = repo[1]!;
    const common = { accountId: 1, buildId, include: true, baseRef: 'main', baseSha: 'b'.repeat(40), stackedOnPrId: null, branch: 'acme-214-refunds' };
    const apiRow = await P.upsertStoryBuildRepo(ctx, { ...common, repoId: api!, ref: 'R2', buildOrder: 0, status: 'planned' });
    const webRow = await P.upsertStoryBuildRepo(ctx, { ...common, repoId: web!, ref: 'R1', buildOrder: 1, status: 'planned' });
    await P.updateStoryBuildRepo(ctx, 1, apiRow, { status: 'pushed', patch: 'diff --git a/a b/a', worktreePath: '/tmp/secret-wt', costUsd: 2 });
    await P.updateStoryBuildRepo(ctx, 1, webRow, { status: 'ready', patch: 'diff --git a/b b/b', costUsd: 3 });
    await P.updateStoryBuild(ctx, 1, buildId, {
      status: 'ready',
      planCostUsd: 1,
      seedJson: { version: 1, story: { key: 'ACME-214', title: 't', text: 'seed-text', url: null }, criteria: [], comments: null, cards: [] },
      docsJson: {
        summary: 's',
        nothingGrounded: false,
        planRevision: 1,
        items: [
          { id: 'D1', kind: 'suggestion', about: 'AC1', note: 'n', suggestion: 'x', refs: [] },
          { id: 'D2', kind: 'superseded', about: 'story', note: 'n', suggestion: null, refs: [] },
          { id: 'D3', kind: 'grounded', about: 'AC2', note: 'n', suggestion: null, refs: [] },
        ],
      },
      docsDecisionsJson: { D2: 'include' },
    });
    const row = (await P.getStoryBuildRow(ctx, 1, buildId))!;
    const rows = await P.listStoryBuildRepoRows(ctx, 1, buildId);
    const wire = P.toStoryBuild(row, rows, { repoNames: await P.storyBuildRepoNames(ctx, 1, rows.map((r) => r.repoId)), sessionBudgetUsd: 30 });
    const text = JSON.stringify(wire);
    expect(text).not.toContain('diff --git');
    expect(text).not.toContain('seed-text');
    expect(text).not.toContain('secret-wt');
    expect(wire.repos.map((r) => [r.ref, r.fullName, r.hasPatch])).toEqual([
      ['R2', 'acme/api1', true],
      ['R1', 'acme/web1', true],
    ]);
    expect(wire.docsDecisions).toEqual({ D1: 'include', D2: 'include' });
    expect(wire.totalCostUsd).toBe(6);
    expect(wire.pushedAll).toBe(false);
    expect(wire.provider).toBe('claude');
    expect(wire.phase).toBeNull();
    expect(await P.getStoryBuildRepoPatch(ctx, 2, buildId, web!)).toBeNull();
    expect((await P.getStoryBuildRepoPatch(ctx, 1, buildId, web!))?.patch).toBe('diff --git a/b b/b');
  });

  it('frees the ticket once the open session closes', async () => {
    await P.updateStoryBuild(ctx, 1, buildId, { status: 'discarded' });
    const next = await start();
    expect(next.outcome).toBe('started');
    expect(next.id).not.toBe(buildId);
    const history = await P.listStoryBuildRowsFor(ctx, 1, ws[1]!, IDENT);
    expect(history.map((r) => r.id)).toEqual([next.id, buildId]);
  });

  it('deleteRepo takes the repository rows and keeps the session', async () => {
    const [web] = repo[1]!;
    expect(await deleteRepo(web!, 1)).toBe(true);
    const rows = await P.listStoryBuildRepoRows(ctx, 1, buildId);
    expect(rows.map((r) => r.ref)).toEqual(['R2']);
    expect(await P.getStoryBuildRow(ctx, 1, buildId)).not.toBeNull();
  });
});
