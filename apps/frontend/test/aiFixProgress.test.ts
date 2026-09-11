// The AI Fix shortcut's two pure pieces: the phase ladder both surfaces read, and the
// staleness predicate that decides whether "Fix it" is offered at all.
//
// What this pins:
//   1. ONE ladder. The AI Fix tab's FixerSection and the bottom-right AiFixBanner render the
//      same run at the same time the moment the reader switches tabs mid-run; two copies of
//      `fixProgressPct` would print two percentages for it.
//   2. The stale gate. `ciAnalysisStale` is read TWICE on one card — by the "out of date" chip
//      and by the "Fix it" gate. A chip that says the analysis is old beside a button that
//      seeds a paid agent with it is the defect this exists to make impossible.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { AiFixStatusResponse } from '@pierre-review/shared';
import {
  PHASE_LABEL,
  ciAnalysisStale,
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

describe('ciAnalysisStale', () => {
  it('is stale when the stored analysis names a different head', () => {
    expect(ciAnalysisStale('diagnosis', 'aaa', 'bbb')).toBe(true);
  });

  it('is not stale on the same head', () => {
    expect(ciAnalysisStale('diagnosis', 'aaa', 'aaa')).toBe(false);
  });

  it('is not stale with no analysis at all — there is nothing to be out of date', () => {
    expect(ciAnalysisStale(null, 'aaa', 'bbb')).toBe(false);
  });

  it('is NOT stale when the stored row carries no head sha', () => {
    // Rows written before the column shipped. We cannot show that they are old, so we do not
    // claim it — the plugin's ciSeedDecision reads the same null the same way.
    expect(ciAnalysisStale('diagnosis', null, 'bbb')).toBe(false);
    expect(ciAnalysisStale('diagnosis', undefined, 'bbb')).toBe(false);
  });

  it('IS stale when the PR head has not synced but the analysis names one', () => {
    // Asymmetric with the case above, and deliberately so: there, we hold no sha to disprove;
    // here we hold one that the PR cannot confirm. The chip has always read it this way, and
    // the server re-checks against the LIVE head regardless, so the conservative reading costs
    // a Re-analyze click rather than a paid agent turn on the wrong commit.
    expect(ciAnalysisStale('diagnosis', 'aaa', null)).toBe(true);
  });
});
