// ONE METRIC ROW MUST DESCRIBE ONE POPULATION.
//
// A period report carries TWO scans of the same window:
//   • `report.metrics`            — the HEADLINE, over the workspace's full CURRENT membership.
//   • `report.comparison.deltas`  — over the COVERAGE-STABLE SUBSET, the repos tracked across both
//                                   this period and the prior one (spec §4).
// They are different populations and their figures do not belong in one subtraction.
//
// THE BUG THIS PINS: the table took "This period" from the headline and "Prior"/"Change" from the
// subset. Measured on the real dev database, workspace BNG's just-closed sprint rendered
// "117 | 146 | −33" — 117 is eight repos, 146 and the −33 are seven, and 117 − 146 = −29. None of
// the three numbers agreed with the other two, on a screen whose entire purpose is to be trusted
// and forwarded.
//
// It is the SAME defect that was found and fixed in the narration prompt (period-report.ts's
// two-populations rule, and the plugin test forbidding the headline and subset figures from
// sharing a field name). The prose was hardened; the table a reader actually looks at was not.
//
// There is no jsdom in this workspace, so the row cannot be rendered — but the invariant is
// arithmetic, not visual, which is why `rowFigures` is a pure exported function.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { PeriodMetricDelta, PeriodMetricValue } from '@pierre-review/shared';
import { rowFigures } from '../src/components/Activity/PeriodReportsPanel.js';

const headlineOf = (value: number | null, sampleSize = 10): PeriodMetricValue => ({
  key: 'merged_prs',
  value,
  sampleSize,
});

const deltaOf = (value: number | null, prior: number | null): PeriodMetricDelta => ({
  key: 'merged_prs',
  value,
  prior,
  absoluteChange: value != null && prior != null ? value - prior : null,
  percentChange: value != null && prior != null && prior !== 0 ? ((value - prior) / prior) * 100 : null,
  significant: true,
  direction: 'up_good',
});

describe('rowFigures', () => {
  // THE REAL CASE, with the real numbers.
  it('subtracts like for like — the BNG sprint that rendered 117 | 146 | −33', () => {
    const r = rowFigures(headlineOf(117), deltaOf(113, 146), true);
    expect(r.value).toBe(113); // the subset's own current figure, NOT the headline 117
    expect(r.prior).toBe(146);
    // The row's own arithmetic closes: 113 − 146 = −33, which is what the Change cell prints.
    expect(r.value! - r.prior!).toBe(-33);
    // …and the full-membership figure is still shown, in its own labelled line.
    expect(r.headline).toBe(117);
  });

  // The general invariant, not just the one case.
  it('always satisfies value − prior === the printed change', () => {
    for (const [cur, prior] of [
      [113, 146],
      [20, 10],
      [0, 5],
      [7, 7],
    ] as const) {
      const delta = deltaOf(cur, prior);
      const r = rowFigures(headlineOf(999), delta, true);
      expect(r.value! - r.prior!).toBe(delta.absoluteChange);
    }
  });

  it('does not disclose a headline when the populations coincide', () => {
    // Nothing was excluded from the comparison, so there is no second figure to explain.
    expect(rowFigures(headlineOf(50), deltaOf(50, 40), false).headline).toBeNull();
  });

  // ⚠ NOT `delta?.value ?? mv?.value`. That falls back to the headline exactly when the subset has
  // no figure — silently restoring the two-population mix in the case hardest to notice, since a
  // plausible number appears where "—" belongs.
  it('shows "no figure" rather than substituting the headline when the subset is empty', () => {
    const r = rowFigures(headlineOf(117), deltaOf(null, 146), true);
    expect(r.value).toBeNull();
  });

  // With no comparison at all (refused, or a backfilled period) the headline IS the only figure,
  // and there is nothing beside it to be inconsistent with.
  it('falls back to the headline only when there is no comparison at all', () => {
    const r = rowFigures(headlineOf(117), undefined, true);
    expect(r.value).toBe(117);
    expect(r.prior).toBeNull();
    expect(r.headline).toBeNull();
  });

  it('renders a missing metric as absent, never as 0', () => {
    const r = rowFigures(undefined, undefined, false);
    expect(r.value).toBeNull();
    expect(r.prior).toBeNull();
  });
});

// ── The thin-sample marker ───────────────────────────────────────────────────────────────────
//
// "Time to first review: 0h" computed from two reviews looks exactly like the same figure computed
// from two hundred. It is not wrong — it is what was observed — but presented bare it is the sort
// of number that gets a tool called broken. `lowSample` is computed in CORE, beside the floors,
// so the marker and the significance rule can never disagree about what "thin" means.
//
// It answers a DIFFERENT question from `significant`: that one is about the CHANGE and also weighs
// the prior side and the absolute floor. A metric can be thin while moving enough to clear both
// floors, and can be perfectly well-sampled while barely moving.
describe('rowFigures — the thin-sample marker', () => {
  it('takes the marker from the same population as the figure', () => {
    // The subset is thin; the headline is not. The row SHOWS the subset, so it must be marked.
    const delta: PeriodMetricDelta = { ...deltaOf(0, 0), lowSample: true };
    const r = rowFigures({ ...headlineOf(4, 200), lowSample: false }, delta, true);
    expect(r.value).toBe(0);
    expect(r.lowSample).toBe(true);
  });

  it('uses the headline marker when there is no comparison to draw from', () => {
    const r = rowFigures({ ...headlineOf(0, 2), lowSample: true }, undefined, false);
    expect(r.value).toBe(0);
    expect(r.lowSample).toBe(true);
  });

  it('is false — never undefined — for a row stored before the field existed', () => {
    // Back-compat: an older stored report carries no opinion, which must read as "no marker"
    // rather than leaking `undefined` into a boolean prop.
    const r = rowFigures(headlineOf(12), deltaOf(12, 10), false);
    expect(r.lowSample).toBe(false);
  });

  it('does not mark a healthy sample just because the change is insignificant', () => {
    const delta: PeriodMetricDelta = { ...deltaOf(101, 100), significant: false, lowSample: false };
    expect(rowFigures(headlineOf(101, 101), delta, false).lowSample).toBe(false);
  });
});
