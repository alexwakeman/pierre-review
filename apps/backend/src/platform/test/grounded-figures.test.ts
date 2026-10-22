// The GROUNDED-FIGURE CHECK (plan D4, report grain): every numeral in the period-report
// narrative must match a figure in the NARRATION PAYLOAD — the projection of the report the
// model was actually prompted with — with the tolerances stated in grounded-figures.ts: sign,
// thousands separators, the SPA formatters' rounded/1dp/2dp renderings, fmtDuration's
// minute/day units for hour metrics, numerals inside the payload's own strings (disclosures,
// dates), and array lengths. Anything else is an invented figure, and a narrative carrying one
// is NOT stored — the templated summary stands in.
//
// ⚠ The grounding base is the payload, NOT the raw report: the report's `generatedAt`
// (generation wall-clock) and `comparison.subsetRepoIds` (internal DB ids) must never ground a
// numeral — two tests below pin exactly that bypass shut.
import { describe, expect, it } from 'vitest';
import type { PeriodReport } from '@pierre-review/shared';
import {
  groundingFigureSet,
  templatedNarrative,
  ungroundedNumerals,
} from '../insights/grounded-figures.js';
import { narrationPayload } from '../insights/period-report.js';

function report(over: Partial<PeriodReport> = {}): PeriodReport {
  return {
    periodKey: 'sprint-2026-08-18',
    periodStart: '2026-08-18T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    grain: 'sprint',
    cadenceDays: 14,
    coverage: { trackedRepos: 7, totalRepos: 8, complete: false },
    metrics: [
      { key: 'merged_prs', value: 117, sampleSize: 117 },
      { key: 'median_lead_time_hours', value: 18.16, sampleSize: 42 },
      { key: 'human_review_comments', value: 1204, sampleSize: 1204 },
    ],
    comparison: {
      priorPeriodKey: 'sprint-2026-08-04',
      subsetRepoIds: [1, 2, 3, 4, 5, 6, 7],
      subsetDisclosure: 'covers 7 of 8 repos tracked across both periods',
      deltas: [
        {
          key: 'merged_prs',
          value: 113,
          prior: 146,
          absoluteChange: -33,
          percentChange: -22.6,
          significant: true,
          direction: 'neutral',
        },
      ],
      refusal: null,
    },
    forecasts: [
      { available: true, key: 'merged_prs', point: 120, low: 104, high: 136, basis: 'linear', periodsUsed: 5 },
      { available: false, key: 'median_lead_time_hours', reason: 'too_volatile' },
    ],
    movements: [
      { key: 'merged_prs', absoluteChange: -33, percentChange: -22.6, rank: 0, favourable: false },
    ],
    suggested: [],
    narrative: null,
    model: null,
    metricsSchemaVersion: 2,
    generatedAt: '2026-08-20T10:00:00.000Z',
    stale: false,
    ...over,
  };
}

const figureSetFor = (r: PeriodReport): Set<string> => groundingFigureSet(narrationPayload(r));

describe('groundingFigureSet + ungroundedNumerals', () => {
  const allowed = figureSetFor(report());

  it('accepts every figure the report actually contains', () => {
    expect(
      ungroundedNumerals(
        'Merged PRs fell to 113 (was 146, −33, −22.6%), against a headline of 117 over all 8 repos; 7 were tracked across both periods. Forecast ≈ 120 (104–136) from 5 periods.',
        allowed,
      ),
    ).toEqual([]);
  });

  it('tolerates sign and thousands separators', () => {
    // −33 tokenizes as 33; 1,204 normalizes to 1204.
    expect(ungroundedNumerals('a swing of 33, and 1,204 comments', allowed)).toEqual([]);
  });

  it('tolerates rounded and decimal renderings of a stored figure', () => {
    // percentChange −22.6 → "23" (pctFmt rounds) and "22.6"; lead time 18.16 → "18.2".
    expect(ungroundedNumerals('down 23% (22.6), lead time 18.2h', allowed)).toEqual([]);
  });

  it("tolerates fmtDuration's day rendering for hour metrics only", () => {
    // 18.16h ÷ 24 → 0.8d is a legitimate rendering of an hours figure.
    expect(ungroundedNumerals('roughly 0.8d of lead time', allowed)).toEqual([]);
  });

  it('tolerates numerals quoted from the report’s own strings and dates', () => {
    expect(ungroundedNumerals('the 18 Aug – 1 Sep sprint (14 days, 2026)', allowed)).toEqual([]);
  });

  it('rejects an invented figure', () => {
    expect(ungroundedNumerals('velocity is up 340% across 92 repos', allowed)).toEqual(
      expect.arrayContaining(['340', '92']),
    );
  });

  it('a digit-free narrative is trivially grounded', () => {
    expect(ungroundedNumerals('A quieter fortnight, with review load easing.', allowed)).toEqual([]);
  });

  it('rejects a numeral matching only the generation wall-clock (generatedAt never grounds)', () => {
    // 37 / 52 / 481 are the minute, second and millisecond of generatedAt and appear nowhere in
    // the computed figures. Grounding on the raw report admitted them (the D4 bypass); grounding
    // on the narration payload — which omits generatedAt — must reject them.
    const r = report({ generatedAt: '2026-08-25T14:37:52.481Z' });
    expect(ungroundedNumerals('velocity up 37%, with 52 fixes and 481 comments', figureSetFor(r))).toEqual(
      expect.arrayContaining(['37', '52', '481']),
    );
  });

  it('rejects a numeral matching only an internal subsetRepoIds member', () => {
    const r = report({
      comparison: {
        priorPeriodKey: 'sprint-2026-08-04',
        subsetRepoIds: [3847, 5912],
        subsetDisclosure: 'covers 2 of 8 repos tracked across both periods',
        deltas: [],
        refusal: null,
      },
    });
    expect(ungroundedNumerals('3847 review comments across 5912 files', figureSetFor(r))).toEqual(
      expect.arrayContaining(['3847', '5912']),
    );
  });
});

describe('templatedNarrative', () => {
  it('is grounded by construction — its own numerals all pass the check', () => {
    const r = report();
    expect(ungroundedNumerals(templatedNarrative(r), figureSetFor(r))).toEqual([]);
  });

  it('states a refused comparison rather than inventing one', () => {
    const r = report({
      comparison: {
        priorPeriodKey: null,
        subsetRepoIds: [],
        subsetDisclosure: '',
        deltas: [],
        refusal: 'no_prior_period',
      },
      movements: [],
    });
    expect(templatedNarrative(r)).toContain('No comparison against the prior period');
  });

  it('says it is templated, so a reader never mistakes it for the model write-up', () => {
    expect(templatedNarrative(report())).toContain('This summary is templated');
  });
});
