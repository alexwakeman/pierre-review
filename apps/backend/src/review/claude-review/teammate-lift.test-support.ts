// THE SHARED FIXTURE for the teammate-lift tests (teammate-lift.test.ts, teammate-lift-away.test.ts):
// a throwaway sqlite, the REAL persistPr + teammate import, a FAKE GitHub (postReview, the live PR, the
// live reviews and the dismissal are recorded stubs). Split in two files to keep each inside the
// per-file time budget (docs/TESTING.md § The time budget).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { AUTO_POST_DEFAULT_KINDS, limnReviewMarker, parseLimnReviewMarker } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import type { GqlPullRequest } from '../../github/queries.js';


/* eslint-disable @typescript-eslint/no-explicit-any */
export let db: any;
export let schema: any;
export let closeDb: (() => Promise<void> | void) | undefined;
export let ctx: AgentContext;
export let ap: typeof import('./auto-post.js');
export let persist: typeof import('./persist.js');
export let settings: typeof import('./auto-settings.js');
export let upsert: typeof import('../../sync/upsert.js');
export let lift: typeof import('./teammate-lift.js');
export let repoId = 0;
export let wsId = 0;
export let prSeq = 0;

export const MARK = '<!-- pierre:claude-review-finding v=1 -->';
export const ROBIN = { login: 'robin-dev', id: 'U_robin', __typename: 'User' }; // the teammate
export const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' }; // the PR author
export const ALICE = { login: 'alice-dev', id: 'U_alice', __typename: 'User' }; // the reader
export const HEAD = 'b'.repeat(40);

export const robinSummary = (consent: boolean, headSha: string = HEAD): string =>
  `Two things to fix before this lands.\n\n${limnReviewMarker('aa11', {
    headSha,
    run: 'auto',
    pair: false,
    runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }],
    verdict: 'REQUEST_CHANGES',
    limnVersion: '0.1.180',
    liftConsent: consent,
  })}`;

export function gqlPr(n: number, reviewBody: string, author: any = CAROL): GqlPullRequest {
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

export const postReview = vi.fn();
export const settle = vi.fn(async () => ({ visible: true }));
export const dismissReview = vi.fn(async (..._a: unknown[]): Promise<{ ok: true } | { ok: false; message: string }> => ({ ok: true }));
/** The fake GitHub's live head and review list; tests set them. */
export const live: { head: string; list: any[] } = { head: HEAD, list: [] };
export const deps = () => ({
  ...ap.defaultAutoPostDeps,
  livePr: vi.fn(async () => ({ headSha: live.head, state: 'open' as const, draft: false, merged: false })),
  liveReviews: vi.fn(async () => live.list),
  accountLogin: vi.fn(async () => 'alice-dev'),
  impactLevel: vi.fn(async () => 'low' as const),
  isAutomation: vi.fn(async () => false),
  dismissReview,
  settle,
});

export async function setPost(extra: Record<string, unknown>): Promise<void> {
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, { autoPost: { enabled: true, scope: 'all', ...extra } as any });
}

/** A PR with robin's Limn Request changes imported. Returns the PR id, the teammate row and its findings. */
export async function blockedPr(
  o: {
    consent?: boolean;
    body?: string;
    author?: any;
    blockHead?: string;
    // Reshape the synced PR before it is persisted (an earlier review of robin's, say).
    shape?: (pr: any) => void;
  } = {},
): Promise<{ prId: number; teammateId: number; findings: any[]; allFindings: any[]; ghId: string }> {
  prSeq += 1;
  const body = o.body ?? robinSummary(o.consent ?? true, o.blockHead ?? HEAD);
  const pr = gqlPr(prSeq, body, o.author ?? CAROL);
  o.shape?.(pr);
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
  const { and, eq, inArray } = await import('drizzle-orm');
  const prId = (await db.select({ id: schema.pullRequests.id }).from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, `PR_lift_${prSeq}`)).execute())[0].id;
  await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
  const ghId = String(500 + prSeq);
  const rows = await db
    .select()
    .from(schema.claudeReviews)
    .where(and(eq(schema.claudeReviews.prId, prId), eq(schema.claudeReviews.kind, 'teammate')))
    .execute();
  // The block: the teammate row of the review GitHub numbers `ghId`.
  const row = rows.find((r: any) => r.teammate?.githubReviewId === ghId) ?? rows[0];
  const findings = await db.select().from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, row?.id ?? -1)).execute();
  const allFindings =
    rows.length > 0
      ? await db.select().from(schema.claudeReviewFindings).where(inArray(schema.claudeReviewFindings.reviewId, rows.map((r: any) => r.id))).execute()
      : [];
  // On GitHub, live: robin's review(s) as synced, then a thread reply (COMMENTED: never replaces it).
  live.list = [
    ...(pr as any).reviews.nodes.map((r: any) => ({ id: r.fullDatabaseId, login: r.author.login, state: r.state, body: r.body, submittedAt: r.submittedAt })),
    { id: 9_000 + prSeq, login: 'carol-dev', state: 'COMMENTED', body: 'Fixed.' },
  ];
  return { prId, teammateId: row?.id, findings, allFindings, ghId };
}

export const followUpOf = (items: Array<{ id: number; status: string; severity?: string }>) => ({
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
export async function readerRun(
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

export const allAddressed = (findings: any[]) => findings.map((f) => ({ id: f.id, status: 'addressed' }));
export const teammateLiftOf = async (id: number) => {
  const { eq } = await import('drizzle-orm');
  return (await db.select({ l: schema.claudeReviews.teammateLift }).from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute())[0].l;
};
export const autoPostOf = async (id: number) => {
  const { eq } = await import('drizzle-orm');
  return (await db.select({ a: schema.claudeReviews.autoPost }).from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute())[0].a;
};
export const go = (prId: number, reviewId: number) => ap.maybeAutoPostReview(ctx, { accountId: 1, prId, reviewId }, deps());

/**
 * Registers the throwaway sqlite (one per test file: `name`) and the hooks. Call once, at the top of a
 * test file, before any describe.
 */
export function useLiftFixture(name: string): void {
  const dbPath = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/${name}.sqlite`;
  process.env.DATABASE_URL = dbPath;
  process.env.DISABLE_SCHEDULER = 'true';
  beforeAll(async () => {
    for (const x of ['', '-shm', '-wal']) rmSync(dbPath + x, { force: true });
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
    for (const x of ['', '-shm', '-wal']) rmSync(dbPath + x, { force: true });
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
    live.head = HEAD;
    await setPost({ liftTeammateBlocks: true, autoVerdict: false });
  });
}
