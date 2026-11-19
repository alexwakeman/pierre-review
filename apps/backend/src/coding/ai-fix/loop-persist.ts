// AI FIX'S REVIEW LOOP — ITS STORAGE (migration 0207; docs/CLAUDE-REVIEW.md § AI Fix → The review loop). Four
// `ai_fix_loop_*` tables keyed (account_id, fix_id, round) plus the loop columns on `ai_fixes`. EVERY read and
// write is scoped by accountId: an id from another account reads as nothing and writes nothing. The rows carry
// the STRUCTURAL fields the shared loop core reads (coding/review-loop/rounds.ts): one target per fix, so every
// run reads `targetKind: 'fix'`, `targetId: 0`.
import { and, asc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type {
  AiFixLoopState,
  AiFixLoopStop,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReviewFollowUpRecord,
  ClaudeReviewPairConsolidation,
  StoryBuildLoopAcResponse,
  StoryBuildLoopClaimVerdict,
  StoryBuildLoopResponse,
  TicketAssessment,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { StoryCheckClaim } from '../review-loop/story-check.js';

type Ctx = Pick<AgentContext, 'db' | 'schema'>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const T = (ctx: Pick<AgentContext, 'schema'>, name: string): any => (ctx.schema as any)[name];
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The one target a fix's loop has (the shared core's rows are per target). */
export const FIX_TARGET = { kind: 'fix', id: 0 } as const;

// ---- the fix's loop columns ---------------------------------------------------------------------------------

export interface FixLoopColumns {
  loopState: AiFixLoopState | null;
  loopRound: number;
  loopFirstRound: number;
  loopRounds: number | null;
  loopStop: AiFixLoopStop | null;
  loopBaseSha: string | null;
  loopReviewId: number | null;
  loopFinishedAt: Date | null;
}

export async function setFixLoop(ctx: Ctx, accountId: number, fixId: number, set: Partial<FixLoopColumns>): Promise<void> {
  if (Object.keys(set).length === 0) return;
  const t = T(ctx, 'aiFixes');
  await ctx.db.update(t).set(set).where(and(eq(t.id, fixId), eq(t.accountId, accountId))).execute();
}

/**
 * THE START CLAIM (compare-and-set): the fix's loop is not working now (never ran, or ended). A second start
 * meanwhile writes nothing and returns false.
 */
export async function claimFixLoopStart(ctx: Ctx, accountId: number, fixId: number, set: { firstRound: number; rounds: number }): Promise<boolean> {
  const t = T(ctx, 'aiFixes');
  const rows = (await ctx.db
    .update(t)
    .set({ loopState: 'reviewing', loopRound: set.firstRound, loopFirstRound: set.firstRound, loopRounds: set.rounds, loopStop: null, loopFinishedAt: null })
    .where(and(eq(t.id, fixId), eq(t.accountId, accountId), isNull(t.pushedAt), or(isNull(t.loopState), notInArray(t.loopState, ['reviewing', 'fixing']))))
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

// ---- the runs ------------------------------------------------------------------------------------------------

export interface FixLoopReviewRow {
  id: number;
  accountId: number;
  fixId: number;
  round: number;
  repoId: number;
  baseSha: string;
  headSha: string;
  localRef: string | null;
  workKey: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  pairRole: 'first' | 'second' | null;
  /** The round's place in its loop run, and that run's N (null on a row written before they were stored). */
  step: number | null;
  rounds: number | null;
  status: string;
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
  createdAt: Date | null;
  completedAt: Date | null;
  /** Structural (the shared core's): one target. */
  targetKind: 'fix';
  targetId: 0;
}

export async function listFixLoopReviews(ctx: Ctx, accountId: number, fixId: number): Promise<FixLoopReviewRow[]> {
  const t = T(ctx, 'aiFixLoopReviews');
  const rows = (await ctx.db.select().from(t).where(and(eq(t.fixId, fixId), eq(t.accountId, accountId))).orderBy(asc(t.id)).execute()) as Array<Omit<FixLoopReviewRow, 'targetKind' | 'targetId'>>;
  return rows.map((r) => ({ ...r, targetKind: FIX_TARGET.kind, targetId: FIX_TARGET.id }));
}

export async function insertFixLoopReview(
  ctx: Ctx,
  accountId: number,
  a: { fixId: number; round: number; repoId: number; baseSha: string; headSha: string; localRef: string | null; workKey: string | null; provider: string; pairRole: 'first' | 'second' | null; step: number; rounds: number; status: string },
): Promise<number> {
  const t = T(ctx, 'aiFixLoopReviews');
  const rows = (await ctx.db
    .insert(t)
    .values({ accountId, ...a })
    .onConflictDoUpdate({
      target: [t.fixId, t.round, t.provider],
      set: { baseSha: a.baseSha, headSha: a.headSha, localRef: a.localRef, workKey: a.workKey, pairRole: a.pairRole, step: a.step, rounds: a.rounds, status: a.status, failureReason: null, completedAt: null, summary: null, verdict: null, followUp: null, pairConsolidation: null },
    })
    .returning({ id: t.id })
    .execute()) as Array<{ id: number }>;
  return rows[0]!.id;
}

export async function updateFixLoopReview(ctx: Ctx, accountId: number, id: number, set: Record<string, unknown>): Promise<void> {
  const t = T(ctx, 'aiFixLoopReviews');
  await ctx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

/** A round re-run: its unsucceeded runs (and their findings) go first, so the round reads as one attempt. */
export async function dropUnsucceededFixLoopReviews(ctx: Ctx, accountId: number, fixId: number, round: number): Promise<void> {
  const t = T(ctx, 'aiFixLoopReviews');
  const f = T(ctx, 'aiFixLoopFindings');
  const ids = ((await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.fixId, fixId), eq(t.accountId, accountId), eq(t.round, round), notInArray(t.status, ['succeeded'])))
    .execute()) as Array<{ id: number }>).map((r) => r.id);
  if (ids.length === 0) return;
  await ctx.db.delete(f).where(and(eq(f.accountId, accountId), inArray(f.reviewId, ids))).execute();
  await ctx.db.delete(t).where(and(eq(t.accountId, accountId), inArray(t.id, ids))).execute();
}

/** BOOT: every run a restart cut off reads cancelled. */
export async function cancelRunningFixLoopRuns(ctx: Ctx, accountId: number, fixId: number): Promise<void> {
  const t = T(ctx, 'aiFixLoopReviews');
  const c = T(ctx, 'aiFixLoopStoryChecks');
  await ctx.db.update(t).set({ status: 'cancelled', failureReason: 'Ensemble restarted.' }).where(and(eq(t.fixId, fixId), eq(t.accountId, accountId), eq(t.status, 'running'))).execute();
  await ctx.db.update(c).set({ status: 'cancelled', failureReason: 'Ensemble restarted.' }).where(and(eq(c.fixId, fixId), eq(c.accountId, accountId), eq(c.status, 'running'))).execute();
}

// ---- findings ------------------------------------------------------------------------------------------------

export interface FixLoopFindingRow {
  id: number;
  accountId: number;
  reviewId: number;
  fixId: number;
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
  createdAt: Date | null;
}

export async function listFixLoopFindings(ctx: Ctx, accountId: number, fixId: number): Promise<FixLoopFindingRow[]> {
  const t = T(ctx, 'aiFixLoopFindings');
  return (await ctx.db.select().from(t).where(and(eq(t.fixId, fixId), eq(t.accountId, accountId))).orderBy(asc(t.id)).execute()) as FixLoopFindingRow[];
}

export async function insertFixLoopFindings(
  ctx: Ctx,
  accountId: number,
  rows: ReadonlyArray<Omit<FixLoopFindingRow, 'id' | 'accountId' | 'mergedInto' | 'ref' | 'response' | 'responseText' | 'responseRound' | 'createdAt'>>,
): Promise<void> {
  if (rows.length === 0) return;
  const t = T(ctx, 'aiFixLoopFindings');
  await ctx.db.insert(t).values(rows.map((r) => ({ accountId, ...r }))).execute();
}

export async function updateFixLoopFinding(
  ctx: Ctx,
  accountId: number,
  id: number,
  set: Partial<Pick<FixLoopFindingRow, 'mergedInto' | 'ref' | 'response' | 'responseText' | 'responseRound'>>,
): Promise<void> {
  const t = T(ctx, 'aiFixLoopFindings');
  await ctx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.accountId, accountId))).execute();
}

// ---- story checks --------------------------------------------------------------------------------------------

export interface FixLoopStoryCheckRow {
  id: number;
  accountId: number;
  fixId: number;
  round: number;
  status: string;
  provider: string | null;
  model: string | null;
  assessment: TicketAssessment | null;
  claims: StoryCheckClaim[] | null;
  claimVerdicts: StoryBuildLoopClaimVerdict[] | null;
  failureReason: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  createdAt: Date | null;
  completedAt: Date | null;
}

export async function listFixLoopStoryChecks(ctx: Ctx, accountId: number, fixId: number): Promise<FixLoopStoryCheckRow[]> {
  const t = T(ctx, 'aiFixLoopStoryChecks');
  return (await ctx.db.select().from(t).where(and(eq(t.fixId, fixId), eq(t.accountId, accountId))).orderBy(asc(t.round)).execute()) as FixLoopStoryCheckRow[];
}

export async function upsertFixLoopStoryCheck(
  ctx: Ctx,
  accountId: number,
  a: Omit<FixLoopStoryCheckRow, 'id' | 'accountId' | 'createdAt'>,
): Promise<void> {
  const t = T(ctx, 'aiFixLoopStoryChecks');
  const { fixId, round, ...rest } = a;
  await ctx.db
    .insert(t)
    .values({ accountId, fixId, round, ...rest })
    .onConflictDoUpdate({ target: [t.fixId, t.round], set: rest })
    .execute();
}

// ---- criterion answers ------------------------------------------------------------------------------------------

export interface FixLoopAcResponseRow {
  id: number;
  accountId: number;
  fixId: number;
  round: number;
  ref: string;
  response: StoryBuildLoopAcResponse;
  text: string | null;
}

export async function listFixLoopAcResponses(ctx: Ctx, accountId: number, fixId: number): Promise<FixLoopAcResponseRow[]> {
  const t = T(ctx, 'aiFixLoopAcResponses');
  return (await ctx.db.select().from(t).where(and(eq(t.fixId, fixId), eq(t.accountId, accountId))).orderBy(asc(t.id)).execute()) as FixLoopAcResponseRow[];
}

export async function upsertFixLoopAcResponse(
  ctx: Ctx,
  accountId: number,
  a: { fixId: number; round: number; ref: string; response: StoryBuildLoopAcResponse; text: string | null },
): Promise<void> {
  const t = T(ctx, 'aiFixLoopAcResponses');
  await ctx.db
    .insert(t)
    .values({ accountId, ...a })
    .onConflictDoUpdate({ target: [t.fixId, t.round, t.ref], set: { response: a.response, text: a.text } })
    .execute();
}
