// The PR Overview's "Checks" row visibility gate.
//
// The regression this pins: the gate was widened from `checks.length > 0` to also fire on a red
// `ciStatus`, so a PR whose checkRuns did not hydrate could still reach a STORED CI diagnosis.
// But that diagnosis is the Pro CiAnalysisCard, which returns null without the `prSummary`
// capability — so on the free tier the widened branch has no possible content, and `Row` always
// paints its uppercase label: a bare "CHECKS" heading beside an empty column.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { checksRowVisible } from '../src/lib/ui.js';

describe('checksRowVisible', () => {
  it('shows the row whenever there are checks to list, on any tier', () => {
    expect(checksRowVisible(3, 'failure', false)).toBe(true);
    expect(checksRowVisible(3, 'success', false)).toBe(true);
    expect(checksRowVisible(1, 'unknown', true)).toBe(true);
  });

  it('shows the row for a red PR with no hydrated checks when the CI card can render', () => {
    expect(checksRowVisible(0, 'failure', true)).toBe(true);
    expect(checksRowVisible(0, 'error', true)).toBe(true);
  });

  it('does NOT open an empty row on the free tier when nothing hydrated', () => {
    // The bug. Both children render null here: no checks to list, and CiAnalysisCard bails on
    // `!prSummary`. Anything but false leaves an orphaned label on every OSS install.
    expect(checksRowVisible(0, 'failure', false)).toBe(false);
    expect(checksRowVisible(0, 'error', false)).toBe(false);
  });

  it('stays closed for a green / unknown PR with no checks, on either tier', () => {
    for (const prSummary of [true, false]) {
      expect(checksRowVisible(0, 'success', prSummary)).toBe(false);
      expect(checksRowVisible(0, 'pending', prSummary)).toBe(false);
      expect(checksRowVisible(0, 'unknown', prSummary)).toBe(false);
      expect(checksRowVisible(0, null, prSummary)).toBe(false);
    }
  });
});
