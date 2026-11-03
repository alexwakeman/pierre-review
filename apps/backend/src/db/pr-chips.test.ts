// THE PR CHIPS on a THROWAWAY sqlite DB (docs/FRONTEND.md § PR chips): the stack and the criteria
// as `prChipsFor` reads them, the arm/watcher question (`openStackParentFor`), and the agreement the
// merge verdict depends on — a stacked PR is never a "merge" card.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, TicketAssessment } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-pr-chips-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let chips: typeof import('./pr-chips.js');
let stacks: typeof import('./pr-stacks.js');

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const ids = new Map<string, number>();
let repoId = 0;
let otherRepoId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  chips = await import('./pr-chips.js');
  stacks = await import('./pr-stacks.js');
  const { repos, pullRequests, events, users, ticketReviews, ticketReviewMembers } = schema;

  const [u] = await db.insert(users).values({ githubLogin: 'alice', githubNodeId: 'U_alice' }).returning().execute();
  const mkRepo = async (name: string): Promise<number> =>
    (
      await db
        .insert(repos)
        .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_${name}`, defaultBranch: 'main', viewerPermission: 'WRITE', createdAt: new Date(now - 30 * DAY) })
        .returning()
        .execute()
    )[0].id;
  repoId = await mkRepo('api');
  otherRepoId = await mkRepo('web');

  let n = 1;
  const mkPr = async (key: string, values: Record<string, unknown>, rid = repoId): Promise<void> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_${key}`,
        accountId: 1,
        repoId: rid,
        number: n++,
        title: key,
        authorId: u.id,
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - 5 * DAY),
        updatedAt: new Date(now - DAY),
        lastCommitAt: new Date(now - DAY),
        ciStatus: 'success',
        mergeable: 'mergeable',
        mergeStateStatus: 'clean',
        isCrossRepository: false,
        ...values,
      })
      .returning()
      .execute();
    ids.set(key, pr.id);
    // getWorkspaceInsights' open-PR population needs a real activity event.
    await db
      .insert(events)
      .values({ accountId: 1, repoId: rid, prId: pr.id, actorId: u.id, type: 'commit_pushed', occurredAt: new Date(now - DAY), dedupeKey: `ev_${key}` })
      .execute();
  };
  await mkPr('bottom', { headRefName: 'one', baseRefName: 'main', headSha: 'h-bottom' });
  await mkPr('middle', { headRefName: 'two', baseRefName: 'one', headSha: 'h-middle' });
  await mkPr('top', { headRefName: 'three', baseRefName: 'two', headSha: 'h-top-new' });
  await mkPr('fork', { headRefName: 'feature', baseRefName: 'main', isCrossRepository: true });
  await mkPr('on-fork-name', { headRefName: 'x', baseRefName: 'feature' });
  await mkPr('elsewhere', { headRefName: 'y', baseRefName: 'one' }, otherRepoId);

  // A succeeded ticket review that read #top at an OLDER head, 3 of 4 met; an older run of the same
  // ticket (ignored); and a failed newer run (ignored).
  const assessment = (statuses: string[]): TicketAssessment =>
    ({
      alignment: 'partly_aligned',
      summary: null,
      criteria: statuses.map((status, i) => ({ ref: `AC${i + 1}`, index: i, text: `c${i}`, status, explanation: null, deliveredBy: [], evidence: [], expectedIn: null })),
      missing: [],
      notRequested: [],
    }) as TicketAssessment;
  const mkRun = async (status: string, a: TicketAssessment | null, head: string): Promise<void> => {
    const [r] = await db
      .insert(ticketReviews)
      .values({ accountId: 1, workspaceId: 1, ticketIdent: 'jira:x#ACME-7', ticketKey: 'ACME-7', ticketTitle: 'Story', status, model: 'm', assessment: a, completedAt: new Date(now - DAY) })
      .returning()
      .execute();
    await db.insert(ticketReviewMembers).values({ ticketReviewId: r.id, accountId: 1, prId: ids.get('top'), repoId, headSha: head, prState: 'open' }).execute();
  };
  await mkRun('succeeded', assessment(['met', 'not_met']), 'h-top-new');
  await mkRun('succeeded', assessment(['met', 'met', 'met', 'partly_met']), 'h-top-old');
  await mkRun('failed', null, 'h-top-new');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('prChipsFor', () => {
  it('derives the 3-PR stack, and no stack across a fork or another repo', async () => {
    const all = [...ids.entries()].map(([k, id]) => ({ id, repoId: k === 'elsewhere' ? otherRepoId : repoId }));
    const got = await chips.prChipsFor(1, all);
    const pos = (k: string) => got.get(ids.get(k)!)?.branchStack;
    expect(pos('bottom')).toMatchObject({ position: 1, parent: null });
    expect(pos('middle')).toMatchObject({ position: 2, parent: { prId: ids.get('bottom') } });
    expect(pos('top')).toMatchObject({ position: 3, parent: { prId: ids.get('middle') } });
    expect(pos('top')!.chain).toHaveLength(3);
    expect(pos('fork')).toBeNull();
    expect(pos('on-fork-name')).toBeNull();
    expect(pos('elsewhere')).toBeNull();
  });

  it('criteria: the newest SUCCEEDED run of the ticket covering the PR, its head compared', async () => {
    const got = await chips.prChipsFor(1, [{ id: ids.get('top')!, repoId }, { id: ids.get('bottom')!, repoId }]);
    expect(got.get(ids.get('top')!)!.criteria).toEqual([
      expect.objectContaining({ key: 'ACME-7', met: 3, total: 4, partlyMet: 1, notMet: 0, olderHead: true }),
    ]);
    expect(got.get(ids.get('bottom')!)!.criteria).toEqual([]);
  });

  it('another account sees none of it', async () => {
    const got = await chips.prChipsFor(2, [{ id: ids.get('top')!, repoId }]);
    expect(got.get(ids.get('top')!)).toEqual({ branchStack: null, criteria: [] });
  });
});

describe('openStackParentFor — the arm route and the watcher', () => {
  it('names the open PR whose branch the LIVE base is; null for the default branch', async () => {
    expect(await stacks.openStackParentFor(1, ids.get('middle')!, 'one')).toMatchObject({ prId: ids.get('bottom') });
    expect(await stacks.openStackParentFor(1, ids.get('bottom')!, 'main')).toBeNull();
    // A retarget seen live wins over the synced base.
    expect(await stacks.openStackParentFor(1, ids.get('middle')!, 'main')).toBeNull();
    expect(await stacks.openStackParentFor(2, ids.get('middle')!, 'one')).toBeNull();
  });
});

describe('the merge cards agree with mergeVerdict', () => {
  it('a stacked PR is never a "merge" card; the bottom of the stack is', async () => {
    const scope = await q.resolveWorkspaceScope(1, null);
    const insights = await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true });
    const merge = new Set(
      (insights.cards as InsightCard[]).filter((c) => c.kind === 'merge').map((c) => (c as { prId: number }).prId),
    );
    expect(merge.has(ids.get('bottom')!)).toBe(true);
    expect(merge.has(ids.get('middle')!)).toBe(false);
    expect(merge.has(ids.get('top')!)).toBe(false);
  });
});
