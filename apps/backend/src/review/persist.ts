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
import { recordAiUsage } from '../db/usage.js';

const { claudeReviewFindings, claudeReviews } = schema;

// Append a Claude Review run's cost to the AI-usage ledger (the AGENTIC seam). Reads the
// run's accountId/model/prId back off the row (they were stamped at insert). Best-effort:
// a ledger write must never break the review save. A run with no real cost (a 'skip', or
// an ambient-session run that reported nothing) records nothing.
async function recordReviewUsage(
  id: number,
  costUsd: number | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): Promise<void> {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd <= 0) return;
  const row = (
    await db
      .select({
        accountId: claudeReviews.accountId,
        model: claudeReviews.model,
        prId: claudeReviews.prId,
      })
      .from(claudeReviews)
      .where(eq(claudeReviews.id, id))
      .limit(1)
      .execute()
  )[0];
  if (!row) return;
  await recordAiUsage({
    accountId: row.accountId,
    seam: 'agent',
    feature: 'claude_review',
    model: row.model,
    costUsd,
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    prId: row.prId,
  });
}

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
  fileInDiff: boolean;
}

export interface ReviewSuccess {
  // null only for a 'skip' run (no agent, so no self-reported scope).
  scope: ClaudeReviewScope | null;
  summary: string;
  verdict: ClaudeReviewVerdict;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  // Cache-token split (the bulk of input on a multi-turn run is cache reads — the
  // hidden cost driver). Null when not captured.
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  numTurns: number | null;
  // Full (noise-stripped) diff size in chars + whether the diff-size cap truncated
  // the prompt — recorded so capped/uncapped runs can be cost-compared (A/B).
  diffBytes?: number | null;
  diffCapped?: boolean | null;
  excludedFiles: string[];
  findings: PersistedFinding[];
}

// Telemetry that may exist even on a failed run (e.g. budget-exceeded carries a
// cost). All optional.
export interface ReviewTelemetry {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  numTurns?: number | null;
  diffBytes?: number | null;
  diffCapped?: boolean | null;
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
        cacheReadTokens: data.cacheReadTokens ?? null,
        cacheCreationTokens: data.cacheCreationTokens ?? null,
        numTurns: data.numTurns,
        diffBytes: data.diffBytes ?? null,
        diffCapped: data.diffCapped ?? null,
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
          fileInDiff: f.fileInDiff,
          // Findings are INCLUDED by default — the UI is opt-OUT ("Ignore"), so a
          // fresh review posts every finding (inline when its line/file is in the
          // diff, else as a PR-level comment) unless the user sets it aside. (The
          // column default is false for back-compat; we set it here.)
          included: true,
        })
        .execute();
    }
  });
  await recordReviewUsage(id, data.costUsd, data.inputTokens, data.outputTokens).catch(
    () => {},
  );
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
      cacheReadTokens: telemetry.cacheReadTokens ?? null,
      cacheCreationTokens: telemetry.cacheCreationTokens ?? null,
      numTurns: telemetry.numTurns ?? null,
      diffBytes: telemetry.diffBytes ?? null,
      diffCapped: telemetry.diffCapped ?? null,
      scope: telemetry.scope ?? null,
      excludedFiles: telemetry.excludedFiles ?? null,
      finishedAt: new Date(),
    })
    .where(eq(claudeReviews.id, id))
    .execute();
  // A failed run (e.g. budget-exceeded) can still have billed cost — record it.
  await recordReviewUsage(
    id,
    telemetry.costUsd,
    telemetry.inputTokens,
    telemetry.outputTokens,
  ).catch(() => {});
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

// Stamp the run + its posted findings after a successful GitHub submit. Inline
// findings (posted as part of the one review) are stamped with kind 'inline';
// findings posted as standalone PR-level comments carry their own comment id + kind
// 'pr_comment' so the UI builds the right permalink.
export async function markReviewPosted(
  id: number,
  postedReviewId: string,
  inlineFindingIds: number[],
  prComments: { findingId: number; commentId: string }[] = [],
): Promise<void> {
  const now = new Date();
  await runTransaction(async (tx) => {
    await tx
      .update(claudeReviews)
      .set({ postedReviewId, postedAt: now })
      .where(eq(claudeReviews.id, id))
      .execute();
    if (inlineFindingIds.length > 0) {
      await tx
        .update(claudeReviewFindings)
        .set({ postedAt: now, postedCommentKind: 'inline' })
        .where(inArray(claudeReviewFindings.id, inlineFindingIds))
        .execute();
    }
    for (const pc of prComments) {
      await tx
        .update(claudeReviewFindings)
        .set({
          postedAt: now,
          githubCommentId: pc.commentId,
          postedCommentKind: 'pr_comment',
        })
        .where(eq(claudeReviewFindings.id, pc.findingId))
        .execute();
    }
  });
}

// Stamp a single finding posted as a standalone comment. `kind` records how it was
// attached ('inline' review comment vs 'pr_comment' PR-level issue comment) so the
// UI can build the correct GitHub permalink.
export async function markFindingPosted(
  findingId: number,
  githubCommentId: string,
  kind: 'inline' | 'pr_comment' = 'inline',
): Promise<void> {
  await db
    .update(claudeReviewFindings)
    .set({ postedAt: new Date(), githubCommentId, postedCommentKind: kind })
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
