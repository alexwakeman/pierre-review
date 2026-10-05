// AUTO CLAUDE REVIEW — THE PER-WORKSPACE SWITCH (core `workspaces.auto_review_enabled[_at]`,
// migration 0074). Moved from the plugin's pro_workspace_settings with Claude Review; these cases
// moved with it (packages/pro/test/workspace-settings.test.ts §7). What is pinned:
//
//   1. OFF until someone switches it on — a fresh workspace reads off with no floor.
//   2. ⚠ THE FLOOR MOVES ONLY ON AN OFF → ON FLIP. Re-saving "on" keeps it (or every PR opened in
//      between would be skipped); off clears it, and the next on stamps a new one.
//   3. Another account's workspace id is refused (→ 404) and not written.
//   4. The sweeper's roster lists only switched-on workspaces, each with its own account.
//   5. The routes: GET/PUT shape, an empty body refused, 404 for a foreign id.
//   6. AUTO AI FIX (`auto_fix_enabled`, migration 0083): ON by default, switched on its own (a body
//      with only `autoFixEnabled` leaves auto review and its floor alone), survives an auto-review
//      off → on, and `readWorkspaceAutoFixForPr` reads it through the PR's repo membership.
//
//   pnpm --filter @pierre-review/backend test auto-settings
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-auto-review-settings.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let s: typeof import('./auto-settings.js');
let wsA = 0;
let wsA2 = 0;
let wsB = 0;

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await client.db
    .insert(client.schema.accounts)
    .values({ id: 2, githubUserId: 'U_auto_other', githubLogin: 'other', isLocal: false })
    .execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  const [extra] = await client.db
    .insert(client.schema.workspaces)
    .values({ accountId: 1, name: 'Platform', isDefault: false })
    .returning()
    .execute();
  wsA2 = extra!.id;
  ctx = {
    db: client.db,
    schema: client.schema,
    isPg: false,
    accountIdOf: () => 1,
    log: { warn: () => {}, info: () => {}, error: () => {} },
  } as any as AgentContext;
  s = await import('./auto-settings.js');
});

afterAll(() => {
  closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

describe('the switch and its floor', () => {
  it('reads OFF on a fresh workspace, with the daily cap', async () => {
    expect(await s.readWorkspaceAutoReview(ctx, 1, wsA)).toEqual({
      enabled: false,
      enabledAt: null,
      dailyCap: s.AUTO_REVIEW_DAILY_CAP,
      autoFixEnabled: true,
    });
  });

  it('off → on stamps the floor; on → on keeps it; off clears it; on again re-stamps', async () => {
    const T1 = Date.UTC(2026, 8, 1);
    const T2 = Date.UTC(2026, 8, 2);
    const on = await s.setWorkspaceAutoReview(ctx, 1, wsA, { enabled: true }, T1);
    expect(on).toMatchObject({ enabled: true, enabledAt: new Date(T1).toISOString() });
    const again = await s.setWorkspaceAutoReview(ctx, 1, wsA, { enabled: true }, T2);
    expect(again?.enabledAt).toBe(new Date(T1).toISOString());
    expect((await s.readWorkspaceAutoReview(ctx, 1, wsA))?.enabledAt).toBe(new Date(T1).toISOString());
    const off = await s.setWorkspaceAutoReview(ctx, 1, wsA, { enabled: false }, T2);
    expect(off).toMatchObject({ enabled: false, enabledAt: null });
    const reOn = await s.setWorkspaceAutoReview(ctx, 1, wsA, { enabled: true }, T2);
    expect(reOn?.enabledAt).toBe(new Date(T2).toISOString());
  });

  it("⚠ another account's workspace is refused and NOT written", async () => {
    expect(await s.setWorkspaceAutoReview(ctx, 1, wsB, { enabled: true })).toBeNull();
    expect(await s.readWorkspaceAutoReview(ctx, 1, wsB)).toBeNull();
    expect((await s.readWorkspaceAutoReview(ctx, 2, wsB))?.enabled).toBe(false);
  });

  it('the roster lists only switched-on workspaces, each with its own account', async () => {
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: false });
    const roster = await s.listAutoReviewWorkspaces(ctx);
    expect(roster.map((r) => [r.accountId, r.workspaceId])).toEqual([[1, wsA]]);
    expect(roster[0]!.enabledAtMs).toBeGreaterThan(0);
  });
});

describe('auto AI Fix — the second switch', () => {
  it('ON by default; switched alone it leaves auto review and its floor untouched', async () => {
    const T1 = Date.UTC(2026, 8, 3);
    const on = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: true }, T1);
    expect(on?.autoFixEnabled).toBe(true);
    const fixOff = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: false }, T1 + 86_400_000);
    expect(fixOff).toMatchObject({
      enabled: true,
      enabledAt: new Date(T1).toISOString(),
      autoFixEnabled: false,
    });
    expect(await s.readWorkspaceAutoReview(ctx, 1, wsA2)).toEqual(fixOff);
  });

  it('survives auto review off → on (stored independently)', async () => {
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: false });
    const reOn = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: true });
    expect(reOn?.autoFixEnabled).toBe(false);
    const back = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: true });
    expect(back?.autoFixEnabled).toBe(true);
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: false });
  });

  it('readWorkspaceAutoFixForPr follows the PR repo’s workspace; no membership ⇒ the default, on', async () => {
    const client = await import('../../db/client.js');
    const ins = async (node: string) =>
      (
        await client.db
          .insert(client.schema.repos)
          .values({ accountId: 1, owner: 'acme', name: node, githubNodeId: `R_${node}` })
          .returning()
          .execute()
      )[0]!.id;
    const pr = async (repoId: number, node: string) =>
      (
        await client.db
          .insert(client.schema.pullRequests)
          .values({
            githubNodeId: `PR_${node}`,
            accountId: 1,
            repoId,
            number: 1,
            title: 't',
            state: 'open',
            isDraft: false,
            openedAt: new Date(),
            updatedAt: new Date(),
          })
          .returning()
          .execute()
      )[0]!.id;
    const inWs = await ins('fixws');
    const loose = await ins('loose');
    await client.db
      .insert(client.schema.workspaceRepos)
      .values({ accountId: 1, workspaceId: wsA2, repoId: inWs })
      .execute();
    const prIn = await pr(inWs, 'fixws');
    const prLoose = await pr(loose, 'loose');
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: false });
    expect(await s.readWorkspaceAutoFixForPr(ctx, 1, prIn)).toBe(false);
    expect(await s.readWorkspaceAutoFixForPr(ctx, 1, prLoose)).toBe(true);
    // Another account cannot read through this PR.
    expect(await s.readWorkspaceAutoFixForPr(ctx, 2, prIn)).toBe(true);
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: true });
    expect(await s.readWorkspaceAutoFixForPr(ctx, 1, prIn)).toBe(true);
  });
});

describe('GET / PUT /api/workspaces/:id/auto-review', () => {
  const build = async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });
    s.registerAutoReviewSettingsRoutes(app, ctx);
    await app.ready();
    return app;
  };

  it('PUT switches it and both answer the same shape', async () => {
    const app = await build();
    const put = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${wsA2}/auto-review`,
      payload: { enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ workspaceId: wsA2, autoReview: { enabled: true } });
    const get = await app.inject({ method: 'GET', url: `/api/workspaces/${wsA2}/auto-review` });
    expect(get.json()).toEqual(put.json());
  });

  it('autoFixEnabled round-trips through PUT and GET', async () => {
    const app = await build();
    const put = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${wsA2}/auto-review`,
      payload: { autoFixEnabled: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ workspaceId: wsA2, autoReview: { enabled: true, autoFixEnabled: false } });
    const get = await app.inject({ method: 'GET', url: `/api/workspaces/${wsA2}/auto-review` });
    expect(get.json()).toEqual(put.json());
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${wsA2}/auto-review`,
      payload: { autoFixEnabled: 'no' },
    });
    expect(bad.statusCode).toBe(400);
    await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${wsA2}/auto-review`,
      payload: { autoFixEnabled: true },
    });
  });

  it('an empty body is refused, not read as a switch', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/workspaces/${wsA2}/auto-review`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("another account's workspace answers 404 on both verbs", async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${wsB}/auto-review` })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/workspaces/${wsB}/auto-review`,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});
