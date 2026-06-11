import { eq, inArray } from 'drizzle-orm';
import type {
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReviewModel,
  ClaudeReviewScope,
  ClaudeReviewVerdict,
  ReviewMode,
  ReviewRouteReason,
} from '@pierre-review/shared';
import { db, runTransaction, schema } from '../db/client.js';

const { claudeReviewFindings, claudeReviews } = schema;

// One finding as produced by a run, ready to persist. `anchored` is decided by
// the line-anchoring pass against the (noise-stripped) head diff.
export interface PersistedFinding {
  path: string;
  line: number | null;
  side: ClaudeFindingSide;
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  suggestion: string | null;
  diffHunk: string | null;
  anchored: boolean;
}

export interface ReviewSuccess {
  // null only for a 'skip' run (no agent, so no self-reported scope).
  scope: ClaudeReviewScope | null;
  summary: string;
  verdict: ClaudeReviewVerdict;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  excludedFiles: string[];
  findings: PersistedFinding[];
}

// Telemetry that may exist even on a failed run (e.g. budget-exceeded carries a
// cost). All optional.
export interface ReviewTelemetry {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  numTurns?: number | null;
  scope?: ClaudeReviewScope | null;
  excludedFiles?: string[];
}

export async function insertQueuedReview(
  prId: number,
  headSha: string,
  model: ClaudeReviewModel,
  accountId: number,
): Promise<number> {
  const rows = await db
    .insert(claudeReviews)
    .values({ accountId, prId, headSha, status: 'queued', model })
    .returning({ id: claudeReviews.id })
    .execute();
  return rows[0]!.id;
}

export async function markReviewRunning(id: number): Promise<void> {
  await db
    .update(claudeReviews)
    .set({ status: 'running' })
    .where(eq(claudeReviews.id, id))
    .execute();
}

// Stamp the router's decision (resolved mode + the metrics behind it) on the run,
// once the diff is fetched and the mode is chosen — BEFORE the agent runs (or, for
// 'skip', instead of running it). Recorded for audit/calibration; `scope` (the
// agent's self-report) is set later by saveReviewSuccess.
export async function markReviewRouted(
  id: number,
  reviewMode: ReviewMode,
  routeReason: ReviewRouteReason,
): Promise<void> {
  await db
    .update(claudeReviews)
    .set({ reviewMode, routeReason })
    .where(eq(claudeReviews.id, id))
    .execute();
}

// Record the agent's result + insert its findings, in one transaction. Claude's
// summary/verdict are stored read-only; the user's `userBody`/`userVerdict` stay
// null (the "Your review" box starts empty).
export async function saveReviewSuccess(
  id: number,
  data: ReviewSuccess,
): Promise<void> {
  await runTransaction(async (tx) => {
    await tx
      .update(claudeReviews)
      .set({
        status: 'succeeded',
        scope: data.scope,
        summary: data.summary,
        verdict: data.verdict,
        costUsd: data.costUsd,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        numTurns: data.numTurns,
        excludedFiles: data.excludedFiles,
        finishedAt: new Date(),
      })
      .where(eq(claudeReviews.id, id))
      .execute();
    for (const f of data.findings) {
      await tx
        .insert(claudeReviewFindings)
        .values({
          reviewId: id,
          path: f.path,
          line: f.line,
          side: f.side,
          severity: f.severity,
          title: f.title,
          body: f.body,
          suggestion: f.suggestion,
          diffHunk: f.diffHunk,
          anchored: f.anchored,
          // Findings are INCLUDED by default — the UI is opt-OUT ("Ignore"), so a
          // fresh review posts every (anchored) finding unless the user sets it
          // aside. (The column default is false for back-compat; we set it here.)
          included: true,
        })
        .execute();
    }
  });
}

export async function markReviewFailed(
  id: number,
  error: string,
  telemetry: ReviewTelemetry = {},
): Promise<void> {
  await db
    .update(claudeReviews)
    .set({
      status: 'failed',
      error: error.slice(0, 4000),
      costUsd: telemetry.costUsd ?? null,
      inputTokens: telemetry.inputTokens ?? null,
      outputTokens: telemetry.outputTokens ?? null,
      numTurns: telemetry.numTurns ?? null,
      scope: telemetry.scope ?? null,
      excludedFiles: telemetry.excludedFiles ?? null,
      finishedAt: new Date(),
    })
    .where(eq(claudeReviews.id, id))
    .execute();
}

export async function markReviewCancelled(id: number): Promise<void> {
  await db
    .update(claudeReviews)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(eq(claudeReviews.id, id))
    .execute();
}

// Save the user's authored draft. Returns false if the run doesn't exist.
export async function updateReviewDraft(
  id: number,
  fields: { userBody?: string; userVerdict?: ClaudeReviewVerdict },
): Promise<boolean> {
  const set = {
    ...(fields.userBody !== undefined ? { userBody: fields.userBody } : {}),
    ...(fields.userVerdict !== undefined
      ? { userVerdict: fields.userVerdict }
      : {}),
  };
  if (Object.keys(set).length === 0) return true;
  const changed = await db
    .update(claudeReviews)
    .set(set)
    .where(eq(claudeReviews.id, id))
    .returning({ id: claudeReviews.id })
    .execute();
  return changed.length > 0;
}

// Tick/untick a finding and/or save the user's reworded body. An empty-string
// editedBody clears the reword (reverts to Claude's wording). Returns false if
// the finding doesn't exist.
export async function updateFinding(
  findingId: number,
  fields: { included?: boolean; editedBody?: string },
): Promise<boolean> {
  const set = {
    ...(fields.included !== undefined ? { included: fields.included } : {}),
    ...(fields.editedBody !== undefined
      ? { editedBody: fields.editedBody === '' ? null : fields.editedBody }
      : {}),
  };
  if (Object.keys(set).length === 0) return true;
  const changed = await db
    .update(claudeReviewFindings)
    .set(set)
    .where(eq(claudeReviewFindings.id, findingId))
    .returning({ id: claudeReviewFindings.id })
    .execute();
  return changed.length > 0;
}

// Stamp the run + its posted findings after a successful GitHub submit.
export async function markReviewPosted(
  id: number,
  postedReviewId: string,
  postedFindingIds: number[],
): Promise<void> {
  const now = new Date();
  await runTransaction(async (tx) => {
    await tx
      .update(claudeReviews)
      .set({ postedReviewId, postedAt: now })
      .where(eq(claudeReviews.id, id))
      .execute();
    if (postedFindingIds.length > 0) {
      await tx
        .update(claudeReviewFindings)
        .set({ postedAt: now })
        .where(inArray(claudeReviewFindings.id, postedFindingIds))
        .execute();
    }
  });
}

// Stamp a single finding posted as a standalone inline comment.
export async function markFindingPosted(
  findingId: number,
  githubCommentId: string,
): Promise<void> {
  await db
    .update(claudeReviewFindings)
    .set({ postedAt: new Date(), githubCommentId })
    .where(eq(claudeReviewFindings.id, findingId))
    .execute();
}

// On startup, heal runs left mid-flight by a crash/restart (our `running` status
// is persisted, unlike the sync manager's purely in-memory guard).
export async function reconcileOrphanedReviews(): Promise<number> {
  const changed = await db
    .update(claudeReviews)
    .set({
      status: 'failed',
      error: 'interrupted by restart',
      finishedAt: new Date(),
    })
    .where(inArray(claudeReviews.status, ['queued', 'running']))
    .returning({ id: claudeReviews.id })
    .execute();
  return changed.length;
}
