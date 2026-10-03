import type { AiFixStatusResponse } from '@pierre-review/shared';

// The AI Fix run's phase ladder — the ONE copy. Two surfaces read a single run: the AI Fix
// tab's FixerSection and the bottom-right AiFixBanner. Two
// copies of the ladder would let them print different percentages for the same run, and the
// reader would be looking at both at once the moment they switch tabs mid-run.

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
