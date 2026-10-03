// The AI Fix run's phase ladder — ONE ladder. The AI Fix tab's FixerSection and the bottom-right
// AiFixBanner render the same run at the same time the moment the reader switches tabs mid-run;
// two copies of `fixProgressPct` would print two percentages for it.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { AiFixStatusResponse } from '@pierre-review/shared';
import {
  PHASE_LABEL,
  fixProgressPct,
} from '../src/lib/aiFixProgress.js';

function status(
  s: AiFixStatusResponse['status'],
  phase?: string,
  activity?: string[],
): AiFixStatusResponse {
  return {
    status: s,
    fixId: 1,
    progress: phase
      ? ({ phase, recentActivity: activity } as AiFixStatusResponse['progress'])
      : null,
  };
}

describe('fixProgressPct', () => {
  it('reads nothing when there is no run', () => {
    expect(fixProgressPct(null)).toBeNull();
    expect(fixProgressPct(status('idle'))).toBeNull();
  });

  it('climbs monotonically through the ladder', () => {
    const rungs = [
      fixProgressPct(status('queued')),
      fixProgressPct(status('running', 'fetching_diff')),
      fixProgressPct(status('running', 'cloning')),
      fixProgressPct(status('running', 'fixing')),
      fixProgressPct(status('running', 'capturing')),
      fixProgressPct(status('running', 'persisting')),
    ];
    expect(rungs).toEqual([...rungs].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(rungs.every((r) => r != null && r > 0 && r < 100)).toBe(true);
  });

  it('advances within `fixing` with activity, and never overtakes `capturing`', () => {
    const quiet = fixProgressPct(status('running', 'fixing', []));
    const busy = fixProgressPct(status('running', 'fixing', Array(40).fill('x')));
    expect(quiet).toBeLessThan(busy!);
    // The cap is what stops a chatty agent reading 100% while it is still working.
    expect(busy).toBeLessThanOrEqual(90);
    expect(busy).toBeLessThan(fixProgressPct(status('running', 'capturing'))!);
  });

  it('has a label for every phase it scores', () => {
    for (const phase of ['fetching_diff', 'cloning', 'fixing', 'capturing', 'persisting']) {
      expect(PHASE_LABEL[phase]).toBeTruthy();
    }
    // An unknown phase scores, but leaves the label to the caller's fallback.
    expect(fixProgressPct(status('running', 'something_new'))).toBe(20);
    expect(PHASE_LABEL['something_new']).toBeUndefined();
  });
});
