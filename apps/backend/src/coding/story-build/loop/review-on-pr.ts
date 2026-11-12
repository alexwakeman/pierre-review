// THE LOOP'S LAST REVIEW, ON THE NEW PULL REQUEST (docs/CLAUDE-REVIEW.md § Auto review → the review loop's
// imported row). The loop reviewed the PR's head before the PR opened. So that the reader's auto review does
// not review the SAME head again (its first-review rule skips a PR with any `claude_reviews` row), the
// closing review is written as ONE `claude_reviews` row at the PR head: `trigger: 'manual'` (it never spends
// the daily auto cap), not posted, its consolidated findings included — ready to post by hand in the PR's
// AI Review tab. A pair is ONE row (the consolidated list; never a fake pair). A NEW head later is reviewed
// as usual. Best-effort: a failure is logged, and auto review may then review the PR again.
import { and, eq } from 'drizzle-orm';
import { DEFAULT_CLAUDE_REVIEW_MODEL, type ClaudeReviewVerdict } from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import { insertQueuedReview, saveReviewSuccess } from '../../../review/claude-review/persist.js';
import type { LoopFindingRow, LoopReviewRow } from './persist.js';
import { openFindingsOf } from './wire.js';

export const IMPORTED_LINE = (round: number): string => `Reviewed in Limn before this pull request opened (round ${round}).`;

/** Write the row (see the header). Returns its id, or null when nothing was written. Never throws. */
export async function markLoopReviewOnPr(
  ctx: AgentContext,
  a: { accountId: number; repoId: number; prNumber: number; headSha: string; runs: readonly LoopReviewRow[]; findings: readonly LoopFindingRow[] },
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
    const summary = [lead.pairConsolidation?.summary ?? lead.summary ?? '', IMPORTED_LINE(lead.round)].filter((s) => s.trim() !== '').join('\n\n');
    const kept = openFindingsOf(a.findings, new Set(ok.map((r) => r.id)));
    const id = await insertQueuedReview(ctx, prId, a.headSha, DEFAULT_CLAUDE_REVIEW_MODEL, a.accountId, [], 'manual', lead.provider === 'codex' ? 'codex' : 'claude');
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
        included: true,
      })),
    });
    return id;
  } catch (err) {
    ctx.log.warn(`story build: the loop's review was not added to PR #${a.prNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
