// A LOCAL BRANCH REVIEW'S HALF through the REAL shared runner (coding/review-loop/branch-review.ts
// `runBranchReviewHalf`) with a fake review seam: what reaches `runReview` for a reader's click.
//   • NEVER REFUSED BY THE SPEND BUDGET: `byReader` ⇒ a Codex specialist's start is allowed without asking the gate
//     (a gate that would refuse everything is never consulted);
//   • the reader's ONE-RUN effort reaches the run; Codex's own ledger row carries the local review's feature;
//   • Claude's spend is recorded under the local review's feature;
//   • the head is the LOCAL pinned ref (prepared from the clone cache, no remote ref).
import { describe, expect, it } from 'vitest';

describe('runBranchReviewHalf for a local review', () => {
  it('is a reader’s click: the gate is never asked, the effort and the features are the local review’s', async () => {
    const { runBranchReviewHalf } = await import('../coding/review-loop/branch-review.js');
    let gateAsked = 0;
    const prepared: any[] = [];
    const runs: any[] = [];
    const usage: any[] = [];
    const ctx: any = {
      log: { warn: () => {}, info: () => {} },
      // A gate that refuses everything: a reader's click must never reach it.
      aiBudget: { allowed: async () => (gateAsked++, false) },
      llm: { detectAuth: () => ({ status: 'ok' }) },
      recordAiUsage: async (r: any) => void usage.push(r),
      review: {
        prepareBranchReview: async (a: any) => {
          prepared.push(a);
          return {
            fileMetrics: [{ path: 'src/a.ts', additions: 3, deletions: 1, isNew: false, apiTouch: false }],
            changedFiles: ['src/a.ts'],
            excludedFiles: [],
            promptDiff: 'diff --git a/src/a.ts b/src/a.ts\n+x\n',
            omittedFiles: [],
            strippedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+x\n',
          };
        },
        runReview: async (a: any) => {
          runs.push(a);
          const allowed = await a.allowSpecialistStart('security');
          return { submitted: true, aborted: false, summary: 'ok', verdict: 'COMMENT', findings: [], followUp: null, costUsd: 0.5, inputTokens: 1, outputTokens: 1, numTurns: 1, ranOn: { provider: a.provider, model: 'claude-x', effort: a.effort }, usageRecorded: false, allowed };
        },
      },
    };
    const head = { localRef: 'refs/pierre/local/local-review/7/head', sha: 'c'.repeat(40) };
    const res = await runBranchReviewHalf(ctx, {
      accountId: 1,
      workspaceId: 1,
      repo: { owner: 'acme', name: 'api', fullName: 'acme/api', repoId: 3 },
      branch: 'feature/x',
      title: 't',
      body: '',
      baseRef: 'origin/main',
      baseSha: 'b'.repeat(40),
      head,
      provider: 'claude',
      prior: null,
      abort: new AbortController(),
      byReader: true,
      feature: 'local_review',
      ledgerFeature: 'local_review',
      effort: 'high',
    });
    expect(res.status).toBe('succeeded');
    expect(prepared[0]).toMatchObject({ owner: 'acme', name: 'api', localRef: head.localRef, headSha: head.sha });
    expect(runs[0]).toMatchObject({ checkout: head, effort: 'high', usage: { accountId: 1, prId: null, repoId: 3, feature: 'local_review' } });
    expect(await runs[0].allowSpecialistStart('x')).toBe(true);
    expect(gateAsked).toBe(0);
    expect(usage).toEqual([expect.objectContaining({ feature: 'local_review', costUsd: 0.5, prId: null, repoId: 3 })]);
    expect(res.ranOn.effort).toBe('high');
  });
});
