// LIMN FINDINGS ARE BOTS (docs/CLAUDE-REVIEW.md § Limn findings are bots). Throwaway sqlite; the
// real persistPr and the real boot reconcile, no GitHub.
//
// What this pins:
//   1. Sync stores a Limn finding (inline root, PR-level, reminder) under the poster's `limn:` bot,
//      with the poster in `limn_posted_by_user_id`; the thread root and the event actor follow.
//      A reply on the thread stays the person's — unless it carries a Limn marker (a pushback, an
//      acknowledgement / resolve reply, a "Still open:" reply): that is Limn's words, under the same
//      bot (gap 1, docs/TEAM-REVIEW.md § 8).
//   2. A re-sync with the marker edited away gives the comment back to its person.
//   3. Two posters are two bots, each with a 'review' row in the repo's workspace.
//   4. "Is this my own post" still reads the TRUE poster (isLimnPostedComment via the loaders), so
//      the reader's own finding never counts as new activity and a teammate's does.
//   5. The boot reconcile re-attributes stored rows and is idempotent.
//   6. The bulk bot-thread resolve never offers a Limn finding thread; the synthetic users are in
//      the global automation set.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-upsert-limn-attribution-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('./upsert.js');
let limnBots: typeof import('../db/limn-bots.js');
let repoId = 0;
let workspaceId = 0;

const MARK = '<!-- pierre:claude-review-finding v=1 -->';
const ALICE = { login: 'alice-dev', id: 'U_alice', __typename: 'User' };
const BOB = { login: 'bob-dev', id: 'U_bob', __typename: 'User' };
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' };

function comment(id: string, author: any, body: string, at: string): any {
  return { id, fullDatabaseId: id.replace(/\D/g, '') || null, body, createdAt: at, diffHunk: null, author };
}

function thread(id: string, comments: any[], over: Record<string, unknown> = {}): any {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    path: 'src/x.ts',
    line: 12,
    resolvedBy: null,
    comments: { nodes: comments },
    ...over,
  };
}

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_limn_${n}`,
    number: n,
    title: 'Parser fix',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-10-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-10-02T00:00:00Z',
    url: `https://github.com/acme/limn/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'fix',
    mergeable: null,
    mergeStateStatus: null,
    author: CAROL,
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [] },
    ...over,
  } as unknown as GqlPullRequest;
}

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

async function userId(login: string): Promise<number | null> {
  const { eq } = await import('drizzle-orm');
  const r = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.githubLogin, login)).execute();
  return r[0]?.id ?? null;
}

async function rc(nodeId: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.reviewComments).where(eq(schema.reviewComments.githubNodeId, nodeId)).execute())[0];
}

async function pc(nodeId: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.prComments).where(eq(schema.prComments.githubNodeId, nodeId)).execute())[0];
}

async function threadRow(nodeId: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.reviewThreads).where(eq(schema.reviewThreads.githubNodeId, nodeId)).execute())[0];
}

async function eventActor(key: string): Promise<number | null> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.events).where(eq(schema.events.dedupeKey, key)).execute())[0]?.actorId ?? null;
}

const FINDING = `**Warning**\n\nThis can throw on an empty list.\n\n${MARK}`;
const PR_LEVEL = `**Blocker** · \`src/y.ts:4\`\n\nThe lock is never released.\n\n${MARK}`;
const REMINDER = `**Reminder:** first raised on 2 Oct 2026.\n\nStill open.\n\n${MARK}`;
const REPLY = `Fixed in the next commit, thanks.\n\n${MARK}`;
const PUSHBACK = `Thanks for the reply. I still think this needs changing in this pull request.\n\n_Posted automatically by Limn’s Claude review._\n\n<!-- pierre:claude-review-pushback v=1 -->`;
const RESOLVE_REPLY = `Addressed in abc1234.\n\n_Resolved by Limn’s Claude review._\n\n${MARK}`;
const STILL_OPEN = `**Still open:** The null case is still not handled.\n\n${MARK}\n<!-- pierre:claude-review-still-open v=1 h=abc1234 -->`;
// A person quoting a Limn comment: the marker sits only on a quoted line, so it stays theirs.
const QUOTED = `> Addressed in abc1234.\n> ${MARK}\n\nNo, it isn't.`;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('./upsert.js');
  limnBots = await import('../db/limn-bots.js');
  const { eq } = await import('drizzle-orm');
  await db.update(schema.accounts).set({ githubLogin: 'alice-dev' }).where(eq(schema.accounts.id, 1)).execute();
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'limn', githubNodeId: 'R_limn_1' })
    .returning()
    .execute();
  repoId = r.id;
  const queries = await import('../db/queries.js');
  workspaceId = await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('persistPr — Limn findings are bots', () => {
  it('stores findings and Limn-marked replies under the poster\'s limn: bot, keeps typed replies with the person', async () => {
    await persist(
      gqlPr(1, {
        reviewThreads: {
          nodes: [
            thread('T_1', [
              comment('C_101', ALICE, FINDING, '2026-10-02T10:00:00Z'),
              comment('C_102', CAROL, 'Good catch.', '2026-10-02T11:00:00Z'),
              comment('C_103', ALICE, REPLY, '2026-10-02T12:00:00Z'),
              // A typed reply that happens to open with a lead is still a reply, never a finding.
              comment('C_104', ALICE, `**Nit**\n\nAgreed, renamed.\n\n${MARK}`, '2026-10-02T13:00:00Z'),
              comment('C_105', ALICE, PUSHBACK, '2026-10-02T14:00:00Z'),
              comment('C_106', ALICE, RESOLVE_REPLY, '2026-10-02T15:00:00Z'),
              comment('C_107', CAROL, QUOTED, '2026-10-02T16:00:00Z'),
            ]),
            thread('T_3', [
              comment('C_301', CAROL, 'Please handle null.', '2026-10-02T10:40:00Z'),
              comment('C_302', BOB, STILL_OPEN, '2026-10-02T10:50:00Z'),
            ]),
            thread('T_2', [comment('C_201', BOB, `**Nit** · Codex\n\nName this better.\n\n${MARK}`, '2026-10-02T10:30:00Z')]),
          ],
        },
        comments: {
          nodes: [
            comment('IC_301', ALICE, PR_LEVEL, '2026-10-02T10:05:00Z'),
            comment('IC_302', ALICE, REMINDER, '2026-10-02T10:06:00Z'),
            comment('IC_303', ALICE, 'Plain words from alice.', '2026-10-02T10:07:00Z'),
          ],
        },
      } as any),
    );
    const alice = await userId('alice-dev');
    const aliceBot = await userId('limn:alice-dev');
    const bobBot = await userId('limn:bob-dev');
    expect(alice).not.toBeNull();
    expect(aliceBot).not.toBeNull();
    expect(bobBot).not.toBeNull();
    expect(aliceBot).not.toBe(bobBot);

    const root = await rc('C_101');
    expect(root.authorId).toBe(aliceBot);
    expect(root.limnPostedByUserId).toBe(alice);
    // Limn's replies (gap 1): the finding-marked reply, a lead on a reply (never a finding, but
    // Limn's words), the pushback, the resolve reply — all under alice's bot, poster kept.
    for (const id of ['C_103', 'C_104', 'C_105', 'C_106']) {
      expect((await rc(id)).authorId).toBe(aliceBot);
      expect((await rc(id)).limnPostedByUserId).toBe(alice);
    }
    // A teammate's "Still open:" on carol's thread is bob's Limn; carol's quote stays carol's.
    expect((await rc('C_302')).authorId).toBe(bobBot);
    expect((await rc('C_302')).limnPostedByUserId).toBe(await userId('bob-dev'));
    expect((await rc('C_107')).authorId).toBe(await userId('carol-dev'));
    expect((await rc('C_107')).limnPostedByUserId).toBeNull();
    // A reply never moves a thread's root author: T_3 is still carol's.
    expect((await threadRow('T_3')).originalCommenterId).toBe(await userId('carol-dev'));
    // …and the thread state: Limn's "Still open:" is not a reply.
    expect((await threadRow('T_3')).derivedState).toBe('untouched');
    expect((await rc('C_201')).authorId).toBe(bobBot);

    expect((await pc('IC_301')).authorId).toBe(aliceBot);
    expect((await pc('IC_302')).authorId).toBe(aliceBot);
    expect((await pc('IC_302')).limnPostedByUserId).toBe(alice);
    expect((await pc('IC_303')).authorId).toBe(alice);

    expect((await threadRow('T_1')).originalCommenterId).toBe(aliceBot);
    expect(await eventActor('review_comment:C_101')).toBe(aliceBot);
    expect(await eventActor('pr_comment:IC_301')).toBe(aliceBot);
    expect(await eventActor('review_comment:C_103')).toBe(aliceBot);
    expect(await eventActor('review_comment:C_107')).toBe(await userId('carol-dev'));

    const { eq } = await import('drizzle-orm');
    const bot = (await db.select().from(schema.users).where(eq(schema.users.id, aliceBot)).execute())[0];
    expect(bot.isBot).toBe(true);
    expect(bot.isBotOverridden).toBe(true);
    expect(bot.githubNodeId).toBeNull();
    expect(bot.displayName).toBe('Limn · alice-dev');
  });

  it('gives each bot a review row in the repo\'s workspace', async () => {
    const { and, eq } = await import('drizzle-orm');
    for (const login of ['limn:alice-dev', 'limn:bob-dev']) {
      const id = await userId(login);
      const rows = await db
        .select()
        .from(schema.workspaceReviewers)
        .where(and(eq(schema.workspaceReviewers.authorUserId, id), eq(schema.workspaceReviewers.workspaceId, workspaceId)))
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].automated).toBe(true);
      expect(rows[0].role).toBe('review');
      expect(rows[0].kind).toBe('pierre');
      expect(rows[0].label).toBe(`Limn · ${login.slice(5)}`);
      expect(rows[0].identitySource).toBe('auto');
    }
  });

  it('the own-post checks still read the true poster', async () => {
    const { newestReviewCommentTimes, loadReviewThreadsForReview } = await import('../db/review-threads-for-review.js');
    const { eq } = await import('drizzle-orm');
    const pr = (await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, 'PR_limn_1')).execute())[0];
    const times = await newestReviewCommentTimes(1, [pr.id], new Date('2026-10-01T00:00:00Z'));
    // Alice's own finding and her Limn's replies are not new activity, nor bob's Limn "Still open:"
    // (10:50, a Limn reply never moves the trigger); carol's replies are — her quote (16:00) newest.
    expect(times.get(pr.id)!.newest.toISOString()).toBe('2026-10-02T16:00:00.000Z');
    // `countsAuthor` sees the ATTRIBUTED id: bob's finding counts as his Limn bot's.
    const bobBot = await userId('limn:bob-dev');
    const botsOnly = await newestReviewCommentTimes(1, [pr.id], new Date('2026-10-01T00:00:00Z'), (id) => id === bobBot);
    expect(botsOnly.get(pr.id)!.newest.toISOString()).toBe('2026-10-02T10:30:00.000Z');
    const loaded = await loadReviewThreadsForReview(1, pr.id, (id) => id === bobBot);
    // T_1 is rooted on alice's own finding (the follow-up's); T_2 is bob's and T_3 carol's, sent to
    // the review. Bob's "Still open:" in T_3 is context, never the trigger: only his finding counts.
    expect(loaded.ownThreadCount).toBe(1);
    expect(loaded.newestCommentAt?.toISOString()).toBe('2026-10-02T10:30:00.000Z');
    const t2 = loaded.threads.find((x) => x.comments[0]!.authorLogin === 'bob-dev')!;
    expect(t2.comments[0]!.authorIsBot).toBe(true);
    const t3 = loaded.threads.find((x) => x.comments[0]!.authorLogin === 'carol-dev')!;
    expect(t3.comments.map((c) => c.authorIsBot)).toEqual([false, true]);
  });

  it('the synthetic users are in the global automation set', async () => {
    const { globalAutomationUserIds } = await import('../db/automation-ids.js');
    const set = await globalAutomationUserIds();
    expect(set.has((await userId('limn:alice-dev'))!)).toBe(true);
    expect(set.has((await userId('alice-dev'))!)).toBe(false);
  });

  it('the bulk bot-thread resolve never offers a Limn finding thread', async () => {
    const { eq } = await import('drizzle-orm');
    const { getResolvableBotThreads } = await import('../db/queries.js');
    await db.update(schema.reviewThreads).set({ derivedState: 'likely_addressed' }).where(eq(schema.reviewThreads.githubNodeId, 'T_2')).execute();
    const pr = (await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, 'PR_limn_1')).execute())[0];
    const t2 = await threadRow('T_2');
    expect(await getResolvableBotThreads(pr.id, 1, [t2.id])).toEqual([]);
  });

  it('a body edited to drop the marker goes back to its person on the next walk', async () => {
    await persist(
      gqlPr(1, {
        reviewThreads: {
          nodes: [
            thread('T_1', [
              comment('C_101', ALICE, 'This can throw on an empty list.', '2026-10-02T10:00:00Z'),
              comment('C_102', CAROL, 'Good catch.', '2026-10-02T11:00:00Z'),
            ]),
          ],
        },
        comments: { nodes: [comment('IC_301', ALICE, 'The lock is never released.', '2026-10-02T10:05:00Z')] },
      } as any),
    );
    const alice = await userId('alice-dev');
    expect((await rc('C_101')).authorId).toBe(alice);
    expect((await rc('C_101')).limnPostedByUserId).toBeNull();
    expect((await pc('IC_301')).authorId).toBe(alice);
    expect((await threadRow('T_1')).originalCommenterId).toBe(alice);
    expect(await eventActor('review_comment:C_101')).toBe(alice);
  });
});

describe('reconcileLimnFindingAuthors', () => {
  it('re-attributes stored rows, then writes nothing on a second run', async () => {
    const { eq } = await import('drizzle-orm');
    // Put C_201 (bob's finding) back under bob, as a pre-feature row would be stored.
    const bob = await userId('bob-dev');
    const bobBot = await userId('limn:bob-dev');
    const row = await rc('C_201');
    await db.update(schema.reviewComments).set({ authorId: bob, limnPostedByUserId: null }).where(eq(schema.reviewComments.id, row.id)).execute();
    await db.update(schema.reviewThreads).set({ originalCommenterId: bob }).where(eq(schema.reviewThreads.githubNodeId, 'T_2')).execute();
    await db.update(schema.events).set({ actorId: bob }).where(eq(schema.events.dedupeKey, 'review_comment:C_201')).execute();
    // A typed reply wrongly stored under a Limn bot goes back to its person (no Limn marker).
    const alice = await userId('alice-dev');
    const aliceBot = await userId('limn:alice-dev');
    const carolId = await userId('carol-dev');
    const plainRow = await rc('C_102');
    await db.update(schema.reviewComments).set({ authorId: aliceBot, limnPostedByUserId: carolId }).where(eq(schema.reviewComments.id, plainRow.id)).execute();
    // A Limn pushback stored as the person (before gap 1) joins the bot.
    const pushRow = await rc('C_105');
    await db.update(schema.reviewComments).set({ authorId: alice, limnPostedByUserId: null }).where(eq(schema.reviewComments.id, pushRow.id)).execute();
    await db.update(schema.events).set({ actorId: alice }).where(eq(schema.events.dedupeKey, 'review_comment:C_105')).execute();
    // And a human wrongly classed as Limn by an older classifier.
    const carol = await userId('carol-dev');
    await db
      .insert(schema.workspaceReviewers)
      .values({ accountId: 1, workspaceId, authorUserId: carol, automated: true, role: 'review', confidence: 'high', source: 'fingerprint', kind: 'pierre', label: 'Limn · Claude' })
      .execute();

    const first = await limnBots.reconcileLimnFindingAuthors(1);
    expect(first.comments).toBe(3);
    expect((await rc('C_102')).authorId).toBe(carolId);
    expect((await rc('C_102')).limnPostedByUserId).toBeNull();
    expect((await rc('C_105')).authorId).toBe(aliceBot);
    expect((await rc('C_105')).limnPostedByUserId).toBe(alice);
    expect(await eventActor('review_comment:C_105')).toBe(aliceBot);
    expect(first.threads).toBe(1);
    expect(first.repairedReviewerRows).toBe(1);
    expect((await rc('C_201')).authorId).toBe(bobBot);
    expect((await rc('C_201')).limnPostedByUserId).toBe(bob);
    expect((await threadRow('T_2')).originalCommenterId).toBe(bobBot);
    expect(await eventActor('review_comment:C_201')).toBe(bobBot);

    const second = await limnBots.reconcileLimnFindingAuthors(1);
    expect(second).toEqual({ comments: 0, threads: 0, repairedReviewerRows: 0 });
    // The Limn bots' own rows are never "repaired" away.
    const { and } = await import('drizzle-orm');
    const kept = await db
      .select()
      .from(schema.workspaceReviewers)
      .where(and(eq(schema.workspaceReviewers.authorUserId, bobBot), eq(schema.workspaceReviewers.kind, 'pierre')))
      .execute();
    expect(kept).toHaveLength(1);
  });
});
