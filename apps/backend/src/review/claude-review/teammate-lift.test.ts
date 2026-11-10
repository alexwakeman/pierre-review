// LIFTING A TEAMMATE'S LIMN BLOCK (docs/CLAUDE-REVIEW.md § Lifting a teammate's block). Throwaway
// sqlite, the REAL persistPr + teammate import, a FAKE GitHub (postReview, the live PR, the live
// reviews and the dismissal are recorded stubs). What this pins:
//   1. All conditions met ⇒ the reader's review goes out (COMMENT, or APPROVE when the auto verdict and
//      its gate allow), carrying the judgements, then ONE dismissal of the teammate's review with the
//      plain message; recorded on the teammate's row and on the run; the PR is settled.
//   2. Each missing condition holds it: the lifting setting off, no consent in the post, a point not
//      addressed, a blocker in the reader's own run, the head moved, the reader's own PR.
//   3. A review without Limn's marker (a person's typed Request changes) is NEVER dismissed.
//   4. The claim: a teammate review is tried once, ever — a second run never dismisses it again.
//   5. A refusal (403) is recorded in GitHub's words and never retried.
//
//   pnpm --filter @pierre-review/backend test claude-review/teammate-lift
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_POST_DEFAULT_KINDS, limnReviewMarker, parseLimnReviewMarker } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import type { GqlPullRequest } from '../../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-teammate-lift-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let ap: typeof import('./auto-post.js');
let persist: typeof import('./persist.js');
let settings: typeof import('./auto-settings.js');
let upsert: typeof import('../../sync/upsert.js');
let lift: typeof import('./teammate-lift.js');
let repoId = 0;
let wsId = 0;
let prSeq = 0;

const MARK = '<!-- pierre:claude-review-finding v=1 -->';
const ROBIN = { login: 'robin-dev', id: 'U_robin', __typename: 'User' }; // the teammate
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' }; // the PR author
const ALICE = { login: 'alice-dev', id: 'U_alice', __typename: 'User' }; // the reader
const HEAD = 'b'.repeat(40);

const robinSummary = (consent: boolean, headSha: string = HEAD): string =>
  `Two things to fix before this lands.\n\n${limnReviewMarker('aa11', {
    headSha,
    run: 'auto',
    pair: false,
    runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }],
    verdict: 'REQUEST_CHANGES',
    limnVersion: '0.1.180',
    liftConsent: consent,
  })}`;

function gqlPr(n: number, reviewBody: string, author: any = CAROL): GqlPullRequest {
  const at = '2026-11-03T10:00:00Z';
  return {
    id: `PR_lift_${n}`,
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
    createdAt: '2026-11-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-11-03T00:00:00Z',
    url: `https://github.com/acme/lift/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'fix',
    mergeable: null,
    mergeStateStatus: null,
    author,
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [{ id: `RV_${n}`, fullDatabaseId: String(500 + n), state: 'CHANGES_REQUESTED', body: reviewBody, submittedAt: at, author: ROBIN }] },
    reviewThreads: {
      nodes: [
        {
          id: `T_${n}`,
          isResolved: false,
          isOutdated: false,
          isCollapsed: false,
          path: 'src/x.ts',
          line: 12,
          resolvedBy: null,
          comments: {
            nodes: [
              { id: `C_${n}01`, fullDatabaseId: `${n}01`, body: `**Warning**\n\nThis can throw on an empty list.\n\n${MARK}`, createdAt: at, diffHunk: null, author: ROBIN },
            ],
          },
        },
      ],
    },
    comments: {
      nodes: [
        { id: `IC_${n}02`, fullDatabaseId: `${n}02`, body: `**Blocker** · \`src/y.ts:4\`\n\nThe lock is never released.\n\n${MARK}`, createdAt: at, diffHunk: null, author: ROBIN },
        { id: `IC_${n}03`, fullDatabaseId: `${n}03`, body: `**Nit** · \`src/y.ts:9\`\n\nName this better.\n\n${MARK}`, createdAt: at, diffHunk: null, author: ROBIN },
      ],
    },
    commits: { nodes: [] },
    headRefOid: HEAD,
  } as unknown as GqlPullRequest;
}

const postReview = vi.fn();
const settle = vi.fn(async () => ({ visible: true }));
const dismissReview = vi.fn(async (..._a: unknown[]): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true }));
let liveHead = HEAD;
let liveList: any[] = [];
const deps = () => ({
  ...ap.defaultAutoPostDeps,
  livePr: vi.fn(async () => ({ headSha: liveHead, state: 'open' as const, draft: false, merged: false })),
  liveReviews: vi.fn(async () => liveList),
  accountLogin: vi.fn(async () => 'alice-dev'),
  impactLevel: vi.fn(async () => 'low' as const),
  isAutomation: vi.fn(async () => false),
  dismissReview,
  settle,
});

async function setPost(extra: Record<string, unknown>): Promise<void> {
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: true, scope: 'all', ...extra } as any });
}

/** A PR with robin's Limn Request changes imported. Returns the PR id, the teammate row and its findings. */
async function blockedPr(
  o: { consent?: boolean; body?: string; author?: any; blockHead?: string } = {},
): Promise<{ prId: number; teammateId: number; findings: any[]; ghId: string }> {
  prSeq += 1;
  const body = o.body ?? robinSummary(o.consent ?? true, o.blockHead ?? HEAD);
  await upsert.persistPr(gqlPr(prSeq, body, o.author ?? CAROL), repoId, upsert.createUserResolver(), new Map(), 1);
  const { and, eq } = await import('drizzle-orm');
  const prId = (await db.select({ id: schema.pullRequests.id }).from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, `PR_lift_${prSeq}`)).execute())[0].id;
  await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
  const rows = await db
    .select()
    .from(schema.claudeReviews)
    .where(and(eq(schema.claudeReviews.prId, prId), eq(schema.claudeReviews.kind, 'teammate')))
    .execute();
  const findings = await db.select().from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, rows[0]?.id ?? -1)).execute();
  const ghId = String(500 + prSeq);
  // On GitHub, live: robin's review still requests changes, then a thread reply (COMMENTED: never replaces it).
  liveList = [
    { id: ghId, login: 'robin-dev', state: 'CHANGES_REQUESTED', body },
    { id: 9_000 + prSeq, login: 'carol-dev', state: 'COMMENTED', body: 'Fixed.' },
  ];
  return { prId, teammateId: rows[0]?.id, findings, ghId };
}

const followUpOf = (items: Array<{ id: number; status: string; severity?: string }>) => ({
  priorReviewId: 0,
  priorHeadSha: HEAD,
  headMoved: false,
  changesSinceShown: false,
  items: items.map((it, i) => ({
    ref: it.status === 'not_checked' ? null : `P${i + 1}`,
    priorFindingId: it.id,
    sent: it.status !== 'not_checked',
    carried: true,
    status: it.status,
    explanation: null,
    path: 'src/x.ts',
    line: 12,
    side: 'RIGHT',
    severity: it.severity ?? 'warning',
    title: 't',
  })),
});

/** The reader's auto run at HEAD, judging the given teammate findings. */
async function readerRun(
  prId: number,
  judged: Array<{ id: number; status: string }>,
  o: { verdict?: 'COMMENT' | 'APPROVE'; findings?: Array<{ severity: string; title: string }>; head?: string } = {},
): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, o.head ?? HEAD, 'claude-opus-5-5' as any, 1, [], 'auto');
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: 'Every earlier point is dealt with.',
    verdict: o.verdict ?? 'COMMENT',
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    excludedFiles: [],
    followUp: followUpOf(judged) as any,
    findings: (o.findings ?? []).map((f, i) => ({
      path: 'src/z.ts',
      line: 30 + i,
      side: 'RIGHT' as const,
      severity: f.severity as any,
      title: f.title,
      body: f.title,
      suggestion: null,
      diffHunk: null,
      anchored: true,
      fileInDiff: true,
      priorFindingId: null,
    })),
  });
  return id;
}

const allAddressed = (findings: any[]) => findings.map((f) => ({ id: f.id, status: 'addressed' }));
const teammateLiftOf = async (id: number) => {
  const { eq } = await import('drizzle-orm');
  return (await db.select({ l: schema.claudeReviews.teammateLift }).from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute())[0].l;
};
const autoPostOf = async (id: number) => {
  const { eq } = await import('drizzle-orm');
  return (await db.select({ a: schema.claudeReviews.autoPost }).from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute())[0].a;
};
const go = (prId: number, reviewId: number) => ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId }, deps());

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_alice', githubLogin: 'alice-dev', isLocal: true }).onConflictDoNothing().execute();
  await db.update(schema.accounts).set({ githubLogin: 'alice-dev' }).execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'lift', githubNodeId: 'R_lift' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  ap = await import('./auto-post.js');
  persist = await import('./persist.js');
  settings = await import('./auto-settings.js');
  upsert = await import('../../sync/upsert.js');
  lift = await import('./teammate-lift.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview, postFinding: vi.fn() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(async () => {
  postReview.mockReset();
  postReview.mockImplementation(async (a: any) => ({
    postedReviewId: `MY${prSeq}`,
    inlineFindingIds: a.includedFindings.map((f: any) => f.id),
    prComments: [],
    commentCount: a.includedFindings.length,
    prCommentCount: 0,
  }));
  dismissReview.mockReset();
  dismissReview.mockImplementation(async () => ({ ok: true }));
  settle.mockClear();
  liveHead = HEAD;
  await setPost({ liftTeammateBlocks: true, autoVerdict: false });
});

describe('the pure rules', () => {
  it('the marker carries the consent as lift=1, and only when given', () => {
    expect(robinSummary(true)).toContain(' lift=1 ');
    expect(parseLimnReviewMarker(robinSummary(true))?.liftConsent).toBe(true);
    expect(robinSummary(false)).not.toContain('lift=');
    expect(parseLimnReviewMarker(robinSummary(false))?.liftConsent).toBeUndefined();
  });

  it('the points behind a block: blockers, warnings and unlabelled always; nits / questions by the approve rule', () => {
    const fs = [
      { id: 1, severity: 'blocker' as const },
      { id: 2, severity: 'warning' as const },
      { id: 3, severity: 'nit' as const },
      { id: 4, severity: 'question' as const },
      { id: 5, severity: null },
      { id: 6, severity: 'praise' as const },
    ];
    expect(lift.pointsBehindBlock(fs, 'nits_questions').map((f) => f.id)).toEqual([1, 2, 5]);
    expect(lift.pointsBehindBlock(fs, 'nits').map((f) => f.id)).toEqual([1, 2, 4, 5]);
    expect(lift.pointsBehindBlock(fs, 'none').map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    // ⚠ FAIL SAFE: a REQUEST_CHANGES whose comments hold no blocker, warning or unlabelled finding
    // rests on something they do not show (a blocker posted earlier): no points, never lifted — not
    // even under the strictest approve rule. A block with no findings has no points.
    expect(lift.pointsBehindBlock([{ id: 3, severity: 'nit' }], 'nits_questions')).toEqual([]);
    expect(lift.pointsBehindBlock([{ id: 3, severity: 'nit' }, { id: 4, severity: 'question' }], 'none')).toEqual([]);
    expect(lift.pointsBehindBlock([], 'none')).toEqual([]);
  });

  it('judgements hold only at the head they read; a reply accepted holds across heads', () => {
    const run = (headSha: string, items: Array<[number, string]>) => ({
      headSha,
      followUp: { items: items.map(([priorFindingId, status]) => ({ priorFindingId, status })) },
    });
    const w = lift.wordsAtHead(
      [
        run('H1', [[1, 'addressed'], [2, 'reply_accepted'], [3, 'addressed']]),
        run('H2', [[3, 'not_addressed'], [4, 'addressed']]),
        run('H3', [[4, 'not_checked'], [5, 'addressed']]),
      ],
      'H3',
    );
    // 1: addressed at H1 only — does not hold at H3. 2: a reply accepted holds. 3: cleared by H2's word.
    // 4: H2's code judgement does not hold at H3 (and 'not_checked' never counts). 5: judged here.
    expect([...w.entries()]).toEqual([[2, 'reply_accepted'], [5, 'addressed']]);
    // No head to hold to: every run counts.
    expect(lift.wordsAtHead([run('H1', [[1, 'addressed']])], null).get(1)).toBe('addressed');
  });

  it('the poster’s consent rides only a post whose comments hold every blocker behind it', () => {
    const f = (id: number, severity: string, more: Record<string, unknown> = {}) => ({ id, severity, included: true, story: null, ...more }) as any;
    expect(ap.blockersAllInPost([f(1, 'blocker'), f(2, 'nit')], [f(1, 'blocker')])).toBe(true);
    // The blocker was posted in an EARLIER review, so this post's comments hold only the nit.
    expect(ap.blockersAllInPost([f(1, 'blocker'), f(2, 'nit')], [f(2, 'nit')])).toBe(false);
    // A blocker the reader ignored does not count (the verdict does not count it either).
    expect(ap.blockersAllInPost([f(1, 'blocker', { included: false }), f(2, 'nit')], [f(2, 'nit')])).toBe(true);
    expect(ap.blockersAllInPost([f(2, 'warning')], [])).toBe(true);
  });

  it('the message names the reader, the count and the commit', () => {
    expect(lift.teammateLiftMessage('alex', 3, '70cc9b5aaaa')).toBe('Limn (alex) checked all 3 points are addressed at 70cc9b5.');
    expect(lift.teammateLiftMessage('alex', 1, '70cc9b5aaaa')).toBe('Limn (alex) checked the 1 point is addressed at 70cc9b5.');
  });

  it('the live check: standing, Limn-marked, consented — a later COMMENTED review never replaces it', () => {
    const c = { githubReviewId: '7', login: 'robin-dev' };
    const ok = [{ id: 7, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: robinSummary(true) }, { id: 8, login: 'robin-dev', state: 'COMMENTED', body: 'x' }];
    expect(lift.liveLiftCheck(ok, c, 'alice-dev')).toBeNull();
    expect(lift.liveLiftCheck([{ ...ok[0]!, body: 'Please fix the lock.' }], c, 'alice-dev')).toBe('not_limn');
    expect(lift.liveLiftCheck([{ ...ok[0]!, body: robinSummary(false) }], c, 'alice-dev')).toBe('no_consent');
    expect(lift.liveLiftCheck([...ok, { id: 9, login: 'robin-dev', state: 'DISMISSED', body: '' }], c, 'alice-dev')).toBe('not_in_force');
    expect(lift.liveLiftCheck([...ok, { id: 9, login: 'robin-dev', state: 'APPROVED', body: '' }], c, 'alice-dev')).toBe('not_in_force');
    expect(lift.liveLiftCheck(ok, c, 'robin-dev')).toBe('own_review');
    expect(lift.liveLiftCheck([], c, 'alice-dev')).toBe('not_in_force');
  });
});

describe("lifting a teammate's Limn block", () => {
  it('all conditions met: the reader posts, then dismisses robin’s review ONCE with the plain message', async () => {
    const { prId, teammateId, findings, ghId } = await blockedPr();
    expect(findings).toHaveLength(3);
    const run = await readerRun(prId, allAddressed(findings));
    const out = await go(prId, run);
    expect(out.kind).toBe('done');
    // The reader's own review went out first: COMMENT (the auto verdict is off), with the judgements
    // and the reader's (absent) consent in its marker.
    expect(postReview).toHaveBeenCalledTimes(1);
    const posted = postReview.mock.calls[0]![0];
    expect(posted.verdict).toBe('COMMENT');
    expect(posted.limnMeta.judged.map((j: any) => j.outcome)).toEqual(['addressed', 'addressed', 'addressed']);
    expect(posted.limnMeta.liftConsent).toBe(false);
    // Then the dismissal. The nit is left out of the count (the default approve rule lets nits stay).
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.calls[0]!.slice(1)).toEqual([
      'acme',
      'lift',
      prSeq,
      ghId,
      'Limn (alice-dev) checked all 2 points are addressed at bbbbbbb.',
    ]);
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissed', byReviewId: run, points: 2, error: null, headSha: HEAD });
    expect(await autoPostOf(run)).toMatchObject({
      status: 'posted',
      liftedTeammateBlocks: [{ teammateReviewId: teammateId, login: 'robin-dev', status: 'dismissed', error: null }],
    });
    expect(settle).toHaveBeenCalled();
    // The local review row is stamped dismissed: robin's block no longer stands.
    const { eq } = await import('drizzle-orm');
    const rv = await db.select({ state: schema.reviews.state }).from(schema.reviews).where(eq(schema.reviews.databaseId, ghId)).execute();
    expect(rv[0].state).toBe('dismissed');

    // A later run never dismisses it again.
    dismissReview.mockClear();
    const again = await readerRun(prId, allAddressed(findings));
    await go(prId, again);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('with the auto verdict on and nothing open, the reader’s review is an APPROVE', async () => {
    await setPost({ liftTeammateBlocks: true, autoVerdict: true });
    const { prId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings), { verdict: 'APPROVE' });
    await go(prId, run);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    expect(dismissReview).toHaveBeenCalledTimes(1);
  });

  it('a nit the reader’s approve rule does not allow open must be settled too', async () => {
    await setPost({ liftTeammateBlocks: true, approveLeftovers: 'none' });
    const { prId, findings } = await blockedPr();
    const nit = findings.find((f: any) => f.severity === 'nit');
    const run = await readerRun(prId, findings.map((f: any) => ({ id: f.id, status: f.id === nit.id ? 'not_addressed' : 'addressed' })));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    await setPost({ liftTeammateBlocks: true, approveLeftovers: 'nits_questions' });
  });

  it('the lifting setting off: nothing is dismissed (and nothing is posted for it)', async () => {
    await setPost({ liftTeammateBlocks: false });
    const { prId, teammateId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    expect(await go(prId, run)).toEqual({ kind: 'skipped', reason: 'nothing_new' });
    expect(postReview).not.toHaveBeenCalled();
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
  });

  it('no consent in robin’s post: never dismissed', async () => {
    const { prId, findings } = await blockedPr({ consent: false });
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a point not addressed (or not checked) holds it', async () => {
    const { prId, findings } = await blockedPr();
    const blocker = findings.find((f: any) => f.severity === 'blocker');
    const run = await readerRun(prId, findings.map((f: any) => ({ id: f.id, status: f.id === blocker.id ? 'not_checked' : 'addressed' })));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    const run2 = await readerRun(prId, findings.map((f: any) => ({ id: f.id, status: f.id === blocker.id ? 'not_addressed' : 'addressed' })));
    await go(prId, run2);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a point settled by an EARLIER run of the reader counts (it is not sent again)', async () => {
    const { prId, findings } = await blockedPr();
    const [first, ...rest] = findings;
    const early = await readerRun(prId, [{ id: first.id, status: 'no_longer_applies' }]);
    await db.update(schema.claudeReviews).set({ autoPost: { status: 'skipped' } }).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, early)).execute();
    const run = await readerRun(prId, rest.map((f: any) => ({ id: f.id, status: 'addressed' })));
    await go(prId, run);
    expect(dismissReview).toHaveBeenCalledTimes(1);
  });

  it('a point judged addressed only at an OLDER head never lifts the block (a push can undo the fix)', async () => {
    const OLD = 'a'.repeat(40);
    const { prId, findings } = await blockedPr();
    const [first, ...rest] = findings;
    const early = await readerRun(prId, [{ id: first.id, status: 'addressed' }], { head: OLD });
    await db.update(schema.claudeReviews).set({ autoPost: { status: 'skipped' } }).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, early)).execute();
    // The follow-up at HEAD gets the point again: it is not settled here.
    const { loadStandingBlockAnchors } = await import('./teammate-anchor.js');
    const blocks = await loadStandingBlockAnchors(ctx, prId, 1, null, HEAD);
    expect(blocks[0]!.findings.map((x) => x.id)).toContain(first.id);
    // Judged at the old head only (this run left it out): held.
    const run = await readerRun(prId, rest.map((f: any) => ({ id: f.id, status: 'addressed' })));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    // Settled points at the head being read are not sent again.
    expect((await loadStandingBlockAnchors(ctx, prId, 1, null, HEAD))[0]!.findings.map((x) => x.id)).toEqual([first.id]);
  });

  it('the poster’s own post withholds lift=1 when a blocker behind its verdict was posted earlier', async () => {
    await setPost({ liftTeammateBlocks: false, teamLiftConsent: true, autoVerdict: true, kinds: { ...AUTO_POST_DEFAULT_KINDS, nits: true } });
    const { prId } = await blockedPr();
    const r1 = await readerRun(prId, [], { findings: [{ severity: 'blocker', title: 'Lock leak' }] });
    await go(prId, r1);
    expect(postReview.mock.calls[0]![0].limnMeta.liftConsent).toBe(true);
    // The next run raises the same blocker again (already on GitHub, so left out) and a new nit.
    postReview.mockClear();
    const r2 = await readerRun(prId, [], { findings: [{ severity: 'blocker', title: 'Lock leak' }, { severity: 'nit', title: 'Rename x' }] });
    await go(prId, r2);
    const posted = postReview.mock.calls[0]![0];
    expect(posted.verdict).toBe('REQUEST_CHANGES');
    expect(posted.includedFindings.map((x: any) => x.severity)).toEqual(['nit']);
    expect(posted.limnMeta.liftConsent).toBe(false);
    await setPost({ liftTeammateBlocks: true, teamLiftConsent: false, autoVerdict: false, kinds: AUTO_POST_DEFAULT_KINDS });
  });

  it('a blocker in the reader’s own run holds it', async () => {
    const { prId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings), { findings: [{ severity: 'blocker', title: 'New race' }] });
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('the head moved since the run: no review, no dismissal', async () => {
    const { prId, teammateId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    liveHead = 'c'.repeat(40);
    const out = await go(prId, run);
    expect(out).toMatchObject({ kind: 'done', record: { status: 'failed' } });
    expect(postReview).not.toHaveBeenCalled();
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
  });

  it('the reader’s own PR: never', async () => {
    const { prId, findings } = await blockedPr({ author: ALICE });
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a person’s typed Request changes (no Limn marker) is never dismissed', async () => {
    const { prId, findings, ghId } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    // On GitHub now: the same review id, but its body has no marker (edited by hand) …
    liveList = [{ id: ghId, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: 'Please fix the lock first.' }];
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    // … or robin typed a newer Request changes of his own.
    const run2 = await readerRun(prId, allAddressed(findings));
    liveList = [
      { id: ghId, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: robinSummary(true) },
      { id: 77, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: 'Still not right.' },
    ];
    await go(prId, run2);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('the claim: a teammate review already claimed is never dismissed again', async () => {
    const { prId, teammateId, findings } = await blockedPr();
    // Another run claimed it (and was cut off mid-write).
    expect(await lift.claimTeammateLift(ctx, 1, teammateId, { byReviewId: 1, headSha: HEAD, points: 2, message: 'm' })).toBe(true);
    expect(await lift.claimTeammateLift(ctx, 1, teammateId, { byReviewId: 2, headSha: HEAD, points: 2, message: 'm' })).toBe(false);
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissing', byReviewId: 1 });
  });

  it('a refusal (403) is recorded in GitHub’s words and never retried', async () => {
    dismissReview.mockImplementation(async () => ({ ok: false, message: 'Must have admin rights to Repository.' }));
    const { prId, teammateId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'failed', error: 'Must have admin rights to Repository.' });
    // The reader's review itself landed.
    expect(await autoPostOf(run)).toMatchObject({
      status: 'posted',
      liftedTeammateBlocks: [{ status: 'failed', error: 'Must have admin rights to Repository.' }],
    });
    dismissReview.mockClear();
    const again = await readerRun(prId, allAddressed(findings));
    await go(prId, again);
    expect(dismissReview).not.toHaveBeenCalled();
    // The teammate review shows the attempt (the AI Review tab reads it).
    const { listTeammateReviews } = await import('../../db/teammate-reviews.js');
    const listed = await listTeammateReviews(db, 1, prId);
    expect(listed[0]!.lift).toMatchObject({ status: 'failed', error: 'Must have admin rights to Repository.' });
  });

  it('the consent rides the reader’s own posts while their setting is on', async () => {
    await setPost({ liftTeammateBlocks: true, teamLiftConsent: true });
    const { prId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(postReview.mock.calls[0]![0].limnMeta.liftConsent).toBe(true);
    await setPost({ teamLiftConsent: false });
  });
});

// THE AWAY PATH (2026-11-10; docs/TEAM-REVIEW.md § 5 "When the teammate is away"): no opt-in on
// either side; the reader's review APPROVES, every point behind robin's block is settled at the head,
// and robin's Limn is away — no line at the head, nothing seen for TEAMMATE_AWAY_AFTER_MS.
describe("dismissing an away teammate's Limn block", () => {
  // robin's review was posted 2026-11-03T10:00Z; a day later his Limn has been quiet for 24 hours.
  const DAY_LATER = Date.parse('2026-11-04T10:00:00Z');
  // robin's Limn reviewed an OLDER commit; the PR is now at HEAD, which his Limn has not looked at.
  const OLD_HEAD = 'a'.repeat(40);
  let now = DAY_LATER;
  let lines: Array<{ login: string | null }> | null = [];
  const liveTeamLines = vi.fn(async () => lines);
  const awayDeps = () => ({ ...deps(), liveTeamLines, nowMs: () => now });
  const goAway = (prId: number, reviewId: number) => ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId }, awayDeps());
  const approveRun = (prId: number, findings: any[], judged = allAddressed(findings)) => readerRun(prId, judged, { verdict: 'APPROVE' });

  beforeEach(async () => {
    now = DAY_LATER;
    lines = [{ login: 'alice-dev' }];
    liveTeamLines.mockClear();
    // Neither opt-in: robin gave no consent, the reader has not ticked "Dismiss a teammate's …".
    await setPost({ liftTeammateBlocks: false, teamLiftConsent: false, autoVerdict: true });
  });

  it('the pure rules: away only with no line at the head and nothing seen for the window', () => {
    const at = Date.parse('2026-11-03T10:00:00Z');
    expect(lift.teammateAwayHold({ activeAtHead: false, lastSeenMs: at, nowMs: at + lift.TEAMMATE_AWAY_AFTER_MS })).toBeNull();
    expect(lift.teammateAwayHold({ activeAtHead: false, lastSeenMs: at, nowMs: at + lift.TEAMMATE_AWAY_AFTER_MS - 1 })).toBe('teammate_recent');
    expect(lift.teammateAwayHold({ activeAtHead: true, lastSeenMs: null, nowMs: at })).toBe('teammate_active');
    expect(lift.teammateAwayHold({ activeAtHead: null, lastSeenMs: null, nowMs: at })).toBe('teammate_unknown');
    expect(lift.teammateLineAtHead([{ login: 'Robin-Dev' }], 'robin-dev')).toBe(true);
    expect(lift.teammateLineAtHead([{ login: 'alice-dev' }], 'robin-dev')).toBe(false);
    expect(lift.teammateLineAtHead(null, 'robin-dev')).toBeNull();
    // The away path needs an approving review; consent is not asked.
    const base = {
      why: 'away' as const,
      settingOn: false,
      authorIsMe: false,
      posterIsMe: false,
      inForce: true,
      alreadyTried: false,
      consent: false,
      limn: true,
      ownBlocker: false,
      atCurrentHead: true,
      points: [{ id: 1, severity: 'warning' as const }],
      words: new Map([[1, 'addressed']]),
      away: { activeAtHead: false, lastSeenMs: at, nowMs: DAY_LATER },
    };
    expect(lift.teammateLiftHold({ ...base, approves: true })).toBeNull();
    expect(lift.teammateLiftHold({ ...base, approves: false })).toBe('not_approving');
    expect(lift.teammateLiftHold({ ...base, approves: true, limn: false })).toBe('not_limn');
    expect(lift.teammateLiftHold({ ...base, approves: true, words: new Map([[1, 'not_addressed']]) })).toBe('points_open');
  });

  it('the live check on the away path: no consent needed; a recent later review of theirs holds it', () => {
    const c = { githubReviewId: '7', login: 'robin-dev', why: 'away' as const };
    const block = { id: 7, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: robinSummary(false) };
    expect(lift.liveLiftCheck([block], c, 'alice-dev', DAY_LATER)).toBeNull();
    const reply = (at: string | null) => ({ id: 8, login: 'robin-dev', state: 'COMMENTED', body: '', submittedAt: at });
    expect(lift.liveLiftCheck([block, reply('2026-11-04T09:00:00Z')], c, 'alice-dev', DAY_LATER)).toBe('teammate_active');
    expect(lift.liveLiftCheck([block, reply(null)], c, 'alice-dev', DAY_LATER)).toBe('teammate_active');
    expect(lift.liveLiftCheck([block, reply('2026-11-03T11:00:00Z')], c, 'alice-dev', DAY_LATER)).toBeNull();
    // A person's typed review is never dismissed.
    expect(lift.liveLiftCheck([{ ...block, body: 'Please fix it.' }], c, 'alice-dev', DAY_LATER)).toBe('not_limn');
  });

  it('the message keeps the Limn lead and says why', async () => {
    const { isLimnDismissalMessage } = await import('@pierre-review/shared');
    const m = lift.teammateAwayLiftMessage('alex', 'robin', 3, 'abc1234ffff', 5 * 3_600_000);
    expect(m).toBe("Limn (alex) checked all 3 points are addressed at abc1234. robin's Limn has not reviewed it and has been away for 5 hours.");
    expect(isLimnDismissalMessage(m)).toBe(true);
    expect(lift.awayFor(3 * 86_400_000)).toBe('3 days');
    expect(lift.teammateAwayLiftMessage('alex', 'robin', 1, 'abc1234', null)).toBe(
      "Limn (alex) checked the 1 point is addressed at abc1234. robin's Limn has not reviewed it.",
    );
  });

  it('every point settled and robin away: the reader approves, then dismisses robin’s review once', async () => {
    const { prId, teammateId, findings, ghId } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    const run = await approveRun(prId, findings);
    await goAway(prId, run);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    expect(liveTeamLines).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.calls[0]!.slice(1)).toEqual([
      'acme',
      'lift',
      prSeq,
      ghId,
      "Limn (alice-dev) checked all 2 points are addressed at bbbbbbb. robin-dev's Limn has not reviewed it and has been away for 24 hours.",
    ]);
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissed', why: 'away', points: 2 });
    expect(await autoPostOf(run)).toMatchObject({
      status: 'posted',
      liftedTeammateBlocks: [{ teammateReviewId: teammateId, login: 'robin-dev', status: 'dismissed', why: 'away' }],
    });
    expect(settle).toHaveBeenCalled();
    // Claimed once: a later approving run never dismisses it again.
    dismissReview.mockClear();
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a point still open holds it (the reader does not approve over it)', async () => {
    const { prId, teammateId, findings } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    const blocker = findings.find((f: any) => f.severity === 'blocker');
    const run = await approveRun(prId, findings, findings.map((f: any) => ({ id: f.id, status: f.id === blocker.id ? 'not_addressed' : 'addressed' })));
    await goAway(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
  });

  it('robin’s Limn is active: a line at the head, a recent sighting, a recent reply, or an unreadable head', async () => {
    // His `limn/review-*` line at the head (live).
    lines = [{ login: 'robin-dev' }];
    let p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(postReview.mock.calls.at(-1)![0].verdict).toBe('APPROVE');
    // Seen an hour ago (his review was posted at 10:00).
    lines = [];
    now = Date.parse('2026-11-03T11:00:00Z');
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(liveTeamLines).toHaveBeenCalledTimes(1); // the DB pre-check held it before any line read
    // A thread reply of his on GitHub an hour ago.
    now = DAY_LATER;
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    liveList = [...liveList, { id: 88, login: 'robin-dev', state: 'COMMENTED', body: 'Still looking.', submittedAt: '2026-11-04T09:00:00Z' }];
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    // His block was posted at the head itself: his Limn has reviewed this commit.
    p = await blockedPr({ consent: false });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    // The head's lines could not be read.
    lines = null;
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(p.teammateId)).toBeNull();
  });

  it('never a person’s review: no Limn marker on GitHub, never dismissed', async () => {
    const { prId, findings, ghId } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    liveList = [{ id: ghId, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: 'Please fix the lock first.' }];
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('gated like the verdict: auto verdict off, an impact the reader does not approve, or their own PR', async () => {
    await setPost({ liftTeammateBlocks: false, autoVerdict: false });
    let p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    await setPost({ liftTeammateBlocks: false, autoVerdict: true, approveImpact: { high: false, medium: false, low: false } });
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(postReview.mock.calls.at(-1)![0].verdict).toBe('COMMENT');
    expect(dismissReview).not.toHaveBeenCalled();
    await setPost({ liftTeammateBlocks: false, autoVerdict: true, approveImpact: { high: true, medium: true, low: true } });
    p = await blockedPr({ consent: false, author: ALICE, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a refused approve went out as a comment: nothing is dismissed', async () => {
    const { prId, teammateId, findings } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    postReview.mockImplementation(async (a: any) => {
      if (a.verdict === 'APPROVE') throw Object.assign(new Error('Review cannot be approved'), { status: 422 });
      return { postedReviewId: 'MYc', inlineFindingIds: [], prComments: [], commentCount: 0, prCommentCount: 0 };
    });
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
  });

  it('the claim: one already claimed by another run is never dismissed', async () => {
    const { prId, teammateId, findings } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    expect(await lift.claimTeammateLift(ctx, 1, teammateId, { byReviewId: 1, headSha: HEAD, points: 2, message: 'm', why: 'away' })).toBe(true);
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissing', byReviewId: 1 });
  });
});
