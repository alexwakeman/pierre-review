// A LOOP'S LAST REVIEW, ON THE PULL REQUEST (SHARED; docs/CLAUDE-REVIEW.md § Auto review → the review
// loop's imported row). A review loop reviewed a head before it reached the PR (Build: before the PR opened).
// So that the reader's auto review does not review the SAME head again (its first-review rule skips a PR with
// any `claude_reviews` row at that head), the closing review is written as ONE `claude_reviews` row at the PR
// head: `trigger: 'manual'` (it never spends the daily auto cap), not posted, its consolidated findings
// included — ready to post by hand in the PR's AI Review tab. A pair is ONE row (the consolidated list; never
// a fake pair). A NEW head later is reviewed as usual. Best-effort: a failure is logged, and auto review may
// then review the PR again. SUBJECT-INDEPENDENT: the runs and findings are structural (any loop's rows).
// AI Fix's import also passes `followUp` (the closing round's judgement of the PR's earlier findings), so the
// row resolves the threads the fix dealt with (coding/ai-fix/loop-pr-prior.ts). Build passes none.
import { and, eq } from 'drizzle-orm';
import {
  CLAUDE_REVIEW_MODELS,
  DEFAULT_CLAUDE_REVIEW_MODEL,
  type ClaudeFindingSeverity,
  type ClaudeFindingSide,
  type ClaudeReviewFollowUpRecord,
  type ClaudeReviewModel,
  type ClaudeReviewPairConsolidation,
  type ClaudeReviewVerdict,
} from '@pierre-review/shared';
import { requestModelOf } from '../../ai/provider.js';
import type { AgentContext } from '../../review/agent-context.js';
import { insertQueuedReview, markReviewRanOn, saveReviewSuccess } from '../../review/claude-review/persist.js';
import { openFindingsOf } from './rounds.js';

/** One run of the closing round, as the import reads it. */
export interface ImportedRunLike {
  id: number;
  round: number;
  status: string;
  headSha: string;
  pairRole: 'first' | 'second' | null;
  pairConsolidation: ClaudeReviewPairConsolidation | null;
  verdict: string | null;
  summary: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  reviewMode: string | null;
}

/** One finding of those runs, as the import copies it. */
export interface ImportedFindingLike {
  id: number;
  reviewId: number;
  mergedInto: number | null;
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
  lens: string | null;
  /** The PR finding this one re-raises (claude_review_findings.id); absent / null ⇒ none. */
  priorFindingId?: number | null;
}

/** Build's line under the imported summary. */
export const IMPORTED_LINE = (round: number): string => `Reviewed in Ensemble before this pull request opened (round ${round}).`;

/**
 * Write the row (see the header). `line(round)` is the sentence under the summary (default: Build's
 * `IMPORTED_LINE`); `who` names the loop in the log. Returns its id, or null when nothing was written.
 * Never throws.
 */
export async function markLoopReviewOnPr(
  ctx: AgentContext,
  a: {
    accountId: number;
    repoId: number;
    prNumber: number;
    headSha: string;
    runs: readonly ImportedRunLike[];
    findings: readonly ImportedFindingLike[];
    line?: (round: number) => string;
    who?: string;
    /** The closing round's judgement of the PR's earlier findings (AI Fix: loop-pr-prior.ts); absent ⇒ none. */
    followUp?: ClaudeReviewFollowUpRecord | null;
  },
): Promise<number | null> {
  try {
    const ok = a.runs.filter((r) => r.status === 'succeeded' && r.headSha === a.headSha);
    if (ok.length === 0) return null;
    const p = ctx.schema.pullRequests;
    const rows = (await ctx.db
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.accountId, a.accountId), eq(p.repoId, a.repoId), eq(p.number, a.prNumber)))
      .limit(1)
      .execute()) as Array<{ id: number }>;
    const prId = rows[0]?.id;
    if (prId == null) return null;
    const lead = ok.find((r) => r.pairRole !== 'second') ?? ok[0]!;
    const verdict = ((lead.pairConsolidation?.verdict ?? lead.verdict) as ClaudeReviewVerdict | null) ?? 'COMMENT';
    const summary = [lead.pairConsolidation?.summary ?? lead.summary ?? '', (a.line ?? IMPORTED_LINE)(lead.round)].filter((s) => s.trim() !== '').join('\n\n');
    const kept = openFindingsOf(a.findings, new Set(ok.map((r) => r.id)));
    // THE MODEL THAT RAN: the loop's review halves run at Settings → AI → Review's model, so the row is
    // queued at that depth and stamped with the exact id (and effort) the lead half stored.
    const provider = lead.provider === 'codex' ? 'codex' : 'claude';
    const depth = lead.model != null ? requestModelOf(lead.model) : null;
    const asked: ClaudeReviewModel =
      depth != null && (CLAUDE_REVIEW_MODELS as readonly string[]).includes(depth) ? (depth as ClaudeReviewModel) : DEFAULT_CLAUDE_REVIEW_MODEL;
    const id = await insertQueuedReview(ctx, prId, a.headSha, asked, a.accountId, [], 'manual', provider);
    if (lead.model != null) await markReviewRanOn(ctx, id, { provider, model: lead.model, ...(lead.effort ? { effort: lead.effort } : {}) });
    await saveReviewSuccess(ctx, id, {
      // The loop recorded its spend already.
      usageRecorded: true,
      scope: lead.reviewMode === 'worktree' || lead.reviewMode === 'diff_only' ? lead.reviewMode : null,
      summary,
      verdict,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: null,
      excludedFiles: [],
      followUp: a.followUp ?? null,
      findings: kept.map((f) => ({
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
        lens: (f.lens as never) ?? null,
        priorFindingId: f.priorFindingId ?? null,
        included: true,
      })),
    });
    return id;
  } catch (err) {
    ctx.log.warn(`${a.who ?? 'story build'}: the loop's review was not added to PR #${a.prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
