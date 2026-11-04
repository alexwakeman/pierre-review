// LIMN FINDINGS ARE NOT REVIEW THREADS (thread-judgements.ts `tabThreadView`; docs/CLAUDE-REVIEW.md
// § Limn findings are not review threads), over the REAL core client and migrations. A PR with a
// teammate's Limn finding thread (root stored under the `limn:` bot, `limn_posted_by_user_id` set)
// and a person's thread. What this pins:
//   1. The AI Review tab's DISPLAYED threads (`currentThreadAssessments`) and their counts list only
//      the person's thread; the STORED run keeps both judgements.
//   2. The teammate finding's state in Findings (`teamView.allFindings`) reflects the judgement of its
//      thread: `not_addressed` keeps it Open; `addressed` moves it to addressed, by "you", dated by
//      the run that judged it — a Check threads run newer than the review settles a teammate finding
//      posted AFTER that review.
//   3. Which threads are Limn findings: the ROOT decides (`limn_posted_by_user_id`, else the shared
//      `limnFindingPost(body, {threadRoot:true})`); a marker in a reply does not.
//
//   pnpm --filter @pierre-review/backend test limn-finding-threads
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeThreadAddressed, ClaudeThreadAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-review-limn-finding-threads.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const HEAD = 'd'.repeat(40);
const MARKER = '<!-- pierre:claude-review-finding v=1 -->';
const T0 = Math.floor(Date.now() / 1000) * 1000 - 10 * 3600_000; // whole seconds: SQLite stores seconds
const at = (h: number): Date => new Date(T0 + h * 3600_000);

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let judgements: typeof import('./thread-judgements.js');
let teamView: typeof import('./team-view.js');
let persist: typeof import('./persist.js');
let teammates: typeof import('../../db/teammate-reviews.js');
let robinId = 0;
let aliceId = 0;
let limnRobinId = 0;
let node = 1;

interface Seeded {
  prId: number;
  repoId: number;
  limnThread: number;
  personThread: number;
  teammateFindingId: number;
}

async function thread(prId: number, path: string, line: number, createdAt: Date): Promise<number> {
  return (
    await db
      .insert(schema.reviewThreads)
      .values({ githubNodeId: `RT_${node++}`, prId, path, line, isResolved: false, derivedState: 'untouched', createdAt })
      .returning()
      .execute()
  )[0].id;
}

async function comment(
  prId: number,
  threadId: number,
  authorId: number,
  body: string,
  createdAt: Date,
  limnPostedByUserId: number | null = null,
): Promise<string> {
  const nodeId = `RC_${node++}`;
  await db
    .insert(schema.reviewComments)
    .values({ githubNodeId: nodeId, threadId, prId, authorId, body, databaseId: String(node), createdAt, limnPostedByUserId })
    .execute();
  return nodeId;
}

/** A PR with Robin's Limn finding thread (posted at `teammateAt`) and Alice's own thread. */
async function seed(key: string, teammateAt: Date): Promise<Seeded> {
  const repoId = (
    await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: key, githubNodeId: `R_${key}` }).returning().execute()
  )[0].id;
  const prId = (
    await db
      .insert(schema.pullRequests)
      .values({ githubNodeId: `PR_${key}`, accountId: 1, repoId, number: 591, title: key, state: 'open', isDraft: false, openedAt: at(0), updatedAt: at(0), headSha: HEAD, authorId: aliceId })
      .returning()
      .execute()
  )[0].id;
  const limnThread = await thread(prId, 'src/db/schema-check.js', 76, teammateAt);
  const rootNode = await comment(prId, limnThread, limnRobinId, `**Warning**\n\nThe listener misses the 400 path.\n\n${MARKER}`, teammateAt, robinId);
  const personThread = await thread(prId, 'src/routes/x.js', 10, at(0.5));
  await comment(prId, personThread, aliceId, 'Please rename this.', at(0.5));
  // Robin's posted review, as the import stores it.
  const [r] = await db
    .insert(schema.claudeReviews)
    .values({
      accountId: 1, prId, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', provider: 'claude', trigger: 'auto',
      kind: 'teammate', sourceUserId: robinId, sourceReviewNodeId: `RV_${key}`, summary: 'One thing.', verdict: 'COMMENT',
      postedAt: teammateAt, finishedAt: teammateAt, createdAt: teammateAt,
    })
    .returning()
    .execute();
  const [f] = await db
    .insert(schema.claudeReviewFindings)
    .values({
      reviewId: r.id, path: 'src/db/schema-check.js', line: 76, side: 'RIGHT', severity: 'warning', title: 'The listener misses the 400 path',
      body: 'The listener misses the 400 path.', anchored: true, fileInDiff: true, included: false, postedAt: teammateAt,
      githubCommentId: `${prId}01`, postedCommentKind: 'inline', sourceCommentNodeId: rootNode, createdAt: teammateAt,
    })
    .returning()
    .execute();
  return { prId, repoId, limnThread, personThread, teammateFindingId: f.id };
}

function assessment(threadId: number, addressed: ClaudeThreadAddressed, authorLogin: string, authorIsBot: boolean): ClaudeThreadAssessment {
  return {
    ref: 'R1', threadId, sent: true, carried: false, authorLogin, authorIsBot, path: 'p', line: 1, resolved: false,
    excerpt: 'x', commentCount: 1, lastCommentAt: null, url: null, validity: 'valid', addressed,
    explanation: 'Checked.', reason: 'Checked.', draftReply: null, assessedAtHead: HEAD,
  };
}

/** The reader's own succeeded review, finished at `finishedAt`, judging both threads. */
async function ownReview(s: Seeded, finishedAt: Date, limn: ClaudeThreadAddressed): Promise<number> {
  return (
    await db
      .insert(schema.claudeReviews)
      .values({
        accountId: 1, prId: s.prId, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', provider: 'claude', trigger: 'manual',
        summary: 'Mine.', verdict: 'COMMENT', createdAt: new Date(finishedAt.getTime() - 60_000), finishedAt,
        threadAssessments: [assessment(s.limnThread, limn, 'robin-dev', true), assessment(s.personThread, 'not_addressed', 'alice-dev', false)],
      })
      .returning()
      .execute()
  )[0].id;
}

async function check(s: Seeded, startedAt: Date, completedAt: Date, limn: ClaudeThreadAddressed): Promise<void> {
  await db
    .insert(schema.claudeThreadChecks)
    .values({
      accountId: 1, workspaceId: 0, prId: s.prId, repoId: s.repoId, headSha: HEAD, status: 'succeeded', model: 'claude-sonnet-5',
      provider: 'claude', createdAt: startedAt, startedAt, completedAt,
      threadAssessments: [assessment(s.limnThread, limn, 'robin-dev', true), assessment(s.personThread, 'not_addressed', 'alice-dev', false)],
    })
    .execute();
}

/** The route's composition (`GET /api/prs/:id/claude-review`): displayed threads + the team fold. */
async function tab(prId: number) {
  const threads = await judgements.tabThreadView(ctx, 1, prId);
  const latest = await persist.getLatestClaudeReview(ctx, prId, 1);
  const mates = await teammates.listTeammateReviews(db, 1, prId);
  const view = await teamView.loadTeamReviewView(db, 1, prId, latest, mates, threads.team);
  return { threads, latest, view };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
  } as any as AgentContext;
  judgements = await import('./thread-judgements.js');
  teamView = await import('./team-view.js');
  persist = await import('./persist.js');
  teammates = await import('../../db/teammate-reviews.js');
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_viewer-me', githubLogin: 'viewer-me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'viewer-me' } })
    .execute();
  robinId = (await db.insert(schema.users).values({ githubLogin: 'robin-dev', githubNodeId: 'U_robin' }).returning().execute())[0].id;
  aliceId = (await db.insert(schema.users).values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice' }).returning().execute())[0].id;
  limnRobinId = (
    await db
      .insert(schema.users)
      .values({ githubLogin: 'limn:robin-dev', githubNodeId: null, displayName: 'Limn · robin-dev', isBot: true, isBotOverridden: true })
      .returning()
      .execute()
  )[0].id;
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe("a teammate's Limn finding thread", () => {
  it('is left out of the displayed threads and their counts; judged not addressed, its finding stays Open', async () => {
    const s = await seed('open', at(1));
    await ownReview(s, at(2), 'not_addressed');
    const { threads, latest, view } = await tab(s.prId);

    expect([...threads.limnFindingThreads]).toEqual([s.limnThread]);
    expect(threads.shown.items!.map((a) => a.threadId)).toEqual([s.personThread]);
    expect(threads.shown.counts).toMatchObject({ total: 1, assessed: 1, validUnaddressed: 1 });
    // The stored run keeps both judgements (AI Fix and the team fold read them).
    expect(latest!.threadAssessments!.map((a) => a.threadId).sort()).toEqual([s.limnThread, s.personThread].sort());
    // The route's run copy leaves it out too.
    expect(judgements.shownThreadsWire(latest!.threadAssessments, threads.limnFindingThreads).items!.map((a) => a.threadId)).toEqual([
      s.personThread,
    ]);
    // The team fold still reads it: the finding is Open, by Robin.
    const point = view.allFindings!.find((p) => p.findingId === s.teammateFindingId)!;
    expect(point.origin).toBe('teammate');
    expect(point.threadId).toBe(s.limnThread);
    expect(point.state).toEqual({ kind: 'open' });
  });

  it('judged addressed: its finding moves to addressed, by you, dated by the review', async () => {
    const s = await seed('addressed', at(1));
    const reviewId = await ownReview(s, at(2), 'addressed');
    const { threads, view } = await tab(s.prId);
    expect(threads.shown.items!.map((a) => a.threadId)).toEqual([s.personThread]);
    const point = view.allFindings!.find((p) => p.findingId === s.teammateFindingId)!;
    expect(point.state).toEqual({ kind: 'addressed', by: { you: true, poster: null }, at: at(2).toISOString(), reviewId });
  });

  it('posted AFTER the review: a later Check threads run settles it, dated by the check', async () => {
    const s = await seed('later', at(3));
    // The review ran before the teammate posted, so it never judged that thread.
    const reviewId = await db
      .insert(schema.claudeReviews)
      .values({
        accountId: 1, prId: s.prId, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', provider: 'claude', trigger: 'manual',
        summary: 'Mine.', verdict: 'COMMENT', createdAt: at(1.5), finishedAt: at(2),
        threadAssessments: [assessment(s.personThread, 'not_addressed', 'alice-dev', false)],
      })
      .returning()
      .execute()
      .then((r: any[]) => r[0].id);
    await check(s, at(4), at(4.1), 'not_addressed');
    let point = (await tab(s.prId)).view.allFindings!.find((p) => p.findingId === s.teammateFindingId)!;
    expect(point.state).toEqual({ kind: 'open' });

    await check(s, at(5), at(5.1), 'addressed');
    const { threads, view } = await tab(s.prId);
    expect(threads.shown.items!.map((a) => a.threadId)).toEqual([s.personThread]);
    expect(threads.shown.counts!.total).toBe(1);
    point = view.allFindings!.find((p) => p.findingId === s.teammateFindingId)!;
    expect(point.state).toEqual({ kind: 'addressed', by: { you: true, poster: null }, at: at(5.1).toISOString(), reviewId });
  });
});

describe('which threads are Limn findings (the ROOT decides)', () => {
  it('a root with the marker and a lead counts even when sync stored no poster; a marker in a reply does not', async () => {
    const s = await seed('roots', at(1));
    const legacy = await thread(s.prId, 'src/a.js', 3, at(1));
    await comment(s.prId, legacy, robinId, `**Nit**\n\nRename.\n\n${MARKER}`, at(1));
    const reply = await thread(s.prId, 'src/b.js', 4, at(1));
    await comment(s.prId, reply, aliceId, 'Is this right?', at(1));
    await comment(s.prId, reply, limnRobinId, `**Warning**\n\nNo.\n\n${MARKER}`, at(2), robinId);
    const ids = (await judgements.limnFindingThreadIdsForPrs(ctx, 1, [s.prId])).get(s.prId)!;
    expect([...ids].sort((a, b) => a - b)).toEqual([s.limnThread, legacy].sort((a, b) => a - b));
    // Another account reads nothing.
    expect((await judgements.limnFindingThreadIdsForPrs(ctx, 2, [s.prId])).size).toBe(0);
  });
});
