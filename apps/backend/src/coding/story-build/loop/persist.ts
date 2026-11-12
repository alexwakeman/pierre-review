// THE REVIEW LOOP'S STORAGE (migration 0186; docs/STORY-BUILD.md § The review loop). Five tables plus the
// loop columns on `story_builds`, `story_build_repos` and `story_build_prs`. EVERY read and write is scoped
// by accountId: an id from another account reads as nothing and writes nothing. Portable terminals only.
//
// ⚠ THE CLAIMS: a GitHub write of the loop is a `story_build_loop_pushes` row INSERTED before the write; the
// unique `(build_id, round, step, target_kind, target_id, attempt)` makes the insert the compare-and-set.
// A row is never written twice and never retried by itself: a new attempt is a new row (the reader's Continue).
import { and, asc, eq, inArray, isNull as isNullCol } from 'drizzle-orm';
import type {
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReviewFollowUpRecord,
  ClaudeReviewPairConsolidation,
  StoryBuildLoopAcResponse,
  StoryBuildLoopClaimVerdict,
  StoryBuildLoopPause,
  StoryBuildLoopResponse,
  StoryBuildLoopState,
  StoryBuildLoopTargetKind,
  TicketAssessment,
} from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import { updateStoryBuild, updateStoryBuildRepo } from '../persist.js';
import { updateStoryBuildPr } from '../plan-persist.js';

type Ctx = Pick<AgentContext, 'db' | 'schema'>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const T = (ctx: Pick<AgentContext, 'schema'>, name: string): any => (ctx.schema as any)[name];
/* eslint-enable @typescript-eslint/no-explicit-any */

export type LoopStep = 'branch' | 'fix' | 'open';
/** The steps Continue goes back to. */
export type LoopResume = 'pushing' | 'reviewing' | 'fixing' | 'opening';

// ---- the build's loop columns -----------------------------------------------------------------------

export interface LoopColumns {
  loopState: StoryBuildLoopState | null;
  loopRound: number;
  loopPause: StoryBuildLoopPause | null;
  loopError: string | null;
  loopResume: LoopResume | null;
}

/** Write the loop columns (scoped by account). */
export async function setLoop(ctx: Ctx, accountId: number, buildId: number, set: Partial<LoopColumns> & { loopFinishedAt?: Date | null; loopClaimedAt?: Date | null; loopRounds?: number }): Promise<boolean> {
  return updateStoryBuild(ctx, accountId, buildId, set as Parameters<typeof updateStoryBuild>[3]);
}

/**
 * THE START CLAIM (compare-and-set, once per build): the option is on, the loop never claimed, the build
 * ready. Also stamps `auto_push_claimed_at`, so the old automatic push and its switch read "started".
 */
export async function claimLoopStart(ctx: Ctx, accountId: number, buildId: number, now: Date): Promise<boolean> {
  const b = T(ctx, 'storyBuilds');
  const rows = (await ctx.db
    .update(b)
    .set({ loopClaimedAt: now, autoPushClaimedAt: now, autoPushError: null, loopState: 'pushing', loopRound: 0, loopPause: null, loopError: null, loopResume: null })
    .where(and(eq(b.id, buildId), eq(b.accountId, accountId), eq(b.autoPush, true), eq(b.status, 'ready'), isNullCol(b.loopClaimedAt)))
    .returning({ id: b.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/** One target's loop columns. */
export interface LoopTargetSet {
  loopBranch?: string | null;
  loopPushedSha?: string | null;
  loopPushedTree?: string | null;
  loopPushedAt?: Date | null;
  loopEnded?: 'pr_opened' | 'manual_push' | 'stopped' | null;
  pushError?: string | null;
  pushErrorCode?: string | null;
  status?: string;
  branch?: string;
  pushedBranch?: string | null;
  pushedPrNumber?: number | null;
  pushedPrUrl?: string | null;
  pushedCommitSha?: string | null;
  pushedAt?: Date | null;
  prTitle?: string | null;
  prBody?: string | null;
}

export async function updateLoopTarget(ctx: Ctx, accountId: number, kind: StoryBuildLoopTargetKind, id: number, set: LoopTargetSet): Promise<boolean> {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return kind === 'pr' ? updateStoryBuildPr(ctx as any, accountId, id, set as any) : updateStoryBuildRepo(ctx, accountId, id, set as any);
}

// ---- story_build_loop_pushes --------------------------------------------------------------------------

export interface LoopPushRow {
  id: number;
  accountId: number;
  buildId: number;
  round: number;
  step: LoopStep;
  targetKind: StoryBuildLoopTargetKind;
  targetId: number;
  attempt: number;
  branch: string;
  parentSha: string | null;
  expectTree: string | null;
  claimedAt: Date;
  pushedSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  doneAt: Date | null;
  error: string | null;
  errorCode: string | null;
}

export async function listLoopPushes(ctx: Ctx, accountId: number, buildId: number): Promise<LoopPushRow[]> {
  const t = T(ctx, 'storyBuildLoopPushes');
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.buildId, buildId), eq(t.accountId, accountId)))
    .orderBy(asc(t.id))
    .execute()) as LoopPushRow[];
}

/** The latest attempt of one (round, step, target), or null. */
export function latestPush(rows: readonly LoopPushRow[], round: number, step: LoopStep, kind: StoryBuildLoopTargetKind, id: number): LoopPushRow | null {
  const mine = rows.filter((r) => r.round === round && r.step === step && r.targetKind === kind && r.targetId === id);
  return mine.sort((a, b) => b.attempt - a.attempt)[0] ?? null;
}

/**
 * THE CLAIM of one GitHub write: insert the row (the unique index is the compare-and-set). Returns the row
 * id, or null when that attempt was already claimed (by another caller, or a restart cut it).
 */
export async function claimLoopPush(
  ctx: Ctx,
  accountId: number,
  a: { buildId: number; round: number; step: LoopStep; targetKind: StoryBuildLoopTargetKind; targetId: number; attempt: number; branch: string; parentSha?: string | null; expectTree?: string | null; now: Date },
): Promise<number | null> {
  const t = T(ctx, 'storyBuildLoopPushes');
  try {
    const rows = (await ctx.db
      .insert(t)
      .values({
        accountId,
        buildId: a.buildId,
        round: a.round,
        step: a.step,
        targetKind: a.targetKind,
        targetId: a.targetId,
        attempt: a.attempt,
        branch: a.branch,
        parentSha: a.parentSha ?? null,
        expectTree: a.expectTree ?? null,
        claimedAt: a.now,
      })
      .returning({ id: t.id })
      .execute()) as Array<{ id: number }>;
    return rows[0]?.id ?? null;
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String((err as Error)?.message ?? ''))) return null;
    throw err;
  }
}

export async function finishLoopPush(ctx: Ctx, accountId: number, id: number, set: { pushedSha?: string | null; prNumber?: number | null; prUrl?: string | null; doneAt: Date }): Promise<void> {
  const t = T(ctx, 'storyBuildLoopPushes');
  await ctx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

export async function failLoopPush(ctx: Ctx, accountId: number, id: number, error: string, errorCode: string): Promise<void> {
  const t = T(ctx, 'storyBuildLoopPushes');
  await ctx.db.update(t).set({ error, errorCode }).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

// ---- story_build_reviews + findings -------------------------------------------------------------------

export type LoopReviewStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface LoopReviewRow {
  id: number;
  accountId: number;
  buildId: number;
  round: number;
  targetKind: StoryBuildLoopTargetKind;
  targetId: number;
  repoId: number;
  branch: string;
  baseSha: string;
  headSha: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  pairRole: 'first' | 'second' | null;
  status: LoopReviewStatus;
  reviewMode: string | null;
  summary: string | null;
  verdict: string | null;
  followUp: ClaudeReviewFollowUpRecord | null;
  pairConsolidation: ClaudeReviewPairConsolidation | null;
  failureReason: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface LoopFindingRow {
  id: number;
  accountId: number;
  reviewId: number;
  buildId: number;
  round: number;
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
  ref: string | null;
  response: StoryBuildLoopResponse | null;
  responseText: string | null;
  responseRound: number | null;
  createdAt: Date;
}

export async function listLoopReviews(ctx: Ctx, accountId: number, buildId: number): Promise<LoopReviewRow[]> {
  const t = T(ctx, 'storyBuildReviews');
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.buildId, buildId), eq(t.accountId, accountId)))
    .orderBy(asc(t.id))
    .execute()) as LoopReviewRow[];
}

export async function listLoopFindings(ctx: Ctx, accountId: number, buildId: number): Promise<LoopFindingRow[]> {
  const t = T(ctx, 'storyBuildReviewFindings');
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.buildId, buildId), eq(t.accountId, accountId)))
    .orderBy(asc(t.id))
    .execute()) as LoopFindingRow[];
}

export interface InsertLoopReview {
  buildId: number;
  round: number;
  targetKind: StoryBuildLoopTargetKind;
  targetId: number;
  repoId: number;
  branch: string;
  baseSha: string;
  headSha: string;
  provider: string;
  model: string | null;
  pairRole: 'first' | 'second' | null;
  status: LoopReviewStatus;
}

export async function insertLoopReview(ctx: Ctx, accountId: number, a: InsertLoopReview): Promise<number> {
  const t = T(ctx, 'storyBuildReviews');
  const rows = (await ctx.db
    .insert(t)
    .values({ accountId, ...a, createdAt: new Date() })
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

export async function updateLoopReview(ctx: Ctx, accountId: number, id: number, set: Partial<Omit<LoopReviewRow, 'id' | 'accountId' | 'buildId'>>): Promise<void> {
  const t = T(ctx, 'storyBuildReviews');
  await ctx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

/** Re-running a round: its runs that did not succeed go (their findings cascade), so the unique run key is free. */
export async function dropUnsucceededReviews(ctx: Ctx, accountId: number, buildId: number, round: number): Promise<void> {
  const t = T(ctx, 'storyBuildReviews');
  const f = T(ctx, 'storyBuildReviewFindings');
  const rows = (await ctx.db
    .select({ id: t.id, status: t.status })
    .from(t)
    .where(and(eq(t.buildId, buildId), eq(t.accountId, accountId), eq(t.round, round)))
    .execute()) as Array<{ id: number; status: string }>;
  const ids = rows.filter((r) => r.status !== 'succeeded').map((r) => r.id);
  if (ids.length === 0) return;
  await ctx.db.delete(f).where(and(eq(f.accountId, accountId), inArray(f.reviewId, ids))).execute();
  await ctx.db.delete(t).where(and(eq(t.accountId, accountId), inArray(t.id, ids))).execute();
}

export type InsertLoopFinding = Omit<LoopFindingRow, 'id' | 'accountId' | 'createdAt' | 'mergedInto' | 'ref' | 'response' | 'responseText' | 'responseRound'>;

export async function insertLoopFindings(ctx: Ctx, accountId: number, rows: readonly InsertLoopFinding[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const t = T(ctx, 'storyBuildReviewFindings');
  const out = (await ctx.db
    .insert(t)
    .values(rows.map((r) => ({ accountId, ...r, createdAt: new Date() })))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return out.map((r) => r.id);
}

export async function updateLoopFinding(
  ctx: Ctx,
  accountId: number,
  id: number,
  set: Partial<Pick<LoopFindingRow, 'mergedInto' | 'ref' | 'response' | 'responseText' | 'responseRound'>>,
): Promise<void> {
  const t = T(ctx, 'storyBuildReviewFindings');
  await ctx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

// ---- story checks + criterion answers -----------------------------------------------------------------

export interface LoopStoryCheckMember {
  ref: string;
  targetKind: StoryBuildLoopTargetKind;
  targetId: number;
  repoId: number;
  repo: string;
  branch: string;
  headSha: string;
}

export interface LoopClaim {
  ref: string;
  kind: 'not_applicable' | 'answer';
  text: string;
}

export interface LoopStoryCheckRow {
  id: number;
  accountId: number;
  buildId: number;
  round: number;
  status: LoopReviewStatus;
  provider: string | null;
  model: string | null;
  assessment: TicketAssessment | null;
  members: LoopStoryCheckMember[] | null;
  claims: LoopClaim[] | null;
  claimVerdicts: StoryBuildLoopClaimVerdict[] | null;
  failureReason: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export async function listLoopStoryChecks(ctx: Ctx, accountId: number, buildId: number): Promise<LoopStoryCheckRow[]> {
  const t = T(ctx, 'storyBuildStoryChecks');
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.buildId, buildId), eq(t.accountId, accountId)))
    .orderBy(asc(t.round))
    .execute()) as LoopStoryCheckRow[];
}

/** One round's story check (ON CONFLICT `(build_id, round)`: a re-run replaces a failed one). */
export async function upsertLoopStoryCheck(
  ctx: Ctx,
  accountId: number,
  a: Omit<LoopStoryCheckRow, 'id' | 'accountId' | 'createdAt'>,
): Promise<void> {
  const t = T(ctx, 'storyBuildStoryChecks');
  const set = {
    status: a.status,
    provider: a.provider,
    model: a.model,
    assessment: a.assessment,
    members: a.members,
    claims: a.claims,
    claimVerdicts: a.claimVerdicts,
    failureReason: a.failureReason,
    costUsd: a.costUsd,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    numTurns: a.numTurns,
    completedAt: a.completedAt,
  };
  await ctx.db
    .insert(t)
    .values({ accountId, buildId: a.buildId, round: a.round, ...set, createdAt: new Date() })
    .onConflictDoUpdate({ target: [t.buildId, t.round], set: { ...set } })
    .execute();
}

export interface LoopAcResponseRow {
  id: number;
  accountId: number;
  buildId: number;
  round: number;
  ref: string;
  response: StoryBuildLoopAcResponse;
  text: string | null;
}

export async function listLoopAcResponses(ctx: Ctx, accountId: number, buildId: number): Promise<LoopAcResponseRow[]> {
  const t = T(ctx, 'storyBuildAcResponses');
  return (await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.buildId, buildId), eq(t.accountId, accountId)))
    .orderBy(asc(t.id))
    .execute()) as LoopAcResponseRow[];
}

export async function upsertLoopAcResponse(ctx: Ctx, accountId: number, a: { buildId: number; round: number; ref: string; response: StoryBuildLoopAcResponse; text: string | null }): Promise<void> {
  const t = T(ctx, 'storyBuildAcResponses');
  await ctx.db
    .insert(t)
    .values({ accountId, ...a })
    .onConflictDoUpdate({ target: [t.buildId, t.round, t.ref], set: { response: a.response, text: a.text } })
    .execute();
}
