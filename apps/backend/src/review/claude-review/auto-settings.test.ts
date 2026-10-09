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
//   6. AUTO AI FIX (`auto_fix_enabled`, migration 0083): OFF by default (0084), switched on its own (a body
//      with only `autoFixEnabled` leaves auto review and its floor alone), survives an auto-review
//      off → on, and `readWorkspaceAutoFixForPr` reads it through the PR's repo membership.
//   7. THE DAILY CAP (`auto_review_daily_cap`, migration 0085): NULL reads as the default 20, a set
//      value round-trips and reaches the sweeper's roster, 20 is stored as NULL (overrides only),
//      it is written alone without touching the switches, and the PUT 400s outside 1..500.
//
//   8. AUTO-POSTING (`auto_post_enabled` + `auto_post_settings`, migration 0087): OFF for an
//      existing workspace AND a new one; the defaults (scope 'mine'; blockers, warnings, questions
//      and story gaps on; nits and not-asked-for off); overrides-only storage; a partial kinds write
//      keeps the rest; written alone without touching the other switches; route validation.
//
//   9. AUTO VERDICT / AUTO RESOLVE (inside `auto_post_settings`) and AUTO FIX SETTINGS
//      (`auto_fix_settings`, migration 0091): OFF / the defaults, overrides only, written alone,
//      validated at the route; GET carries `usage` only while auto review is on.
//
//   pnpm --filter @pierre-review/backend test auto-settings
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AUTO_FIX_DEFAULT_INCLUDE, AUTO_POST_DEFAULT_KINDS } from '@pierre-review/shared';
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
      autoFixEnabled: false,
      autoPost: { enabled: false, scope: 'mine', kinds: AUTO_POST_DEFAULT_KINDS, autoVerdict: false, autoResolve: false },
      autoFix: { include: AUTO_FIX_DEFAULT_INCLUDE, autoPush: false },
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
  it('OFF by default; switched alone it leaves auto review and its floor untouched', async () => {
    const T1 = Date.UTC(2026, 8, 3);
    const on = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: true }, T1);
    expect(on?.autoFixEnabled).toBe(false);
    const fixOn = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: true }, T1 + 86_400_000);
    expect(fixOn).toMatchObject({
      enabled: true,
      enabledAt: new Date(T1).toISOString(),
      autoFixEnabled: true,
    });
    expect(await s.readWorkspaceAutoReview(ctx, 1, wsA2)).toEqual(fixOn);
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: false });
  });

  it('survives auto review off → on (stored independently)', async () => {
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: true });
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: false });
    const reOn = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: true });
    expect(reOn?.autoFixEnabled).toBe(true);
    const back = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: false });
    expect(back?.autoFixEnabled).toBe(false);
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: false });
  });

  it('readWorkspaceAutoFixForPr follows the PR repo’s workspace; no membership ⇒ the default, off', async () => {
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
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: true });
    expect(await s.readWorkspaceAutoFixForPr(ctx, 1, prIn)).toBe(true);
    expect(await s.readWorkspaceAutoFixForPr(ctx, 1, prLoose)).toBe(false);
    // Another account cannot read through this PR.
    expect(await s.readWorkspaceAutoFixForPr(ctx, 2, prIn)).toBe(false);
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoFixEnabled: false });
    expect(await s.readWorkspaceAutoFixForPr(ctx, 1, prIn)).toBe(false);
  });
});

describe('the daily cap', () => {
  const rawCap = async (id: number) => {
    const client = await import('../../db/client.js');
    const w = client.schema.workspaces;
    const { eq } = await import('drizzle-orm');
    const rows = await client.db
      .select({ cap: w.autoReviewDailyCap })
      .from(w)
      .where(eq(w.id, id))
      .execute();
    return rows[0]?.cap;
  };

  it('resolveAutoReviewDailyCap: null / out of range ⇒ the default', () => {
    expect(s.resolveAutoReviewDailyCap(null)).toBe(20);
    expect(s.resolveAutoReviewDailyCap(undefined)).toBe(20);
    expect(s.resolveAutoReviewDailyCap(0)).toBe(20);
    expect(s.resolveAutoReviewDailyCap(501)).toBe(20);
    expect(s.resolveAutoReviewDailyCap(50)).toBe(50);
  });

  it('a set cap round-trips, alone, leaving both switches and the floor alone', async () => {
    const T1 = Date.UTC(2026, 8, 4);
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: true, autoFixEnabled: true }, T1);
    const before = await s.readWorkspaceAutoReview(ctx, 1, wsA2);
    const set = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { dailyCap: 50 }, T1 + 86_400_000);
    expect(set).toEqual({ ...before, dailyCap: 50 });
    expect(await s.readWorkspaceAutoReview(ctx, 1, wsA2)).toEqual(set);
    expect(await rawCap(wsA2)).toBe(50);
    // Switching auto review off and on keeps it.
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: false });
    expect((await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: true }))?.dailyCap).toBe(50);
  });

  it('the roster carries each workspace’s own cap (the default where none is stored)', async () => {
    const roster = await s.listAutoReviewWorkspaces(ctx);
    const byWs = new Map(roster.map((r) => [r.workspaceId, r.dailyCap]));
    expect(byWs.get(wsA2)).toBe(50);
    expect(byWs.get(wsA)).toBe(20);
  });

  it('⚠ the default is stored as NULL (overrides only)', async () => {
    const back = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { dailyCap: 20 });
    expect(back?.dailyCap).toBe(20);
    expect(await rawCap(wsA2)).toBeNull();
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { enabled: false, autoFixEnabled: false });
  });

  it("another account's workspace cap is refused and NOT written", async () => {
    expect(await s.setWorkspaceAutoReview(ctx, 1, wsB, { dailyCap: 7 })).toBeNull();
    expect((await s.readWorkspaceAutoReview(ctx, 2, wsB))?.dailyCap).toBe(20);
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

  it('dailyCap round-trips; anything but an integer 1..500 is a 400 and writes nothing', async () => {
    const app = await build();
    const url = `/api/workspaces/${wsA2}/auto-review`;
    const put = await app.inject({ method: 'PUT', url, payload: { dailyCap: 35 } });
    expect(put.statusCode).toBe(200);
    expect(put.json().autoReview.dailyCap).toBe(35);
    expect((await app.inject({ method: 'GET', url })).json()).toEqual(put.json());
    for (const bad of [0, 501, 2.5, -3, 'many', '40', null, true]) {
      const res = await app.inject({ method: 'PUT', url, payload: { dailyCap: bad } });
      expect(res.statusCode, `dailyCap: ${JSON.stringify(bad)}`).toBe(400);
    }
    for (const ok of [1, 500]) {
      const res = await app.inject({ method: 'PUT', url, payload: { dailyCap: ok } });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoReview.dailyCap).toBe(ok);
    }
    expect((await app.inject({ method: 'GET', url })).json().autoReview.dailyCap).toBe(500);
    await app.inject({ method: 'PUT', url, payload: { dailyCap: 20 } });
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

describe('auto-posting — off by default, overrides only', () => {
  it('is OFF for an existing workspace and for one created now, with the defaults', async () => {
    const [fresh] = await (ctx.db as any)
      .insert((ctx.schema as any).workspaces)
      .values({ accountId: 1, name: 'Brand new', isDefault: false })
      .returning()
      .execute();
    for (const id of [wsA, wsA2, fresh.id]) {
      const r = await s.readWorkspaceAutoReview(ctx, 1, id);
      expect(r?.autoPost).toEqual({ enabled: false, scope: 'mine', kinds: AUTO_POST_DEFAULT_KINDS, autoVerdict: false, autoResolve: false });
    }
    expect(AUTO_POST_DEFAULT_KINDS).toEqual({
      blockers: true,
      warnings: true,
      nits: false,
      questions: true,
      ciFailures: true,
      storyGaps: true,
      notAskedFor: false,
    });
    // Nothing stored for a workspace nobody changed.
    const rows = await (ctx.db as any)
      .select({ e: (ctx.schema as any).workspaces.autoPostEnabled, st: (ctx.schema as any).workspaces.autoPostSettings })
      .from((ctx.schema as any).workspaces)
      .execute();
    expect(rows.every((r: any) => r.e == null && r.st == null)).toBe(true);
  });

  it('resolves malformed or partial overrides to the defaults', () => {
    expect(s.resolveAutoPostSettings(null, null)).toEqual({ enabled: false, scope: 'mine', kinds: AUTO_POST_DEFAULT_KINDS, autoVerdict: false, autoResolve: false });
    expect(
      s.resolveAutoPostSettings(true, { scope: 'bogus' as any, kinds: { nits: true, blockers: 'yes' as any } }),
    ).toEqual({ enabled: true, scope: 'mine', kinds: { ...AUTO_POST_DEFAULT_KINDS, nits: true }, autoVerdict: false, autoResolve: false });
    expect(s.autoPostOverrides({ scope: 'mine', kinds: AUTO_POST_DEFAULT_KINDS, autoVerdict: false, autoResolve: false })).toBeNull();
    expect(s.autoPostOverrides({ scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS, questions: false } })).toEqual({
      scope: 'all',
      kinds: { questions: false },
    });
  });

  it('writes alone, keeps unsent kinds, stores overrides only, and leaves auto review alone', async () => {
    const before = await s.readWorkspaceAutoReview(ctx, 1, wsA2);
    const on = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoPost: { enabled: true, kinds: { nits: true } } });
    expect(on?.autoPost).toEqual({ enabled: true, scope: 'mine', kinds: { ...AUTO_POST_DEFAULT_KINDS, nits: true }, autoVerdict: false, autoResolve: false });
    expect(on?.enabled).toBe(before?.enabled);
    expect(on?.enabledAt).toBe(before?.enabledAt);
    const scoped = await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoPost: { scope: 'all' } });
    expect(scoped?.autoPost).toEqual({ enabled: true, scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS, nits: true }, autoVerdict: false, autoResolve: false });
    const [row] = await (ctx.db as any)
      .select({ st: (ctx.schema as any).workspaces.autoPostSettings })
      .from((ctx.schema as any).workspaces)
      .where(eq((ctx.schema as any).workspaces.id, wsA2))
      .execute();
    expect(row.st).toEqual({ scope: 'all', kinds: { nits: true } });
    // Back to the defaults ⇒ NULL again.
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, { autoPost: { enabled: false, scope: 'mine', kinds: { nits: false } } });
    const [row2] = await (ctx.db as any)
      .select({ e: (ctx.schema as any).workspaces.autoPostEnabled, st: (ctx.schema as any).workspaces.autoPostSettings })
      .from((ctx.schema as any).workspaces)
      .where(eq((ctx.schema as any).workspaces.id, wsA2))
      .execute();
    expect(row2.st).toBeNull();
    expect(row2.e).toBe(false);
    // Another account's workspace is refused and not written.
    expect(await s.setWorkspaceAutoReview(ctx, 1, wsB, { autoPost: { enabled: true } })).toBeNull();
    expect((await s.readWorkspaceAutoReview(ctx, 2, wsB))?.autoPost.enabled).toBe(false);
  });

  it('the PUT validates the autoPost body', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify({ logger: false });
    s.registerAutoReviewSettingsRoutes(app, ctx);
    await app.ready();
    const url = `/api/workspaces/${wsA2}/auto-review`;
    for (const bad of [
      { autoPost: {} },
      { autoPost: { enabled: 'true' } },
      { autoPost: { enabled: 1 } },
      { autoPost: { scope: 'everyone' } },
      { autoPost: { kinds: {} } },
      { autoPost: { kinds: { nits: 'yes' } } },
      { autoPost: { kinds: { nits: 0 } } },
    ]) {
      const res = await app.inject({ method: 'PUT', url, payload: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const ok = await app.inject({ method: 'PUT', url, payload: { autoPost: { enabled: true, scope: 'all', kinds: { questions: false } } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().autoReview.autoPost).toEqual({
      enabled: true,
      scope: 'all',
      kinds: { ...AUTO_POST_DEFAULT_KINDS, questions: false },
      autoVerdict: false,
      autoResolve: false,
    });
    expect((await app.inject({ method: 'GET', url })).json()).toEqual(ok.json());
    await app.inject({ method: 'PUT', url, payload: { autoPost: { enabled: false, scope: 'mine', kinds: { questions: true } } } });
    await app.close();
  });
});

describe('auto verdict, auto resolve and auto fix settings (0091)', () => {
  it('default OFF / defaults; overrides only; written alone', async () => {
    const before = await s.readWorkspaceAutoReview(ctx, 1, wsA2);
    expect(before?.autoPost.autoVerdict).toBe(false);
    expect(before?.autoPost.autoResolve).toBe(false);
    expect(before?.autoFix).toEqual({ include: AUTO_FIX_DEFAULT_INCLUDE, autoPush: false });
    expect(AUTO_FIX_DEFAULT_INCLUDE).toEqual({
      findings: true,
      earlierFindings: true,
      judgedThreads: true,
      untouchedThreads: true,
      ciFailures: true,
      styleBots: false,
    });
    const on = await s.setWorkspaceAutoReview(ctx, 1, wsA2, {
      autoPost: { autoVerdict: true, autoResolve: true, kinds: { ciFailures: false } },
      autoFix: { include: { styleBots: true, untouchedThreads: false }, autoPush: true },
    });
    expect(on?.autoPost).toMatchObject({ autoVerdict: true, autoResolve: true, enabled: before?.autoPost.enabled });
    expect(on?.autoPost.kinds.ciFailures).toBe(false);
    expect(on?.autoFix).toEqual({
      include: { ...AUTO_FIX_DEFAULT_INCLUDE, styleBots: true, untouchedThreads: false },
      autoPush: true,
    });
    expect(on?.autoFixEnabled).toBe(before?.autoFixEnabled);
    expect(await s.readWorkspaceAutoReview(ctx, 1, wsA2)).toEqual(on);
    const [row] = await (ctx.db as any)
      .select({ p: (ctx.schema as any).workspaces.autoPostSettings, f: (ctx.schema as any).workspaces.autoFixSettings })
      .from((ctx.schema as any).workspaces)
      .where(eq((ctx.schema as any).workspaces.id, wsA2))
      .execute();
    expect(row.p).toEqual({ kinds: { ciFailures: false }, autoVerdict: true, autoResolve: true });
    expect(row.f).toEqual({ include: { untouchedThreads: false, styleBots: true }, autoPush: true });
    // Back to the defaults ⇒ NULL.
    await s.setWorkspaceAutoReview(ctx, 1, wsA2, {
      autoPost: { autoVerdict: false, autoResolve: false, kinds: { ciFailures: true } },
      autoFix: { include: { styleBots: false, untouchedThreads: true }, autoPush: false },
    });
    const [row2] = await (ctx.db as any)
      .select({ p: (ctx.schema as any).workspaces.autoPostSettings, f: (ctx.schema as any).workspaces.autoFixSettings })
      .from((ctx.schema as any).workspaces)
      .where(eq((ctx.schema as any).workspaces.id, wsA2))
      .execute();
    expect(row2.f).toBeNull();
    expect(row2.p).toBeNull();
  });

  it('resolveAutoFixSettings reads malformed overrides as the defaults', () => {
    expect(s.resolveAutoFixSettings(null)).toEqual({ include: AUTO_FIX_DEFAULT_INCLUDE, autoPush: false });
    expect(s.resolveAutoFixSettings({ include: { findings: 'no' as any, styleBots: true }, autoPush: 1 as any })).toEqual({
      include: { ...AUTO_FIX_DEFAULT_INCLUDE, styleBots: true },
      autoPush: false,
    });
  });

  it('the PUT validates autoVerdict / autoResolve / autoFix; GET has usage only while on', async () => {
    const { default: Fastify } = await import('fastify');
    const usageCtx = {
      ...ctx,
      queries: { getAutoReviewCandidates: async () => ({ prIds: [], autoToday: 7, reReview: [], inFlightMoved: [] }) },
    } as any as AgentContext;
    const app = Fastify({ logger: false });
    s.registerAutoReviewSettingsRoutes(app, usageCtx);
    await app.ready();
    const url = `/api/workspaces/${wsA2}/auto-review`;
    for (const bad of [
      { autoPost: { autoVerdict: 'yes' } },
      { autoPost: { autoResolve: 1 } },
      { autoFix: {} },
      { autoFix: { autoPush: 'true' } },
      { autoFix: { include: {} } },
      { autoFix: { include: { styleBots: 0 } } },
    ]) {
      const res = await app.inject({ method: 'PUT', url, payload: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    await app.inject({ method: 'PUT', url, payload: { enabled: false } });
    expect((await app.inject({ method: 'GET', url })).json().usage).toBeUndefined();
    await app.inject({ method: 'PUT', url, payload: { enabled: true } });
    const got = (await app.inject({ method: 'GET', url })).json();
    expect(got.usage.used).toBe(7);
    expect(got.usage.cap).toBe(got.autoReview.dailyCap);
    const reset = Date.parse(got.usage.resetsAt);
    expect(new Date(reset).getUTCHours()).toBe(0);
    expect(reset).toBeGreaterThan(Date.now());
    expect(reset - Date.now()).toBeLessThanOrEqual(86_400_000);
    await app.close();
  });
});

describe('the settings history records only REAL changes', () => {
  it('⚠ a Save on a workspace whose auto review is already off records no "switched off" line', async () => {
    const [extra] = await ctx.db
      .insert(ctx.schema.workspaces)
      .values({ accountId: 1, name: 'History', isDefault: false })
      .returning()
      .execute();
    const ws = extra!.id as number;
    const t = ctx.schema.workspaceSettingEvents;
    const lines = async (): Promise<string[]> =>
      ((await ctx.db.select().from(t).where(eq(t.workspaceId, ws)).execute()) as { summary: string }[]).map(
        (r) => r.summary,
      );
    // The Settings Save always sends `enabled`; here it is off, and only auto fix moves.
    await s.setWorkspaceAutoReview(ctx, 1, ws, { enabled: false, autoFixEnabled: true });
    expect(await lines()).toEqual(['Auto fix switched on']);
    await s.setWorkspaceAutoReview(ctx, 1, ws, { enabled: false, dailyCap: 7 });
    expect(await lines()).toEqual(['Auto fix switched on', 'Auto review daily limit changed']);
    // A real flip is still recorded, both ways.
    await s.setWorkspaceAutoReview(ctx, 1, ws, { enabled: true });
    await s.setWorkspaceAutoReview(ctx, 1, ws, { enabled: false });
    expect((await lines()).slice(2)).toEqual(['Auto review switched on', 'Auto review switched off']);
  });
});
