// GET /api/merged-prs — Reports → "Merged so far", on a THROWAWAY sqlite DB with a real Fastify
// instance.
//
// Pinned:
//   1. The list is the PRs MERGED in the reporting window, `[from, to)` on `mergedAt`: a merge AT
//      `from` is in, a merge AT `to` is out, an open PR and a closed-unmerged PR are out.
//   2. Newest merge first, and the window + resolved workspace are echoed.
//   3. Another tenant's workspace id resolves to the caller's Default; a foreign PR never appears.
//   4. Pro on `periodReports`: 402 without it.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = '/private/tmp/pierre-merged-prs-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let rw: any;
let ownWs = 0;
let foreignWs = 0;
let setCaps: ((c: any) => void) | undefined;
let emptyCaps: any;
const ids: Record<string, number> = {};

const DAY = 86_400_000;
const NOW = Date.now();
// A window that has already ENDED, so `to` is the window's own end (not clamped to now).
const FROM = NOW - 10 * DAY;
const TO = NOW - 2 * DAY;

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
    .values({ id: 2, githubUserId: 'U_mpr_b', githubLogin: 'mpr-b', isLocal: false })
    .execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);

  const mkRepo = async (name: string, accountId: number, ws: number): Promise<number> => {
    const id = (
      await db
        .insert(schema.repos)
        .values({ accountId, owner: 'mpr', name, githubNodeId: `R_mpr_${name}`, createdAt: new Date(NOW - 100 * DAY) })
        .returning()
        .execute()
    )[0].id;
    await db.insert(schema.workspaceRepos).values({ accountId, workspaceId: ws, repoId: id }).execute();
    return id;
  };
  const mine = await mkRepo('mine', 1, ownWs);
  const theirs = await mkRepo('theirs', 2, foreignWs);

  let seq = 0;
  const mkPr = async (
    key: string,
    repoId: number,
    accountId: number,
    state: 'open' | 'merged' | 'closed',
    atMs: number,
  ): Promise<void> => {
    seq += 1;
    ids[key] = (
      await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_mpr_${seq}`,
          accountId,
          repoId,
          number: seq,
          title: key,
          state,
          isDraft: false,
          openedAt: new Date(atMs - DAY),
          updatedAt: new Date(atMs),
          mergedAt: state === 'merged' ? new Date(atMs) : null,
          closedAt: state === 'open' ? null : new Date(atMs),
          additions: 3,
          deletions: 1,
          changedFiles: 1,
        })
        .returning()
        .execute()
    )[0].id;
  };
  await mkPr('atFrom', mine, 1, 'merged', FROM);
  await mkPr('middle', mine, 1, 'merged', FROM + 3 * DAY);
  await mkPr('atTo', mine, 1, 'merged', TO);
  await mkPr('before', mine, 1, 'merged', FROM - 60_000);
  await mkPr('open', mine, 1, 'open', FROM + DAY);
  await mkPr('closed', mine, 1, 'closed', FROM + DAY);
  await mkPr('foreign', theirs, 2, 'merged', FROM + DAY);

  const contract = await import('../../pro/contract.js');
  contract.setProCapabilities({ ...contract.EMPTY_CAPABILITIES, periodReports: true });
  setCaps = contract.setProCapabilities;
  emptyCaps = contract.EMPTY_CAPABILITIES;
  const { insightsRoutes } = await import('./insights.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(insightsRoutes);
  await app.ready();
});

afterAll(async () => {
  setCaps?.(emptyCaps);
  rw?.registerReportingWindowResolver(null);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('GET /api/merged-prs — the reporting window', () => {
  it('lists PRs merged in [from, to), newest first, and echoes the window', async () => {
    const asked: number[] = [];
    rw.registerReportingWindowResolver(async ({ workspaceId }: { workspaceId: number }) => {
      asked.push(workspaceId);
      return { fromMs: FROM, toMs: TO, mode: 'sprint' };
    });
    const { status, body } = await get(`/api/merged-prs?workspace=${ownWs}`);
    expect(status).toBe(200);
    expect(asked).toEqual([ownWs]);
    expect(body.workspaceId).toBe(ownWs);
    expect(body.truncated).toBe(false);
    expect(body.window).toMatchObject({
      mode: 'sprint',
      from: new Date(FROM).toISOString(),
      to: new Date(TO).toISOString(),
    });
    expect(body.prs.map((p: any) => p.id)).toEqual([ids.middle, ids.atFrom]);
    // The same TimelinePr shape the Open PRs cards draw.
    expect(body.prs[0]).toMatchObject({ state: 'merged', title: 'middle' });
    expect(body.prs[0]).toHaveProperty('threadCounts');
  });

  it('with no resolver (OSS) is the trailing 14 days up to now', async () => {
    rw.registerReportingWindowResolver(null);
    const { body } = await get(`/api/merged-prs?workspace=${ownWs}`);
    expect(body.window).toMatchObject({ mode: 'rolling_14', days: 14 });
    // Every own merge in the last 14 days, the one AT the old `to` included now.
    expect(body.prs.map((p: any) => p.id)).toEqual([ids.atTo, ids.middle, ids.atFrom, ids.before]);
  });

  it("resolves another tenant's workspace id to the caller's Default", async () => {
    rw.registerReportingWindowResolver(null);
    const { body } = await get(`/api/merged-prs?workspace=${foreignWs}`);
    expect(body.workspaceId).toBe(ownWs);
    expect(body.prs.some((p: any) => p.id === ids.foreign)).toBe(false);
  });

  it('402s without periodReports', async () => {
    setCaps?.(emptyCaps);
    const res = await app.inject({ method: 'GET', url: '/api/merged-prs' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: 'pro required' });
    setCaps?.({ ...emptyCaps, periodReports: true });
  });
});
