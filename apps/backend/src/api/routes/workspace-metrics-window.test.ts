// GET /api/workspace-metrics — every windowed figure in the response is tied to ONE reporting
// window, on a THROWAWAY sqlite DB with a real Fastify instance.
//
// Pinned:
//   1. The window is resolved ONCE per request, through the one resolver, for the RESOLVED
//      workspace (a foreign `?workspace=` id is the account's Default, and so is its window).
//   2. The tiles, Activity by repository and Reach by repository all measure that window, and the
//      response echoes it so each card can name it.
//   3. Reach rides the same response, workspace-scoped: another account's merged PR never appears.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = '/tmp/pierre-workspace-metrics-window-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let rw: any;
let ownWs = 0;
let foreignWs = 0;
let inSprint = 0;
let beforeSprint = 0;
let foreignPr = 0;

const DAY = 86_400_000;
const NOW = Date.now();
const SPRINT_FROM = NOW - 3 * DAY;

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as any };
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  rw = await import('../../db/reporting-window.js');
  const db: any = client.db;
  const schema: any = client.schema;

  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'U_wmw_b', githubLogin: 'wmw-b', isLocal: false })
    .execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);

  const mkRepo = async (name: string, accountId: number, ws: number): Promise<number> => {
    const id = (
      await db
        .insert(schema.repos)
        .values({
          accountId,
          owner: 'wmw',
          name,
          githubNodeId: `R_wmw_${name}`,
          createdAt: new Date(NOW - 100 * DAY),
        })
        .returning()
        .execute()
    )[0].id;
    await db.insert(schema.workspaceRepos).values({ accountId, workspaceId: ws, repoId: id }).execute();
    return id;
  };
  const mine = await mkRepo('mine', 1, ownWs);
  const theirs = await mkRepo('theirs', 2, foreignWs);

  let seq = 0;
  const mkMerged = async (repoId: number, accountId: number, mergedMs: number): Promise<number> => {
    seq += 1;
    return (
      await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_wmw_${seq}`,
          accountId,
          repoId,
          number: seq,
          title: `pr ${seq}`,
          state: 'merged',
          isDraft: false,
          openedAt: new Date(mergedMs - DAY),
          updatedAt: new Date(mergedMs),
          mergedAt: new Date(mergedMs),
          additions: 3,
          deletions: 1,
          changedFiles: 1,
          files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
        })
        .returning()
        .execute()
    )[0].id;
  };
  inSprint = await mkMerged(mine, 1, NOW - DAY);
  beforeSprint = await mkMerged(mine, 1, NOW - 6 * DAY); // inside a rolling 14, before the sprint
  foreignPr = await mkMerged(theirs, 2, NOW - DAY);

  const { insightsRoutes } = await import('./insights.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(insightsRoutes);
  await app.ready();
});

afterAll(async () => {
  rw?.registerReportingWindowResolver(null);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('GET /api/workspace-metrics — the reporting window', () => {
  it('with no resolver (OSS) is the trailing 14 days, and every card measures it', async () => {
    rw.registerReportingWindowResolver(null);
    const { status, body } = await get(`/api/workspace-metrics?workspace=${ownWs}`);
    expect(status).toBe(200);
    expect(body.window).toMatchObject({ mode: 'rolling_14', days: 14 });
    expect(body.repoActivity.from).toBe(body.window.from);
    expect(body.reach.from).toBe(body.window.from);
    expect(body.metrics.comparisonMode).toBe('rolling_14');
    expect(body.reach.prs.map((p: any) => p.id).sort()).toEqual([inSprint, beforeSprint].sort());
  });

  it('follows a sprint: tiles, activity and reach all start at the sprint start', async () => {
    const asked: number[] = [];
    rw.registerReportingWindowResolver(async ({ workspaceId }: { workspaceId: number }) => {
      asked.push(workspaceId);
      return { fromMs: SPRINT_FROM, toMs: SPRINT_FROM + 14 * DAY, mode: 'sprint' };
    });
    const { body } = await get(`/api/workspace-metrics?workspace=${ownWs}`);
    expect(asked).toEqual([ownWs]); // ONCE per request, for this workspace
    expect(body.window).toMatchObject({ mode: 'sprint', days: 14, from: new Date(SPRINT_FROM).toISOString() });
    expect(body.metrics.comparisonMode).toBe('sprint');
    expect(body.repoActivity.from).toBe(body.window.from);
    expect(body.reach.from).toBe(body.window.from);
    // The PR merged before the sprint started is out of the sprint's reach population.
    expect(body.reach.prs.map((p: any) => p.id)).toEqual([inSprint]);
    // Signals, never a level.
    expect(body.reach.prs[0]).toHaveProperty('blast');
    expect(body.reach.prs[0]).not.toHaveProperty('level');
  });

  it("resolves another tenant's workspace id to the Default — window and data alike", async () => {
    const asked: number[] = [];
    rw.registerReportingWindowResolver(async ({ workspaceId }: { workspaceId: number }) => {
      asked.push(workspaceId);
      return { fromMs: SPRINT_FROM, toMs: SPRINT_FROM + 14 * DAY, mode: 'sprint' };
    });
    const { body } = await get(`/api/workspace-metrics?workspace=${foreignWs}`);
    expect(body.workspaceId).toBe(ownWs);
    expect(asked).toEqual([ownWs]);
    expect(body.reach.prs.some((p: any) => p.id === foreignPr)).toBe(false);
  });
});
