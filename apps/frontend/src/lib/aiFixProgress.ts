import { CI_ANALYSIS_CONTRACT_EPOCH_MS, type AiFixStatusResponse } from '@pierre-review/shared';

// The AI Fix run's phase ladder — the ONE copy. Two surfaces read a single run: the AI Fix
// tab's FixerSection and the bottom-right AiFixBanner the CI-analysis shortcut feeds. Two
// copies of the ladder would let them print different percentages for the same run, and the
// reader would be looking at both at once the moment they switch tabs mid-run.

/**
 * Does a stored CI diagnosis predate the PR's current head — or the prompt that wrote it? ONE
 * predicate, read twice on the same card — by the "out of date" chip and by the "Fix it" gate.
 * They must never disagree: a chip saying the analysis is old beside a button that seeds an agent
 * with it is the defect.
 *
 * ⚠ A stored analysis with NO head sha is NOT stale on that count. It predates the column and
 * cannot be disproved; claiming staleness we cannot show is the same overreach in the other
 * direction. `apps/backend`'s twin (the plugin's `ciSeedDecision`) reads the null the same way.
 *
 * ⚠ THE SECOND CLAUSE IS A CONTRACT VERSION, NOT A FRESHNESS RULE. The stored answer describes
 * what the fixer can do, the payload hash does not include the prompt, and the fixer's
 * capabilities changed — so rows written before `CI_ANALYSIS_CONTRACT_EPOCH_MS` assert a shell and
 * a push the product no longer has. See that constant.
 */
export function ciAnalysisStale(
  analysis: string | null,
  storedHeadSha: string | null | undefined,
  prHeadSha: string | null,
  generatedAt?: string | null,
): boolean {
  if (analysis == null) return false;
  if (storedHeadSha != null && storedHeadSha !== prHeadSha) return true;
  return ciAnalysisPredatesContract(generatedAt);
}

/** Was this analysis written under a prompt that promised capabilities the fixer no longer has?
 *  ⚠ AN UNPARSEABLE OR ABSENT TIMESTAMP IS NOT A CLAIM. Same reading as the null head sha. */
export function ciAnalysisPredatesContract(generatedAt: string | null | undefined): boolean {
  if (generatedAt == null) return false;
  const at = Date.parse(generatedAt);
  return Number.isFinite(at) && at < CI_ANALYSIS_CONTRACT_EPOCH_MS;
}

export const PHASE_LABEL: Record<string, string> = {
  fetching_diff: 'Reading the PR',
  cloning: 'Checking out the code',
  fixing: 'Applying the fix',
  capturing: 'Capturing changes',
  persisting: 'Saving',
};

/** Map the live phase (+ activity depth) to a determinate 0–100 reading. */
export function fixProgressPct(status: AiFixStatusResponse | null): number | null {
  if (!status || status.status === 'idle') return null;
  if (status.status === 'queued') return 6;
  const p = status.progress;
  if (!p) return 10;
  switch (p.phase) {
    case 'fetching_diff':
      return 12;
    case 'cloning':
      return 28;
    case 'fixing':
      return Math.min(90, 45 + (p.recentActivity?.length ?? 0) * 3);
    case 'capturing':
      return 92;
    case 'persisting':
      return 96;
    default:
      return 20;
  }
}
