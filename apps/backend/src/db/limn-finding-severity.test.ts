// THE SEVERITY CHIP'S WIRE FIELD — `limnSeverity` on ThreadDetail / PrCommentDetail (getPrDetail),
// on a THROWAWAY sqlite DB. Pins:
//   1. a thread whose ROOT comment is a posted finding's stored comment id carries that finding's
//      severity; a reply's id never makes a thread Limn's;
//   2. an inline finding posted without a stored id (its read-back failed) is found by the shared
//      matcher, through a body that LEADS with the severity word;
//   3. a PR-level comment that is a finding's (or its reminder's) carries the severity;
//   4. praise, an unposted finding, another account's finding and every other thread / comment
//      carry none.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrDetail } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-limn-finding-severity-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const MARKER = '<!-- pierre:claude-review-finding v=1 -->';
const LOGIN = 'viewer-me';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let fold: typeof import('./limn-finding-severity.js');
let prId = 0;
const threadIds: Record<string, number> = {};
const prCommentIds: Record<string, number> = {};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  fold = await import('./limn-finding-severity.js');
  const { eq } = await import('drizzle-orm');
  const { accounts, users, repos, pullRequests, reviewThreads, reviewComments, prComments, claudeReviews, claudeReviewFindings } =
    schema;

  await db.update(accounts).set({ githubLogin: LOGIN }).where(eq(accounts.id, 1)).execute();
  const [me] = await db.insert(users).values({ githubLogin: LOGIN, githubNodeId: 'U_me', isBot: false }).returning().execute();
  const [bob] = await db.insert(users).values({ githubLogin: 'bob', githubNodeId: 'U_bob', isBot: false }).returning().execute();
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'sev', githubNodeId: 'R_sev', defaultBranch: 'main', defaultBranchName: 'main' })
    .returning()
    .execute();
  const now = Date.now();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_sev',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'sev',
      state: 'open',
      isDraft: false,
      authorId: bob.id,
      openedAt: new Date(now - 86_400_000),
      updatedAt: new Date(now),
    })
    .returning()
    .execute();
  prId = pr.id;

  let node = 0;
  const thread = async (key: string, path: string, line: number, comments: Array<{ db: string; author: number; body: string; at: number }>) => {
    const [t] = await db
      .insert(reviewThreads)
      .values({ githubNodeId: `T_${key}`, prId, path, line, isResolved: false, derivedState: 'untouched', createdAt: new Date(comments[0]!.at) })
      .returning()
      .execute();
    threadIds[key] = t.id;
    for (const c of comments) {
      await db
        .insert(reviewComments)
        .values({ githubNodeId: `C_${++node}`, threadId: t.id, prId, authorId: c.author, body: c.body, databaseId: c.db, createdAt: new Date(c.at) })
        .execute();
    }
  };
  const t0 = now - 3_600_000;
  // 1. by stored id: root 1001 is finding A's.
  await thread('byId', 'a.ts', 3, [
    { db: '1001', author: me.id, body: `**Blocker**\n\nNull deref.\n\n${MARKER}`, at: t0 },
    { db: '1002', author: bob.id, body: 'Fixed.', at: t0 + 1000 },
  ]);
  // 2. by the matcher: finding B posted inline with no stored id; its body leads with the label.
  await thread('matched', 'b.ts', 7, [{ db: '2001', author: me.id, body: `**Nit**\n\nRename this.\n\n${MARKER}`, at: t0 }]);
  // A thread whose REPLY id is a finding's: not Limn's thread.
  await thread('replyOnly', 'c.ts', 1, [
    { db: '3001', author: bob.id, body: 'Why?', at: t0 },
    { db: '3002', author: me.id, body: 'Because.', at: t0 + 1000 },
  ]);
  // Someone else's thread.
  await thread('other', 'd.ts', 2, [{ db: '4001', author: bob.id, body: 'Looks fine.', at: t0 }]);
  // A praise finding's thread (stored history) and another account's finding: no chip.
  await thread('praise', 'e.ts', 4, [{ db: '5001', author: me.id, body: `Nice.\n\n${MARKER}`, at: t0 }]);

  const prComment = async (key: string, dbId: string, author: number, body: string) => {
    const [c] = await db
      .insert(prComments)
      .values({ githubNodeId: `IC_${key}`, prId, authorId: author, body, databaseId: dbId, createdAt: new Date(t0) })
      .returning()
      .execute();
    prCommentIds[key] = c.id;
  };
  await prComment('finding', '9001', me.id, `**Question** · \`docs/x.md:12\`\n\nIs this right?\n\n${MARKER}`);
  await prComment('reminder', '9002', me.id, `**Blocker**\n\n**Reminder:** first raised earlier.\n\nNull deref.\n\n${MARKER}`);
  await prComment('plain', '9003', bob.id, 'LGTM');

  const [run] = await db.insert(claudeReviews).values({ accountId: 1, prId, headSha: 'H1', model: 'm', status: 'succeeded' }).returning().execute();
  const posted = new Date(t0);
  const finding = (o: Record<string, unknown>) => ({ reviewId: run.id, side: 'RIGHT', title: 't', included: true, ...o });
  await db
    .insert(claudeReviewFindings)
    .values([
      finding({
        path: 'a.ts', line: 3, severity: 'blocker', body: 'Null deref.', postedAt: posted, githubCommentId: '1001', postedCommentKind: 'inline',
        reminder: { githubCommentId: '9002', postedCommentKind: 'pr_comment', postedAt: posted.toISOString() },
      }),
      finding({ path: 'b.ts', line: 7, severity: 'nit', body: 'Rename this.', postedAt: posted, githubCommentId: null, postedCommentKind: 'inline' }),
      finding({ path: 'c.ts', line: 1, severity: 'warning', body: 'Because.', postedAt: posted, githubCommentId: '3002', postedCommentKind: 'inline' }),
      finding({ path: 'docs/x.md', line: 12, severity: 'question', body: 'Is this right?', postedAt: posted, githubCommentId: '9001', postedCommentKind: 'pr_comment' }),
      finding({ path: 'e.ts', line: 4, severity: 'praise', body: 'Nice.', postedAt: posted, githubCommentId: '5001', postedCommentKind: 'inline' }),
      // Not posted: never a chip, even with the same words as a thread.
      finding({ path: 'd.ts', line: 2, severity: 'blocker', body: 'Looks fine.', postedAt: null }),
    ])
    .execute();
  // Another account's run on the same PR id: its findings are never read.
  await db.insert(accounts).values({ id: 2, githubUserId: 'U_stranger', githubLogin: 'stranger', isLocal: false }).onConflictDoNothing().execute();
  const [foreign] = await db.insert(claudeReviews).values({ accountId: 2, prId, headSha: 'H1', model: 'm', status: 'succeeded' }).returning().execute();
  await db
    .insert(claudeReviewFindings)
    .values({ reviewId: foreign.id, side: 'RIGHT', title: 't', included: true, path: 'd.ts', line: 2, severity: 'warning', body: 'x', postedAt: posted, githubCommentId: '4001', postedCommentKind: 'inline' })
    .execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('limnSeverity on the PR detail payload', () => {
  it('marks exactly Limn’s posted findings, with the severity they were posted with', async () => {
    const d = (await q.getPrDetail(prId, 1)) as PrDetail;
    const byThread = new Map(d.threads.map((t) => [t.id, t.limnSeverity ?? null]));
    expect(byThread.get(threadIds.byId!)).toBe('blocker');
    expect(byThread.get(threadIds.matched!)).toBe('nit');
    expect(byThread.get(threadIds.replyOnly!)).toBeNull();
    expect(byThread.get(threadIds.other!)).toBeNull();
    expect(byThread.get(threadIds.praise!)).toBeNull();
    const byComment = new Map(d.comments.map((c) => [c.id, c.limnSeverity ?? null]));
    expect(byComment.get(prCommentIds.finding!)).toBe('question');
    expect(byComment.get(prCommentIds.reminder!)).toBe('blocker');
    expect(byComment.get(prCommentIds.plain!)).toBeNull();
  });
});

describe('the pure fold', () => {
  const f = (o: Partial<import('./limn-finding-severity.js').PostedFindingSeverityRow>) => ({
    id: 1, severity: 'warning' as const, path: 'a.ts', line: 1, body: 'B', editedBody: null,
    githubCommentId: null, postedCommentKind: null, reminder: null, ...o,
  });

  it('returns nothing without a posted finding, and never reads a reply as a root', () => {
    const empty = fold.limnSeverityTargets({ findings: [], threads: [], threadComments: [], prComments: [], accountLogin: 'me' });
    expect(empty.byThreadId.size + empty.byPrCommentId.size).toBe(0);
    const r = fold.limnSeverityTargets({
      findings: [f({ githubCommentId: '2', postedCommentKind: 'inline' })],
      threads: [{ id: 10, path: 'a.ts' }],
      threadComments: [
        { threadId: 10, databaseId: '1', body: 'root', authorLogin: 'bob', createdAt: 1 },
        { threadId: 10, databaseId: '2', body: 'reply', authorLogin: 'me', createdAt: 2 },
      ],
      prComments: [],
      accountLogin: 'me',
    });
    expect(r.byThreadId.size).toBe(0);
  });

  it('a stored inline id and a PR-level id are separate id spaces', () => {
    const r = fold.limnSeverityTargets({
      findings: [f({ githubCommentId: '7', postedCommentKind: 'pr_comment', severity: 'blocker' })],
      threads: [{ id: 10, path: 'a.ts' }],
      threadComments: [{ threadId: 10, databaseId: '7', body: 'x', authorLogin: 'me', createdAt: 1 }],
      prComments: [{ id: 50, databaseId: '7' }],
      accountLogin: 'me',
    });
    expect(r.byThreadId.size).toBe(0);
    expect(r.byPrCommentId.get(50)).toBe('blocker');
  });
});
