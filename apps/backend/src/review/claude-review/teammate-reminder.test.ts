// A REMINDER OF A TEAMMATE'S FINDING (teammate-reminder.ts; docs/CLAUDE-REVIEW.md § Teammates' reviews
// → A reminder of a teammate's finding). Throwaway sqlite; the real persistPr + import; the GitHub
// seam (`ctx.review.postFinding`) is a fake that records what it was asked to post.
//
// What this pins:
//   1. An OPEN teammate finding: ONE post, as the reader (through the reader's own seam), led by the
//      reminder line linking the teammate's comment, inline on the thread's current line at the PR's
//      synced head; recorded beside the finding (`reminder`) and served on the point.
//   2. Refused, nothing posted: an unknown id, another account's, the reader's own finding, a point
//      resolved on GitHub.
//   3. An outdated thread posts a PR-level comment; a moved head posts nothing and records nothing.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { limnReviewMarker } from '@pierre-review/shared';
import type { GqlPullRequest } from '../../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-teammate-reminder-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('../../sync/upsert.js');
let reminder: typeof import('./teammate-reminder.js');
let repoId = 0;

const MARK = '<!-- pierre:claude-review-finding v=1 -->';
const ROBIN = { login: 'robin-dev', id: 'U_robin', __typename: 'User' };
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' };
const HEAD = 'b'.repeat(40);

const postFinding = vi.fn(async (_args: any): Promise<any> => ({ commentId: '9001', postedCommentKind: 'inline' }));

function ctx(): any {
  return { db, schema, review: { postFinding } };
}

function comment(id: string, author: any, body: string, at: string): any {
  return { id, fullDatabaseId: id.replace(/\D/g, '') || null, body, createdAt: at, diffHunk: null, author };
}

function gqlPr(n: number, threadOver: Record<string, unknown> = {}): GqlPullRequest {
  const summary = `Fix these.\n\n${limnReviewMarker('aa11', {
    headSha: HEAD,
    run: 'manual',
    pair: false,
    runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: null }],
    verdict: 'COMMENT',
    limnVersion: '0.1.180',
  })}`;
  return {
    id: `PR_rm_${n}`,
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
    url: `https://github.com/acme/rm/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'fix',
    mergeable: null,
    mergeStateStatus: null,
    author: CAROL,
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [{ id: `RV_${n}01`, fullDatabaseId: `${n}01`, state: 'COMMENTED', body: summary, submittedAt: '2026-10-02T10:00:00Z', author: ROBIN }] },
    reviewThreads: {
      nodes: [
        {
          id: `T_${n}`,
          isResolved: false,
          isOutdated: false,
          isCollapsed: false,
          path: 'src/x.ts',
          line: 14,
          resolvedBy: null,
          comments: {
            nodes: [
              comment(
                `C_${n}101`,
                ROBIN,
                `**Warning**\n\nThis can throw on an empty list. Guard it.\n\n\`\`\`suggestion\nif (!xs.length) return;\n\`\`\`\n\n${MARK}`,
                '2026-10-02T10:00:00Z',
              ),
            ],
          },
          ...threadOver,
        },
      ],
    },
    comments: { nodes: [] },
    commits: { nodes: [] },
  } as unknown as GqlPullRequest;
}

async function seedPr(n: number, threadOver: Record<string, unknown> = {}): Promise<{ prId: number; findingId: number }> {
  const { and, eq } = await import('drizzle-orm');
  await upsert.persistPr(gqlPr(n, threadOver), repoId, upsert.createUserResolver(), new Map(), 1);
  const prId = (await db.select({ id: schema.pullRequests.id }).from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, `PR_rm_${n}`)).execute())[0].id;
  await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
  const [tm] = await db
    .select({ id: schema.claudeReviews.id })
    .from(schema.claudeReviews)
    .where(and(eq(schema.claudeReviews.prId, prId), eq(schema.claudeReviews.kind, 'teammate')))
    .execute();
  const [f] = await db.select({ id: schema.claudeReviewFindings.id }).from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, tm.id)).execute();
  return { prId, findingId: f.id };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('../../sync/upsert.js');
  reminder = await import('./teammate-reminder.js');
  const queries = await import('../../db/queries.js');
  const { eq } = await import('drizzle-orm');
  await db.update(schema.accounts).set({ githubLogin: 'alice-dev' }).where(eq(schema.accounts.id, 1)).execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'rm', githubNodeId: 'R_rm_1' }).returning().execute();
  repoId = r.id;
  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => postFinding.mockClear());

describe("a reminder of a teammate's finding", () => {
  it('posts ONCE as the reader, linking the original, inline on the current line; recorded and served', async () => {
    const { prId, findingId } = await seedPr(1);
    const { listTeammateReviews } = await import('../../db/teammate-reviews.js');
    const { loadTeamReviewView } = await import('./team-view.js');
    const before = await loadTeamReviewView(db, 1, prId, null, await listTeammateReviews(db, 1, prId), null);
    const p0 = before.allFindings!.find((p) => p.findingId === findingId)!;
    // The shared card's fields: title + body + suggestion split, posted time, comment, anchor.
    expect(p0).toMatchObject({
      origin: 'teammate',
      title: 'This can throw on an empty list.',
      body: 'Guard it.',
      suggestion: 'if (!xs.length) return;',
      postedAt: '2026-10-02T10:00:00.000Z',
      githubCommentId: '1101',
      postedCommentKind: 'inline',
      side: 'RIGHT',
      postedAuto: false,
      reminder: null,
      remindable: true,
    });
    expect(p0.diffAnchorId).toMatch(/^[0-9a-f]{64}$/);

    const out = await reminder.postTeammateReminder(ctx(), 1, findingId);
    expect(out).toMatchObject({ kind: 'posted', result: { githubCommentId: '9001', reminder: true } });
    expect(postFinding).toHaveBeenCalledTimes(1);
    const args = postFinding.mock.calls[0]![0];
    expect(args).toMatchObject({
      owner: 'acme',
      name: 'rm',
      prNumber: 1,
      reviewHeadSha: HEAD,
      finding: {
        id: findingId,
        path: 'src/x.ts',
        line: 14,
        anchored: true,
        body: 'This can throw on an empty list. Guard it.',
        suggestion: 'if (!xs.length) return;',
        severity: 'warning',
        storyLead: '**Reminder:** first raised [on 2 Oct 2026](https://github.com/acme/rm/pull/1#discussion_r1101).',
      },
    });
    expect(args.prLevel).toBeUndefined();

    const after = await loadTeamReviewView(db, 1, prId, null, await listTeammateReviews(db, 1, prId), null);
    const p1 = after.allFindings!.find((p) => p.findingId === findingId)!;
    expect(p1.reminder).toMatchObject({ githubCommentId: '9001', postedCommentKind: 'inline' });
    expect(p1.reminder).not.toHaveProperty('earlierCommentIds');
    // The import (a later walk) keeps the record.
    const { importTeammateReviews } = await import('../../db/teammate-reviews-import.js');
    await importTeammateReviews(1, prId);
    const again = await loadTeamReviewView(db, 1, prId, null, await listTeammateReviews(db, 1, prId), null);
    expect(again.allFindings!.find((p) => p.findingId === findingId)!.reminder?.githubCommentId).toBe('9001');
  });

  it('refuses an unknown id, another account’s, and the reader’s own finding — nothing posted', async () => {
    const { prId, findingId } = await seedPr(2);
    expect(await reminder.postTeammateReminder(ctx(), 1, 999_999)).toEqual({ kind: 'not_found' });
    expect(await reminder.postTeammateReminder(ctx(), 2, findingId)).toEqual({ kind: 'not_found' });
    const [own] = await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', trigger: 'manual', createdAt: new Date() })
      .returning()
      .execute();
    const [ownF] = await db
      .insert(schema.claudeReviewFindings)
      .values({ reviewId: own.id, path: 'src/z.ts', line: 3, side: 'RIGHT', severity: 'nit', title: 'Rename', body: 'Rename.', anchored: true, fileInDiff: true, included: true, postedAt: new Date(), githubCommentId: '777', postedCommentKind: 'inline', createdAt: new Date() })
      .returning()
      .execute();
    expect(await reminder.postTeammateReminder(ctx(), 1, ownF.id)).toEqual({ kind: 'not_found' });
    expect(postFinding).not.toHaveBeenCalled();
  });

  it('refuses a point resolved on GitHub', async () => {
    const { findingId } = await seedPr(3, { isResolved: true });
    const out = await reminder.postTeammateReminder(ctx(), 1, findingId);
    expect(out).toMatchObject({ kind: 'conflict', code: 'NotOpen' });
    expect(postFinding).not.toHaveBeenCalled();
  });

  it('an outdated thread posts a PR-level comment; a moved head posts nothing and records nothing', async () => {
    const { findingId } = await seedPr(4, { isOutdated: true, line: null });
    postFinding.mockResolvedValueOnce({ commentId: '9002', postedCommentKind: 'pr_comment' });
    expect(await reminder.postTeammateReminder(ctx(), 1, findingId)).toMatchObject({ kind: 'posted' });
    expect(postFinding.mock.calls[0]![0]).toMatchObject({ prLevel: true, finding: { anchored: false, path: 'src/x.ts' } });

    const moved = await seedPr(5);
    postFinding.mockResolvedValueOnce({ headMoved: true });
    expect(await reminder.postTeammateReminder(ctx(), 1, moved.findingId)).toMatchObject({ kind: 'conflict', code: 'HeadMoved' });
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select({ reminder: schema.claudeReviewFindings.reminder }).from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.id, moved.findingId)).execute();
    expect(row.reminder).toBeNull();
  });
});
