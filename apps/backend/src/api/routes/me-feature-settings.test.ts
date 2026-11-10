// SETTINGS → FEATURES end to end on a THROWAWAY sqlite DB: GET /api/me's `features`, PUT
// /api/me/feature-settings, and the facts behind the defaults (db/feature-gates.ts).
//
// WHAT THIS PINS:
//  1. MIGRATION 0153 IS REGISTERED and its stamp marks ONLY an account that already had repos.
//  2. A NEW install starts with Feed and Bots Monitoring hidden; Reports shows once a repo's backfill
//     has finished; This Sprint once a sprint source exists (a configured Jira/Linear/Notion tracker
//     not yet read as "no sprint", or a read that found a sprint / a milestone with a due date).
//  3. An EXISTING install shows everything but the Timeline; a stored switch still wins.
//  5. The Timeline is OFF by default for every install, and a stored `timeline: true` turns it on.
//  4. The PUT stores overrides only, echoes what was stored, and /api/me agrees at once.
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-me-feature-settings-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let eq: any;
let closeDb: (() => Promise<void>) | undefined;
let refresh: (id: number) => Promise<unknown>;
let ws = 0;
let repoId = 0;

const me = async (): Promise<any> => (await app.inject({ method: 'GET', url: '/api/me' })).json();
const put = async (body: unknown): Promise<any> =>
  app.inject({ method: 'PUT', url: '/api/me/feature-settings', payload: body });
const visible = async (): Promise<Record<string, boolean>> => {
  const f = (await me()).features;
  return Object.fromEntries(Object.entries(f).map(([k, v]: [string, any]) => [k, v.visible]));
};
const setExisting = async (on: boolean): Promise<void> => {
  await db.update(schema.accounts).set({ featuresExistingInstall: on }).where(eq(schema.accounts.id, 1)).execute();
  await refresh(1);
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ eq } = await import('drizzle-orm'));
  await runMigrations();
  await db
    .update(schema.accounts)
    .set({ githubUserId: 'U_viewer', githubLogin: 'viewer', displayName: 'Viewer', lastLoginAt: new Date() })
    .where(eq(schema.accounts.id, 1))
    .execute();
  const account = await import('../../auth/account.js');
  refresh = account.refreshLocalAccountCache;
  await account.ensureLocalAccount();
  const q = await import('../../db/queries.js');
  ws = await q.ensureDefaultWorkspace(1);

  const { registerAccountContext } = await import('../plugins/auth.js');
  const { meRoutes } = await import('./me.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(meRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('migration 0153', () => {
  it('stamps an existing install only when the account already had repos', async () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../db/migrations/0153_feature_visibility.sql', import.meta.url)),
      'utf8',
    );
    const update = sql.split('--> statement-breakpoint').map((s) => s.trim()).find((s) => /^UPDATE/m.test(s.replace(/^--.*$/gm, '').trim()));
    expect(update).toBeTruthy();
    const { rawSqlite } = await import('../../db/client.js');
    const raw = rawSqlite as any;
    // A fresh install: account 1 has no repos, so the stamp leaves it a new install.
    raw.exec(update!);
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, 1)).execute())[0].featuresExistingInstall).toBe(false);
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId: 1, githubNodeId: 'R_feat', owner: 'acme', name: 'web' })
      .returning({ id: schema.repos.id })
      .execute();
    repoId = r.id;
    raw.exec(update!);
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, 1)).execute())[0].featuresExistingInstall).toBe(true);
    await setExisting(false);
  });
});

describe('GET /api/me features', () => {
  it('a new install hides Feed and Bots, and Reports and This Sprint until their facts hold', async () => {
    expect(await visible()).toEqual({ timeline: false, feed: false, reports: false, sprint: false, bots: false });
  });

  it('Reports shows once a repository has finished its backfill', async () => {
    await db.insert(schema.syncState).values({ repoId, lastIncrementalSyncAt: new Date() }).execute();
    expect((await visible()).reports).toBe(false);
    await db.update(schema.syncState).set({ lastFullSyncAt: new Date() }).where(eq(schema.syncState.repoId, repoId)).execute();
    expect((await visible()).reports).toBe(true);
  });

  it('This Sprint follows the sprint source', async () => {
    // GitHub Issues alone says nothing until a read finds a milestone with a due date.
    await db.insert(schema.workspaceTrackers).values({ accountId: 1, workspaceId: ws, provider: 'github' }).execute();
    expect((await visible()).sprint).toBe(false);
    const read = (source: unknown) => ({ accountId: 1, workspaceId: ws, sourceJson: source, readAt: new Date(), nextReadAt: new Date(), viewedAt: new Date() });
    await db.insert(schema.sprintReads).values(read({ kind: 'milestone', provider: 'github', name: 'v2', dueOn: null, repos: [] })).execute();
    expect((await visible()).sprint).toBe(false);
    await db.update(schema.sprintReads).set({ sourceJson: { kind: 'milestone', provider: 'github', name: 'v2', dueOn: '2026-11-14T00:00:00Z', repos: [] } }).execute();
    expect((await visible()).sprint).toBe(true);
    // A current GitHub Projects iteration counts; a milestone read that only noted the missing
    // Projects scope (no due date) does not.
    await db
      .update(schema.sprintReads)
      .set({ sourceJson: { kind: 'milestone', provider: 'github', name: 'v2', dueOn: null, repos: [], projectsAccess: 'needs_scope' } })
      .execute();
    expect((await visible()).sprint).toBe(false);
    await db
      .update(schema.sprintReads)
      .set({
        sourceJson: { kind: 'iteration', provider: 'github', name: 'Sprint 7', project: 'Web', field: 'Sprint', startsOn: '2026-10-26', endsOn: '2026-11-09', repos: [] },
      })
      .execute();
    expect((await visible()).sprint).toBe(true);
    // A configured Jira tracker counts until a read says it has no sprint.
    await db.delete(schema.sprintReads).execute();
    await db.update(schema.workspaceTrackers).set({ provider: 'jira' }).execute();
    expect((await visible()).sprint).toBe(true);
    await db.insert(schema.sprintReads).values(read({ kind: 'status_fallback', provider: 'jira', reason: 'none_active', from: '', to: '' })).execute();
    expect((await visible()).sprint).toBe(false);
    await db.update(schema.sprintReads).set({ sourceJson: { kind: 'sprint', provider: 'jira', names: ['Sprint 4'] } }).execute();
    expect((await visible()).sprint).toBe(true);
  });

  it('an existing install shows everything by default except the Timeline', async () => {
    await db.delete(schema.sprintReads).execute();
    await db.delete(schema.workspaceTrackers).execute();
    await db.delete(schema.syncState).execute();
    await setExisting(true);
    const f = (await me()).features;
    const { timeline, ...rest } = f;
    expect(Object.values(rest).every((s: any) => s.visible && s.defaultOn && s.setting === null)).toBe(true);
    expect(timeline).toEqual({ visible: false, setting: null, defaultOn: false });
    await setExisting(false);
  });
});

describe('PUT /api/me/feature-settings', () => {
  it('stores overrides only and /api/me agrees at once', async () => {
    const res = await put({ settings: { feed: true, bots: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().featureSettings).toEqual({ feed: true, bots: false });
    expect(res.json().features.feed).toEqual({ visible: true, setting: true, defaultOn: false });
    expect((await visible()).feed).toBe(true);
  });

  it('a stored switch beats an existing install', async () => {
    await setExisting(true);
    await put({ settings: { reports: false } });
    expect(await visible()).toEqual({ timeline: false, feed: true, reports: false, sprint: true, bots: true });
    await setExisting(false);
  });

  it('the Timeline turns on only by a stored switch', async () => {
    const res = await put({ settings: { timeline: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().featureSettings).toEqual({ timeline: true });
    expect(res.json().features.timeline).toEqual({ visible: true, setting: true, defaultOn: false });
    expect((await visible()).timeline).toBe(true);
  });

  it('null resets every switch; a non-boolean is refused', async () => {
    const reset = await put({ settings: null });
    expect(reset.json().featureSettings).toBeNull();
    expect((await me()).features.feed.setting).toBeNull();
    expect((await put({ settings: { feed: 'yes' } })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
  });
});
