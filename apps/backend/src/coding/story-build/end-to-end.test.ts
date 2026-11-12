// BUILD END TO END — THE TICKET STEP (end-to-end.ts) over the REAL core client (a scratch SQLite, migrations
// applied), with the Jira writes faked. Pinned:
//   • the update sends ONLY what the approved plan changes (the shared `ticketUpdateBody` rule);
//   • ONE comment: the PR link, what changed and why (the plan's `why` and settled points), the rounds;
//   • the claim: a second call writes nothing; an ordinary (not end-to-end) build is never touched;
//   • a failed update is recorded, still commented on, and leaves the tab's ticket step OPEN;
//   • a tracker that is not Jira: nothing written, `skipped: 'not_jira'`, the step left open.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildPlanRevision } from '@pierre-review/shared';
import { endToEndCommentWiki, wikiLabel, type EndToEndDeps } from './end-to-end.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-storybuild.end-to-end.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let ctx: any;
let closeDb: (() => Promise<void> | void) | undefined;
let P: typeof import('./persist.js');
let PP: typeof import('./plan-persist.js');
let E: typeof import('./end-to-end.js');
let ws = 0;
let repoId = 0;
let n = 0;
const IDENT = 'jira:https://acme.atlassian.net#ACME-9';

describe('the comment (pure)', () => {
  it('escapes what would break a wiki link label', () => {
    expect(wikiLabel('a [b] | c')).toBe('a \\[b\\] \\| c');
  });
  it('says there was nothing to change when the plan kept the story', () => {
    const w = endToEndCommentWiki({ prs: [], ticket: { updated: [] }, whyWiki: null, pointsWiki: [], rounds: 1 });
    expect(w).toContain('None opened.');
    expect(w).toContain('None. The plan found the story right as written.');
    expect(w).toContain('over 1 review round before');
  });
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const { ensureDefaultWorkspace } = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'N1', githubLogin: 'u1', isLocal: true }).onConflictDoNothing().execute();
  ws = await ensureDefaultWorkspace(1);
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, githubNodeId: 'R1api', owner: 'acme', name: 'api', defaultBranch: 'main', viewerPermission: 'WRITE' })
    .returning()
    .execute();
  repoId = r.id;
  ctx = { db, schema, log: { warn: () => {}, info: () => {}, error: () => {} } };
  P = await import('./persist.js');
  PP = await import('./plan-persist.js');
  E = await import('./end-to-end.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

/** A build whose review loop has opened PR #77, with an approved plan that rewrites the criteria. */
async function openedBuild(o: { endToEnd: boolean; ticketUpdate?: BuildPlanRevision['ticketUpdate'] }): Promise<number> {
  for (const row of await P.listStoryBuildRowsFor(ctx, 1, ws, IDENT)) if (row.status !== 'discarded') await P.updateStoryBuild(ctx, 1, row.id, { status: 'discarded' });
  const started = await P.insertStoryBuild(ctx, { accountId: 1, workspaceId: ws, ident: IDENT, ticketKey: 'ACME-9', ticketTitle: 'Refunds', wantDiagram: false, wantDocs: false, provider: 'claude', model: 'm' });
  const id = started.id;
  const plan: Omit<BuildPlanRevision, 'revision' | 'createdAt' | 'source'> = {
    summary: 'Refunds.',
    repos: [],
    criteria: [{ ref: 'AC1', text: 'Refunds are instant', status: 'planned', how: 'Queue them.', prs: ['P1'], openPoints: [] }],
    contentions: [{ id: 'C1', fingerprint: 'f1', about: ['AC1'], storySays: 'instant', problem: 'The code queues refunds.', proposal: 'Say they are queued.', ifKept: 'Make them instant.', evidence: [] }],
    stack: [{ key: 'P1', repoId, fullName: 'acme/api', stackIndex: 1, title: 'Queue refunds', contains: 'Work.', criteria: ['AC1'], dependsOn: [], branch: `limn/acme-9-${++n}` }],
    stackReason: null,
    ticketUpdate: o.ticketUpdate === undefined ? { description: null, acceptanceCriteria: '- Refunds are queued', why: 'The code queues refunds.', contentions: ['C1'] } : o.ticketUpdate,
    dropped: { contentions: 0, evidence: 0, reasons: [] },
  };
  await PP.insertPlanRevision(ctx, { accountId: 1, buildId: id, source: 'opening', plan, rawSha: `r${id}`, now: new Date() });
  expect(await PP.approvePlanRevision(ctx, { accountId: 1, buildId: id, plan: (await PP.latestPlanRow(ctx, 1, id))!, now: new Date() })).toBe(true);
  const [pr] = await PP.listPlannedPrRows(ctx, 1, id);
  await PP.updateStoryBuildPr(ctx, 1, pr!.id, { status: 'pushed', pushedPrNumber: 77, pushedPrUrl: 'https://github.com/acme/api/pull/77', prTitle: 'ACME-9: Queue refunds' });
  await P.updateStoryBuild(ctx, 1, id, { endToEnd: o.endToEnd, autoPush: true, loopRound: 3 } as any);
  return id;
}

function fakeDeps(o: { jira?: boolean; writeFails?: string } = {}) {
  const writes: any[] = [];
  const comments: any[] = [];
  const notices: string[] = [];
  const deps: EndToEndDeps = {
    now: () => new Date('2026-11-12T12:00:00Z'),
    notice: (t) => notices.push(t),
    trackerIsJira: async () => o.jira !== false,
    currentTicket: async () => ({ description: 'Refunds.', acceptanceCriteria: '- Refunds are instant', acLocation: { kind: 'field', fieldId: 'customfield_1', fieldName: 'AC' } as any }),
    writeTicket: async (_c, a) => {
      writes.push(a);
      return o.writeFails ? { ok: false, message: o.writeFails } : { ok: true };
    },
    comment: async (_c, a) => {
      comments.push(a);
      return { ok: true };
    },
    toWiki: async (md) => md,
  };
  return { deps, writes, comments, notices };
}

describe('the ticket step', () => {
  it('writes only what the plan changes, comments once, and closes the ticket step', async () => {
    const id = await openedBuild({ endToEnd: true });
    const f = fakeDeps();
    const r = await E.runEndToEndTicketStep(ctx, 1, id, f.deps);
    expect(r).toMatchObject({ updated: ['acceptanceCriteria'], commented: true, skipped: null, error: null });
    expect(f.writes).toEqual([{ accountId: 1, workspaceId: ws, ident: IDENT, description: null, acceptanceCriteria: '- Refunds are queued' }]);
    expect(f.comments).toHaveLength(1);
    const wiki: string = f.comments[0].wiki;
    expect(wiki).toContain('[acme/api#77|https://github.com/acme/api/pull/77]');
    expect(wiki).toContain('Limn updated the acceptance criteria to match the approved plan.');
    expect(wiki).toContain('Why: The code queues refunds.');
    expect(wiki).toContain('* The code queues refunds. Say they are queued.');
    expect(wiki).toContain('over 3 review rounds');
    const row = await P.getStoryBuildRow(ctx, 1, id);
    expect(row?.e2eTicketJson).toMatchObject({ updated: ['acceptanceCriteria'], commented: true });
    expect(row?.ticketReviewDoneAt).not.toBeNull();
    expect(f.notices).toEqual(['Limn updated the ticket and commented on it.']);
    // THE CLAIM: never a second write.
    expect(await E.runEndToEndTicketStep(ctx, 1, id, f.deps)).toBeNull();
    expect(f.writes).toHaveLength(1);
    expect(f.comments).toHaveLength(1);
  });

  it("⚠ the agent's words cannot mention anyone or run a macro in the comment", async () => {
    const id = await openedBuild({
      endToEnd: true,
      ticketUpdate: { description: null, acceptanceCriteria: '- Refunds are queued', why: 'Ask [~accountid:123] and {html}<b>x</b>{html}.', contentions: ['C1'] },
    });
    const f = fakeDeps();
    await E.runEndToEndTicketStep(ctx, 1, id, f.deps);
    const wiki: string = f.comments[0].wiki;
    expect(wiki).toContain('\\[~accountid:123]');
    expect(wiki).toContain('\\{html}');
    expect(wiki).not.toMatch(/(^|[^\\])\[~accountid:123\]/);
  });

  it('never touches an ordinary build', async () => {
    const id = await openedBuild({ endToEnd: false });
    const f = fakeDeps();
    expect(await E.runEndToEndTicketStep(ctx, 1, id, f.deps)).toBeNull();
    expect(f.writes).toHaveLength(0);
    expect(f.comments).toHaveLength(0);
  });

  it('a failed update is recorded, still commented on, and leaves the ticket step open', async () => {
    const id = await openedBuild({ endToEnd: true });
    const f = fakeDeps({ writeFails: 'Jira refused the change.' });
    const r = await E.runEndToEndTicketStep(ctx, 1, id, f.deps);
    expect(r).toMatchObject({ updated: [], commented: true, error: 'Jira refused the change.' });
    expect(f.comments[0].wiki).toContain('Limn could not update the ticket text: Jira refused the change.');
    expect((await P.getStoryBuildRow(ctx, 1, id))?.ticketReviewDoneAt).toBeNull();
  });

  it('no change to make: comments that the story stood, and closes the step', async () => {
    const id = await openedBuild({ endToEnd: true, ticketUpdate: null });
    const f = fakeDeps();
    const r = await E.runEndToEndTicketStep(ctx, 1, id, f.deps);
    expect(r).toMatchObject({ updated: [], commented: true, error: null });
    expect(f.writes).toHaveLength(0);
    expect(f.comments[0].wiki).toContain('None. The plan found the story right as written.');
    expect((await P.getStoryBuildRow(ctx, 1, id))?.ticketReviewDoneAt).not.toBeNull();
  });

  it('not Jira: nothing is written and the step stays open', async () => {
    const id = await openedBuild({ endToEnd: true });
    const f = fakeDeps({ jira: false });
    const r = await E.runEndToEndTicketStep(ctx, 1, id, f.deps);
    expect(r).toMatchObject({ skipped: 'not_jira', commented: false, updated: [] });
    expect(f.writes).toHaveLength(0);
    expect(f.comments).toHaveLength(0);
    expect((await P.getStoryBuildRow(ctx, 1, id))?.ticketReviewDoneAt).toBeNull();
  });
});
