// LOCAL BRANCH REVIEWS — THEIR STORAGE (migration 0209; docs/CLAUDE-REVIEW.md § Reviewing a local branch).
// `local_reviews` (one row per run) and `local_review_findings`. EVERY read and write is scoped by accountId:
// an id from another account reads as nothing and writes nothing.
//
// ⚠ ONE RUN IN FLIGHT PER (account, repository, branch) is the partial unique index
// `local_reviews_one_running` (… WHERE status = 'running'): the start's INSERT is the claim
// (`claimLocalReview`); a second start meanwhile inserts nothing and reads the running id.
//
// The shared review-loop core (coding/review-loop/rounds.ts) reads STRUCTURAL rows: `loopRunsOf` maps each
// run's provider halves to `LoopRunLike` rows (a half's id is `runId * 2 + half`, never stored) and the
// findings to `LoopPriorFindingLike`, so the follow-up and the open criteria come from the SAME fold as the
// Build and AI Fix loops. One target per branch: `targetKind: 'branch'`, `targetId: 0`.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReviewFollowUpRecord,
  LocalReviewAnswer,
  LocalReviewKind,
  LocalReviewStatus,
  StoryBuildLoopClaimVerdict,
  StoryBuildLoopResponse,
  TicketAssessment,
} from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import type { LoopCheckLike, LoopPriorFindingLike, LoopRunLike } from '../coding/review-loop/rounds.js';
import type { StoryCheckClaim } from '../coding/review-loop/story-check.js';

type Ctx = Pick<AgentContext, 'db' | 'schema'>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const T = (ctx: Pick<AgentContext, 'schema'>, name: string): any => (ctx.schema as any)[name];
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The one target a branch has (the shared core's rows are per target). */
export const BRANCH_TARGET = { kind: 'branch', id: 0 } as const;

/** One provider half of a run, as stored in `local_reviews.reviewers`. */
export interface LocalReviewHalf {
  provider: 'claude' | 'codex';
  model: string | null;
  effort: string | null;
  status: LocalReviewStatus | 'skipped';
  failureReason: string | null;
  pairRole: 'first' | 'second' | null;
  followUp: ClaudeReviewFollowUpRecord | null;
}

export interface LocalReviewRow {
  id: number;
  accountId: number;
  repoId: number;
  workspaceId: number;
  kind: LocalReviewKind;
  status: LocalReviewStatus;
  branch: string;
  baseRef: string | null;
  baseSha: string;
  headSha: string;
  localRef: string | null;
  includeUncommitted: boolean;
  uncommittedChanges: boolean;
  subjects: string[] | null;
  providerChoice: string | null;
  effortChoice: string | null;
  reviewers: LocalReviewHalf[] | null;
  summary: string | null;
  verdict: string | null;
  pairConsolidation: Record<string, unknown> | null;
  ticketKey: string | null;
  ticketIdent: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  ticketNote: string | null;
  storyStatus: LocalReviewStatus | null;
  storyProvider: string | null;
  storyModel: string | null;
  storyFailure: string | null;
  assessment: TicketAssessment | null;
  claims: StoryCheckClaim[] | null;
  claimVerdicts: StoryBuildLoopClaimVerdict[] | null;
  answers: LocalReviewAnswer[] | null;
  priorReviewId: number | null;
  failureReason: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface LocalReviewFindingRow {
  id: number;
  accountId: number;
  localReviewId: number;
  half: number;
  provider: string | null;
  severity: ClaudeFindingSeverity;
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  title: string;
  body: string;
  suggestion: string | null;
  diffHunk: string | null;
  anchored: boolean;
  fileInDiff: boolean;
  priorFindingId: number | null;
  lens: string | null;
  mergedInto: number | null;
  response: StoryBuildLoopResponse | null;
  responseText: string | null;
  responseReviewId: number | null;
  createdAt: Date | null;
}

export type NewLocalReview = Pick<
  LocalReviewRow,
  | 'repoId'
  | 'workspaceId'
  | 'kind'
  | 'branch'
  | 'baseRef'
  | 'baseSha'
  | 'headSha'
  | 'includeUncommitted'
  | 'uncommittedChanges'
  | 'subjects'
  | 'providerChoice'
  | 'effortChoice'
>;

/**
 * THE START CLAIM: insert a 'running' row. When a run of this (repository, branch) is already running the
 * partial unique index refuses the insert, and its id is returned instead (`alreadyRunning`).
 */
export async function claimLocalReview(ctx: Ctx, accountId: number, row: NewLocalReview): Promise<{ id: number; alreadyRunning: boolean }> {
  const t = T(ctx, 'localReviews');
  const inserted = (await ctx.db
    .insert(t)
    .values({ ...row, accountId, status: 'running' })
    .onConflictDoNothing()
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  if (inserted[0]) return { id: inserted[0].id, alreadyRunning: false };
  const running = (await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.repoId, row.repoId), eq(t.branch, row.branch), eq(t.status, 'running')))
    .limit(1)
    .execute()) as Array<{ id: number }>;
  if (!running[0]) throw new Error('The review could not start.');
  return { id: running[0].id, alreadyRunning: true };
}

export async function getLocalReview(ctx: Ctx, accountId: number, id: number): Promise<LocalReviewRow | null> {
  const t = T(ctx, 'localReviews');
  const rows = (await ctx.db.select().from(t).where(and(eq(t.id, id), eq(t.accountId, accountId))).limit(1).execute()) as LocalReviewRow[];
  return rows[0] ?? null;
}

/** The runs of one repository (and branch), newest first. */
export async function listLocalReviews(ctx: Ctx, accountId: number, repoId: number, branch: string | null, limit = 20): Promise<LocalReviewRow[]> {
  const t = T(ctx, 'localReviews');
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.repoId, repoId), ...(branch != null ? [eq(t.branch, branch)] : [])))
    .orderBy(desc(t.id))
    .limit(limit)
    .execute()) as LocalReviewRow[];
}

export async function updateLocalReview(ctx: Ctx, accountId: number, id: number, set: Partial<Omit<LocalReviewRow, 'id' | 'accountId'>>): Promise<void> {
  if (Object.keys(set).length === 0) return;
  const t = T(ctx, 'localReviews');
  await ctx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

/** End a run: only a run still 'running' moves (a cancel and a finish never overwrite each other). */
export async function finishLocalReview(
  ctx: Ctx,
  accountId: number,
  id: number,
  status: Exclude<LocalReviewStatus, 'running'>,
  set: Partial<Omit<LocalReviewRow, 'id' | 'accountId' | 'status'>> = {},
): Promise<boolean> {
  const t = T(ctx, 'localReviews');
  const rows = (await ctx.db
    .update(t)
    .set({ ...set, status, completedAt: set.completedAt ?? new Date() })
    .where(and(eq(t.id, id), eq(t.accountId, accountId), eq(t.status, 'running')))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

export type NewLocalFinding = Omit<LocalReviewFindingRow, 'id' | 'accountId' | 'mergedInto' | 'response' | 'responseText' | 'responseReviewId' | 'createdAt'>;

export async function insertLocalFindings(ctx: Ctx, accountId: number, rows: readonly NewLocalFinding[]): Promise<void> {
  if (rows.length === 0) return;
  const t = T(ctx, 'localReviewFindings');
  await ctx.db
    .insert(t)
    .values(rows.map((r) => ({ ...r, accountId })))
    .execute();
}

export async function listLocalFindings(ctx: Ctx, accountId: number, reviewIds: readonly number[]): Promise<LocalReviewFindingRow[]> {
  if (reviewIds.length === 0) return [];
  const t = T(ctx, 'localReviewFindings');
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.accountId, accountId), inArray(t.localReviewId, [...reviewIds])))
    .orderBy(t.id)
    .execute()) as LocalReviewFindingRow[];
}

export async function updateLocalFinding(
  ctx: Ctx,
  accountId: number,
  id: number,
  set: Partial<Pick<LocalReviewFindingRow, 'mergedInto' | 'response' | 'responseText' | 'responseReviewId'>>,
): Promise<void> {
  const t = T(ctx, 'localReviewFindings');
  await ctx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

/** Of these run ids, the ones still 'running' (the local refs' keeper: any account). */
export async function runningLocalReviewIds(ctx: Ctx, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const t = T(ctx, 'localReviews');
  const rows = (await ctx.db.select({ id: t.id }).from(t).where(and(inArray(t.id, [...ids]), eq(t.status, 'running'))).execute()) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/** A run this process lost (a restart mid-review): failed, with a plain line. Returns how many. */
export async function failOrphanedLocalReviews(ctx: Ctx): Promise<number> {
  const t = T(ctx, 'localReviews');
  const rows = (await ctx.db
    .update(t)
    .set({ status: 'failed', failureReason: 'Ensemble restarted before the review finished. Start it again.', completedAt: new Date() })
    .where(eq(t.status, 'running'))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

// ---- the shared core's structural rows ----------------------------------------------------------------------

/** A half's synthetic run id (never stored): the findings' `half` points at it. */
export const halfRunId = (runId: number, half: number): number => runId * 2 + half;

/**
 * The code-review runs of a branch as the shared core reads them (oldest first): each run is a ROUND (its
 * ordinal), each provider half one `LoopRunLike`. Story-only runs carry no review half.
 */
export function loopRunsOf(runs: readonly LocalReviewRow[]): { reviews: LoopRunLike[]; roundOf: Map<number, number> } {
  const ordered = [...runs].sort((a, z) => a.id - z.id);
  const roundOf = new Map<number, number>();
  const reviews: LoopRunLike[] = [];
  ordered.forEach((r, n) => {
    roundOf.set(r.id, n + 1);
    (r.reviewers ?? []).forEach((h, half) => {
      reviews.push({
        id: halfRunId(r.id, half),
        round: n + 1,
        targetKind: BRANCH_TARGET.kind,
        targetId: BRANCH_TARGET.id,
        status: h.status,
        pairRole: h.pairRole,
        followUp: h.followUp,
        headSha: r.headSha,
        provider: h.provider,
      });
    });
  });
  return { reviews, roundOf };
}

/** The findings as the shared core reads them (their run is the half's synthetic id). */
export function loopFindingsOf(findings: readonly LocalReviewFindingRow[]): LoopPriorFindingLike[] {
  return findings.map((f) => ({
    id: f.id,
    reviewId: halfRunId(f.localReviewId, f.half),
    severity: f.severity,
    mergedInto: f.mergedInto,
    path: f.path,
    line: f.line,
    side: f.side,
    title: f.title,
    body: f.body,
    suggestion: f.suggestion,
    diffHunk: f.diffHunk,
    anchored: f.anchored,
    fileInDiff: f.fileInDiff,
    response: f.response,
    responseText: f.responseText,
    createdAt: f.createdAt,
  }));
}

/** The story checks of a branch as the shared core reads them (round = the run's ordinal). */
export function loopChecksOf(runs: readonly LocalReviewRow[], roundOf: ReadonlyMap<number, number>): LoopCheckLike[] {
  return runs
    .filter((r) => r.storyStatus != null)
    .map((r) => ({ round: roundOf.get(r.id) ?? 0, status: r.storyStatus!, assessment: r.assessment, claimVerdicts: r.claimVerdicts }));
}
