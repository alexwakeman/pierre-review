import { eq, inArray } from 'drizzle-orm';
import type {
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReviewModel,
  ClaudeReviewScope,
  ClaudeReviewVerdict,
} from '@pierre-review/shared';
import { db } from '../db/client.js';
import { claudeReviewFindings, claudeReviews } from '../db/schema.js';

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
  scope: ClaudeReviewScope;
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

export function insertQueuedReview(
  prId: number,
  headSha: string,
  model: ClaudeReviewModel,
): number {
  const row = db
    .insert(claudeReviews)
    .values({ prId, headSha, status: 'queued', model })
    .returning({ id: claudeReviews.id })
    .get();
  return row.id;
}

export function markReviewRunning(id: number): void {
  db.update(claudeReviews)
    .set({ status: 'running' })
    .where(eq(claudeReviews.id, id))
    .run();
}

// Record the agent's result + insert its findings, in one transaction. Claude's
// summary/verdict are stored read-only; the user's `userBody`/`userVerdict` stay
// null (the "Your review" box starts empty).
export function saveReviewSuccess(id: number, data: ReviewSuccess): void {
  db.transaction(() => {
    db.update(claudeReviews)
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
      .run();
    for (const f of data.findings) {
      db.insert(claudeReviewFindings)
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
        })
        .run();
    }
  });
}

export function markReviewFailed(
  id: number,
  error: string,
  telemetry: ReviewTelemetry = {},
): void {
  db.update(claudeReviews)
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
    .run();
}

export function markReviewCancelled(id: number): void {
  db.update(claudeReviews)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(eq(claudeReviews.id, id))
    .run();
}

// Save the user's authored draft. Returns false if the run doesn't exist.
export function updateReviewDraft(
  id: number,
  fields: { userBody?: string; userVerdict?: ClaudeReviewVerdict },
): boolean {
  const set = {
    ...(fields.userBody !== undefined ? { userBody: fields.userBody } : {}),
    ...(fields.userVerdict !== undefined
      ? { userVerdict: fields.userVerdict }
      : {}),
  };
  if (Object.keys(set).length === 0) return true;
  const res = db
    .update(claudeReviews)
    .set(set)
    .where(eq(claudeReviews.id, id))
    .run();
  return res.changes > 0;
}

// Tick/untick a finding and/or save the user's reworded body. An empty-string
// editedBody clears the reword (reverts to Claude's wording). Returns false if
// the finding doesn't exist.
export function updateFinding(
  findingId: number,
  fields: { included?: boolean; editedBody?: string },
): boolean {
  const set = {
    ...(fields.included !== undefined ? { included: fields.included } : {}),
    ...(fields.editedBody !== undefined
      ? { editedBody: fields.editedBody === '' ? null : fields.editedBody }
      : {}),
  };
  if (Object.keys(set).length === 0) return true;
  const res = db
    .update(claudeReviewFindings)
    .set(set)
    .where(eq(claudeReviewFindings.id, findingId))
    .run();
  return res.changes > 0;
}

// Stamp the run + its posted findings after a successful GitHub submit.
export function markReviewPosted(
  id: number,
  postedReviewId: string,
  postedFindingIds: number[],
): void {
  const now = new Date();
  db.transaction(() => {
    db.update(claudeReviews)
      .set({ postedReviewId, postedAt: now })
      .where(eq(claudeReviews.id, id))
      .run();
    if (postedFindingIds.length > 0) {
      db.update(claudeReviewFindings)
        .set({ postedAt: now })
        .where(inArray(claudeReviewFindings.id, postedFindingIds))
        .run();
    }
  });
}

// Stamp a single finding posted as a standalone inline comment.
export function markFindingPosted(
  findingId: number,
  githubCommentId: string,
): void {
  db.update(claudeReviewFindings)
    .set({ postedAt: new Date(), githubCommentId })
    .where(eq(claudeReviewFindings.id, findingId))
    .run();
}

// On startup, heal runs left mid-flight by a crash/restart (our `running` status
// is persisted, unlike the sync manager's purely in-memory guard).
export function reconcileOrphanedReviews(): number {
  const res = db
    .update(claudeReviews)
    .set({
      status: 'failed',
      error: 'interrupted by restart',
      finishedAt: new Date(),
    })
    .where(inArray(claudeReviews.status, ['queued', 'running']))
    .run();
  return res.changes;
}
