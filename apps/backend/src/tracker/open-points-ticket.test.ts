// A session start's ticket re-read (tracker/open-points-ticket.ts) on a THROWAWAY sqlite DB. Pinned:
//   • NO PR: the sprint list read is marked due and RUN, then the points come from the refreshed
//     `sprint_tickets` row (fresh when read within OPEN_POINTS_FRESH_MS), under the workspace's choice;
//   • WITH PRs: the PR path (`openPointsForPr`, refresh) on at most two PRs, open first; the ticket's
//     own key is picked; a PR with no entry means "no open points", fresh;
//   • never throws: a failure is the stored copy, `fresh: false`.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/limn-open-points-ticket-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const sprintReads: Array<[number, number]> = [];
vi.mock('./sprint/read.js', async (orig) => ({
  ...(await orig<typeof import('./sprint/read.js')>()),
  readWorkspaceSprintOnce: vi.fn(async (_ctx: unknown, accountId: number, workspaceId: number) => {
    sprintReads.push([accountId, workspaceId]);
    return { ok: true, stored: 1, code: null };
  }),
}));
const prCalls: Array<{ prId: number; refresh: boolean }> = [];
vi.mock('./open-points-pr.js', async (orig) => ({
  ...(await orig<typeof import('./open-points-pr.js')>()),
  openPointsForPr: vi.fn(async (_ctx: unknown, _a: number, prId: number, opts: { refresh: boolean }) => {
    prCalls.push({ prId, refresh: opts.refresh });
    if (prId === 21) return [{ key: 'OTHER-1', points: [{ text: 'not ours', source: 'field', fieldName: 'Open points' }], fresh: true, fetchedAt: null }];
    return [{ key: 'ACME-7', points: [{ text: 'Which reasons?', source: 'field', fieldName: 'Open points' }], fresh: prId === 22, fetchedAt: '2026-11-07T10:00:00.000Z' }];
  }),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let ctx: any;
let client: any;
let ws = 0;
const NOW = Date.UTC(2026, 10, 7, 10, 0, 0);
const IDENT = 'jira:https://acme.atlassian.net#ACME-7';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  client = await import('../db/client.js');
  await runMigrations();
  const q = await import('../db/queries.js');
  ws = await q.ensureDefaultWorkspace(1);
  const { buildTrackerContext } = await import('./runtime.js');
  ctx = buildTrackerContext({ warn: () => {}, info: () => {}, error: () => {} });
  const at = new Date(NOW - 30_000);
  await client.db
    .insert(client.schema.sprintTickets)
    .values({
      accountId: 1,
      workspaceId: ws,
      ident: IDENT,
      provider: 'jira',
      apiRoot: 'https://acme.atlassian.net',
      issueKey: 'ACME-7',
      title: 'Refunds',
      description: 'Refund a paid order.\n\n## Open questions\n- Which refund reasons?\n- Partial refunds?\n',
      firstSeenAt: at,
      lastSeenAt: at,
      fetchedAt: at,
      nextCheckAt: at,
    })
    .execute();
});

afterAll(async () => {
  await client?.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('refreshTicketForSession', () => {
  it('with no PR, runs the sprint list read and derives the points from the refreshed row', async () => {
    const { refreshTicketForSession } = await import('./open-points-ticket.js');
    const r = await refreshTicketForSession(ctx, 1, ws, IDENT, [], { nowMs: NOW, waitMs: 1000 });
    expect(sprintReads).toEqual([[1, ws]]);
    expect(r.points.map((p) => p.text)).toEqual(['Which refund reasons?', 'Partial refunds?']);
    expect(r.fresh).toBe(true);
    const stale = await refreshTicketForSession(ctx, 1, ws, IDENT, [], { nowMs: NOW + 10 * 60_000, waitMs: 1000 });
    expect(stale.fresh).toBe(false);
  });

  it('with PRs, re-reads at most two (open first) and keeps the fresh answer for this key', async () => {
    const { refreshTicketForSession } = await import('./open-points-ticket.js');
    prCalls.length = 0;
    const r = await refreshTicketForSession(ctx, 1, ws, IDENT, [
      { prId: 30, state: 'merged' },
      { prId: 21, state: 'open' },
      { prId: 22, state: 'open' },
    ]);
    expect(prCalls).toEqual([
      { prId: 21, refresh: true },
      { prId: 22, refresh: true },
    ]);
    expect(r).toEqual({ points: [{ text: 'Which reasons?', source: 'field', fieldName: 'Open points' }], fresh: true, fetchedAt: '2026-11-07T10:00:00.000Z' });
  });

  it('never throws, and refuses a manual ident', async () => {
    const { refreshTicketForSession } = await import('./open-points-ticket.js');
    expect(await refreshTicketForSession(ctx, 1, ws, 'manual:3:abc', [])).toEqual({ points: [], fresh: false, fetchedAt: null });
    const broken = { ...ctx, schema: { ...ctx.schema, sprintTickets: undefined } };
    expect(await refreshTicketForSession(broken, 1, ws, IDENT, [], { waitMs: 10 })).toEqual({ points: [], fresh: false, fetchedAt: null });
  });
});
