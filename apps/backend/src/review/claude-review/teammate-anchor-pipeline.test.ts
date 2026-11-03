// THE PR AUTHOR'S OWN REVIEW ANCHORS THE FOLLOW-UP (teammate-anchor.ts; docs/CLAUDE-REVIEW.md
// § Follow-up on the previous review → The author's own review). End to end through the review
// manager's pipeline over the REAL core client and migrations, a fake prepare and a fake model.
//
// What this pins:
//   1. The PR author's imported posted review (`kind = 'teammate'`) is the previous review: its
//      findings are SENT ("## Previous review"), the record names it (`priorReviewId`, `teammate`),
//      and on the same head each is locked not_addressed.
//   2. The reader's own OLDER review is folded in as CARRIED, so nothing drops out of the chain.
//   3. A NON-AUTHOR teammate's posted review never anchors: an ordinary first review.
//   4. A newer review of the reader's own anchors as before (no `teammate` on the record).
//   5. Writers never treat a teammate finding as a thread owner (`loadThreadOwners` `ownOnly`); the
//      auto-post dedupe knows the teammate's findings are on GitHub (`loadEarlierFindings`).
//   6. The pure merge (`mergeAuthorAnchor`): own findings carried, once per id, settled ids out.
//
//   pnpm --filter @pierre-review/backend test teammate-anchor-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';
import type { PriorFindingForFollowUp } from './follow-up.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-review-teammate-anchor.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const PATH = 'src/server/controller.js';
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
const T0 = Date.now() - 3600_000;

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let anchorMod: typeof import('./teammate-anchor.js');
let lastArgs: RunReviewArgs | null = null;
let carolId = 0;
let robinId = 0;

async function newPr(key: string, authorId: number): Promise<number> {
  const repoId = (
    await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: key, githubNodeId: `R_${key}` }).returning().execute()
  )[0].id;
  const prId = (
    await db
      .insert(schema.pullRequests)
      .values({ githubNodeId: `PR_${key}`, accountId: 1, repoId, number: 7, title: key, state: 'open', isDraft: false, openedAt: new Date(T0), updatedAt: new Date(T0), headSha: HEAD, authorId })
      .returning()
      .execute()
  )[0].id;
  await db
    .insert(schema.commits)
    .values([
      { sha: OLD, prId, committedAt: new Date(T0 - 7200_000) },
      { sha: HEAD, prId, committedAt: new Date(T0) },
    ])
    .execute();
  return prId;
}

/** A teammate's posted review as the import stores it: one inline finding, one PR-level blocker. */
async function teammateReview(prId: number, posterId: number, at: Date): Promise<{ id: number; findingIds: number[] }> {
  const [r] = await db
    .insert(schema.claudeReviews)
    .values({
      accountId: 1, prId, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', provider: 'claude',
      trigger: 'manual', kind: 'teammate', sourceUserId: posterId, sourceReviewNodeId: `RV_${prId}_${posterId}`,
      summary: 'Two things.', verdict: 'REQUEST_CHANGES', postedAt: at, finishedAt: at, createdAt: at,
    })
    .returning()
    .execute();
  const rows = await db
    .insert(schema.claudeReviewFindings)
    .values([
      {
        reviewId: r.id, path: PATH, line: 2, side: 'RIGHT', severity: 'warning', title: 'Empty list throws',
        body: 'This can throw on an empty list.', anchored: true, fileInDiff: true, included: false, postedAt: at,
        githubCommentId: `${prId}01`, postedCommentKind: 'inline', sourceCommentNodeId: `C_${prId}_1`, createdAt: at,
      },
      {
        reviewId: r.id, path: 'src/y.ts', line: 4, side: 'RIGHT', severity: 'blocker', title: 'Lock never released',
        body: 'The lock is never released.', anchored: false, fileInDiff: false, included: false, postedAt: at,
        githubCommentId: `${prId}02`, postedCommentKind: 'pr_comment', sourceCommentNodeId: `C_${prId}_2`, createdAt: at,
      },
    ])
    .returning()
    .execute();
  return { id: r.id, findingIds: rows.map((x: any) => x.id) };
}

async function runToEnd(prId: number): Promise<ClaudeReview> {
  const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5', 'claude', {});
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  for (let i = 0; i < 200; i++) {
    const r = await persist.getClaudeReviewById(ctx, started.reviewId, 1);
    if (r && r.status !== 'queued' && r.status !== 'running') {
      await new Promise((res) => setTimeout(res, 20));
      return r;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('review did not finish');
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
    recordAiUsage: async () => {},
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF, promptDiff: DIFF, changedFiles: [PATH], excludedFiles: [], omittedFiles: [],
        fileMetrics: [{ path: PATH, additions: 4, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length, diffCapped: false,
      }),
      runReview: async (args: RunReviewArgs) => {
        lastArgs = args;
        return {
          submitted: true, scope: 'diff_only', summary: 'ok', verdict: 'COMMENT', findings: [],
          costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1,
        } as unknown as RunReviewResult;
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: { loadReviewThreads: async () => ({ threads: [], newestCommentAt: null, ownThreadCount: 0 }) },
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');
  anchorMod = await import('./teammate-anchor.js');
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_viewer-me', githubLogin: 'viewer-me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'viewer-me' } })
    .execute();
  carolId = (await db.insert(schema.users).values({ githubLogin: 'carol-dev', githubNodeId: 'U_carol' }).returning().execute())[0].id;
  robinId = (await db.insert(schema.users).values({ githubLogin: 'robin-dev', githubNodeId: 'U_robin' }).returning().execute())[0].id;
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe("the PR author's own posted review", () => {
  it('is the previous review: its findings are sent, named on the record, locked on the same head', async () => {
    const prId = await newPr('author', carolId);
    const tm = await teammateReview(prId, carolId, new Date(T0 + 60_000));
    const r = await runToEnd(prId);
    expect(r.status).toBe('succeeded');
    const prompt = lastArgs!.prompt;
    expect(prompt).toContain('## Previous review');
    expect(prompt).toContain('Title: Empty list throws');
    expect(prompt).toContain('Title: Lock never released');
    expect(r.followUp).toMatchObject({ priorReviewId: tm.id, priorHeadSha: HEAD, headMoved: false, teammate: { userId: carolId, login: 'carol-dev' } });
    expect(r.followUp!.items.map((it) => [it.priorFindingId, it.carried, it.status]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual(
      tm.findingIds.map((id) => [id, false, 'not_addressed']),
    );
  });

  it("carries the reader's own older review, so nothing drops out of the chain", async () => {
    const prId = await newPr('carry', carolId);
    const r0 = await persist.insertQueuedReview(ctx, prId, OLD, 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(ctx, r0, {
      scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
      numTurns: 1, excludedFiles: [],
      findings: [{ path: PATH, line: 3, side: 'RIGHT', severity: 'nit', title: 'Rename x', body: 'Rename x.', suggestion: null, diffHunk: null, anchored: true, fileInDiff: true }],
    } as any);
    const own = (await persist.getClaudeReviewById(ctx, r0, 1))!;
    await persist.markFindingPosted(ctx, own.findings[0]!.id, 'c-own', 'inline');
    // Pushed back in time: the author's review is the newer one.
    const { eq } = await import('drizzle-orm');
    await db.update(schema.claudeReviews).set({ finishedAt: new Date(T0 - 3600_000), createdAt: new Date(T0 - 3600_000) }).where(eq(schema.claudeReviews.id, r0)).execute();
    const tm = await teammateReview(prId, carolId, new Date(T0 + 60_000));
    const r = await runToEnd(prId);
    expect(r.followUp?.priorReviewId).toBe(tm.id);
    const byId = new Map(r.followUp!.items.map((it) => [it.priorFindingId, it]));
    expect(byId.get(own.findings[0]!.id)).toMatchObject({ carried: true });
    for (const id of tm.findingIds) expect(byId.get(id)).toMatchObject({ carried: false });

    // The NEXT run anchors on the reader's own run again (no teammate on its record).
    const next = await runToEnd(prId);
    expect(next.followUp?.priorReviewId).toBe(r.id);
    expect(next.followUp?.teammate).toBeUndefined();
  });

  it("a NON-AUTHOR teammate's posted review never anchors: an ordinary first review", async () => {
    const prId = await newPr('robin', carolId);
    await teammateReview(prId, robinId, new Date(T0 + 60_000));
    expect(await anchorMod.loadAuthorReviewAnchor(ctx, prId, 1, HEAD, 1_000_000)).toBeNull();
    const r = await runToEnd(prId);
    expect(lastArgs!.prompt).not.toContain('## Previous review');
    expect(r.followUp).toBeNull();
  });

  it('writers never own a teammate thread; the auto-post dedupe knows it is on GitHub', async () => {
    const prId = await newPr('writers', carolId);
    const tm = await teammateReview(prId, carolId, new Date(T0 + 60_000));
    const { loadThreadOwners } = await import('./finding-replies.js');
    const inline = tm.findingIds[0]!;
    expect((await loadThreadOwners(ctx, 1, prId, [inline])).get(inline)?.id).toBe(inline);
    expect((await loadThreadOwners(ctx, 1, prId, [inline], { ownOnly: true })).size).toBe(0);
    const { loadEarlierFindings, alreadyOnGithub } = await import('./auto-post.js');
    // Before any own run (the teammate row may be imported after the run started).
    const earlier = await loadEarlierFindings(ctx, 1, prId, 1);
    expect(earlier.map((e) => [e.id, e.onGithub]).sort()).toEqual(tm.findingIds.map((id) => [id, true]).sort());
    expect(alreadyOnGithub({ path: PATH, title: 'Re-raise', priorFindingId: inline }, earlier)).toBe(true);
  });
});

describe("a re-raise of the author's point", () => {
  it('carries earlierPost (the teammate comment), so a manual Post leaves it out', async () => {
    const prId = await newPr('reraise', carolId);
    const tm = await teammateReview(prId, carolId, new Date(T0 + 60_000));
    // The reader's run at a moved head re-raises the author's inline Warning as an INCLUDED,
    // unposted finding chained to it.
    const r0 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(ctx, r0, {
      scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
      numTurns: 1, excludedFiles: [],
      findings: [{ path: PATH, line: 2, side: 'RIGHT', severity: 'warning', title: 'Empty list still throws', body: 'Still throws on an empty list.', suggestion: null, diffHunk: null, anchored: true, fileInDiff: true }],
    } as any);
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.claudeReviewFindings)
      .set({ priorFindingId: tm.findingIds[0], included: true })
      .where(eq(schema.claudeReviewFindings.reviewId, r0))
      .execute();
    const r = (await persist.getClaudeReviewById(ctx, r0, 1))!;
    const reraise = r.findings.find((f) => f.title === 'Empty list still throws')!;
    expect(reraise.postedAt).toBeNull();
    expect(reraise.earlierPost).toMatchObject({ findingId: tm.findingIds[0], githubCommentId: `${prId}01`, postedCommentKind: 'inline' });
    // The teammate's own findings are never STAMPED as the reader's.
    const tmRows = await db.select().from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, tm.id)).execute();
    expect(tmRows.map((x: any) => x.githubCommentId).sort()).toEqual([`${prId}01`, `${prId}02`]);
  });
});

describe('auto review is still due', () => {
  it("the author's imported review neither settles a first review nor a moved head", async () => {
    const queries = await import('../../db/queries.js');
    const workspaceId = await queries.ensureDefaultWorkspace(1);
    const first = await newPr('due-first', carolId);
    const moved = await newPr('due-moved', carolId);
    await queries.ensureRepoMemberships(1);
    await teammateReview(first, carolId, new Date(T0 + 60_000));
    // `moved`: the reader reviewed the OLD head; the author's review is at the current one.
    const r0 = await persist.insertQueuedReview(ctx, moved, OLD, 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(ctx, r0, {
      scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1, excludedFiles: [], findings: [],
    } as any);
    await teammateReview(moved, carolId, new Date(T0 + 60_000));
    const cands = await queries.getAutoReviewCandidates(1, workspaceId, { openedSinceMs: 0, dayStartMs: Date.now() - 86_400_000, limit: 50 });
    expect(cands?.prIds).toContain(first);
    expect(cands?.reReview.map((c) => c.prId)).toContain(moved);
  });
});

describe('mergeAuthorAnchor (pure)', () => {
  const f = (id: number, extra: Partial<PriorFindingForFollowUp> = {}): PriorFindingForFollowUp => ({
    id, headSha: HEAD, path: PATH, line: 1, side: 'RIGHT', severity: 'warning', title: `t${id}`, body: 'b',
    suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, posted: true, carried: false, ...extra,
  });
  it("puts the author's findings first, carries the reader's own once, leaves settled ids out", () => {
    const merged = anchorMod.mergeAuthorAnchor(
      { reviewId: 9, headSha: HEAD, teammate: { userId: 3, login: 'carol-dev' }, findings: [f(1), f(2)] },
      { reviewId: 5, headSha: OLD, findings: [f(2), f(3, { headSha: OLD }), f(4)], leftOut: [{ priorFindingId: 7, reason: 'ignored', path: PATH, severity: 'nit', title: 'x' }] },
      new Set([4]),
    );
    expect(merged.reviewId).toBe(9);
    expect(merged.headSha).toBe(HEAD);
    expect(merged.teammate.login).toBe('carol-dev');
    expect(merged.findings.map((x) => [x.id, x.carried, x.headSha])).toEqual([
      [1, false, HEAD],
      [2, false, HEAD],
      [3, true, OLD],
    ]);
    expect(merged.leftOut?.map((l) => l.priorFindingId)).toEqual([7]);
  });
});
