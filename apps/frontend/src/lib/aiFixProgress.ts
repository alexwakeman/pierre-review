import type { AiFixStatusResponse, StoryBuildPhase, StoryBuildProgress } from '@pierre-review/shared';

// The AI Fix run's phase ladder — the ONE copy. Two surfaces read a single run: the AI Fix
// tab's FixerSection and the bottom-right AiFixBanner. Two
// copies of the ladder would let them print different percentages for the same run, and the
// reader would be looking at both at once the moment they switch tabs mid-run.

export const PHASE_LABEL: Record<string, string> = {
  fetching_diff: 'Reading the PR',
  cloning: 'Checking out the code',
  preparing_checks: 'Installing dependencies',
  fixing: 'Applying the fix',
  running_checks: 'Running the tests',
  capturing: 'Capturing changes',
  persisting: 'Saving',
  planning: 'Making the plan',
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
    case 'preparing_checks':
      return 34;
    case 'running_checks':
      return 88;
    case 'fixing':
      return Math.min(90, 45 + (p.recentActivity?.length ?? 0) * 3);
    case 'capturing':
      return 92;
    case 'persisting':
      return 96;
    // A plan pass reads and writes nothing, so its ladder is the activity alone.
    case 'planning':
      return Math.min(90, 35 + (p.recentActivity?.length ?? 0) * 4);
    default:
      return 20;
  }
}

// ── "Implement story" (docs/STORY-BUILD.md): the same ladder idea, for a build session's phases ──────
// The session's plan passes and each repository's build share these words; the AI Fix ones keep their
// spelling where the step is the same (preparing the checks, running the tests, capturing).

export const STORY_BUILD_PHASE_LABEL: Record<StoryBuildPhase, string> = {
  reading_story: 'Reading the story',
  checking_coverage: 'Checking what the existing pull requests do',
  picking_repos: 'Choosing the repositories',
  checking_out: 'Checking out the code',
  planning: 'Making the plan',
  docs_shortlisting: 'Choosing the docs to read',
  docs_reading: 'Reading the docs',
  preparing: 'Preparing the branch',
  preparing_checks: PHASE_LABEL.preparing_checks!,
  building: 'Writing the code',
  running_checks: PHASE_LABEL.running_checks!,
  capturing: PHASE_LABEL.capturing!,
  pushing: 'Pushing',
};

/** Map a session's live step (+ activity depth) to a 0–100 reading for its progress bar. */
export function storyBuildProgressPct(p: StoryBuildProgress | null): number | null {
  if (p == null) return null;
  const depth = p.recentActivity?.length ?? 0;
  switch (p.phase) {
    case 'reading_story':
      return 8;
    case 'checking_coverage':
      return 14;
    case 'picking_repos':
      return 20;
    case 'checking_out':
      return 28;
    case 'planning':
      return Math.min(92, 35 + depth * 4);
    case 'docs_shortlisting':
      return 20;
    case 'docs_reading':
      return Math.min(92, 35 + depth * 4);
    case 'preparing':
      return 10;
    case 'preparing_checks':
      return 18;
    case 'building':
      return Math.min(85, 25 + depth * 3);
    case 'running_checks':
      return 88;
    case 'capturing':
      return 94;
    case 'pushing':
      return 60;
    default:
      return 20;
  }
}
