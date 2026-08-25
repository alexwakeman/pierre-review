// The "Copy as Markdown" export (plan P4.1 — N3, the forwardable report).
//
// The export is the artifact a director reads WITHOUT the app, so the honesty rules the panel
// renders must TRAVEL IN THE TEXT — they are the product, and each one pinned here has a lie as
// its alternative:
//   • "no prior period" stated as such, never rendered as 0 or a blank that reads "no change";
//   • a null metric prints "—", never 0;
//   • an INSIGNIFICANT delta prints its raw figure and NO percentage;
//   • the coverage sentence and the refused-forecast reasons travel VERBATIM.
// The renderer imports the panel's own METRIC_META/REFUSAL_TEXT/rowFigures — pinned indirectly
// here: the strings asserted below ARE those tables' strings, so a re-implementation drifting
// from the panel breaks this file's expectations.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { PeriodReport } from '@pierre-review/shared';
import {
  renderPeriodReportMarkdown,
  REFUSAL_TEXT,
} from '../src/components/Activity/periodReportMarkdown.js';

function baseReport(over: Partial<PeriodReport> = {}): PeriodReport {
  return {
    periodKey: 'sprint-2026-08-18',
    periodStart: '2026-08-18T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    grain: 'sprint',
    cadenceDays: 14,
    coverage: { trackedRepos: 8, totalRepos: 8, complete: true },
    metrics: [
      { key: 'merged_prs', value: 117, sampleSize: 117 },
      { key: 'median_lead_time_hours', value: null, sampleSize: 0 },
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
        {
          key: 'opened_prs',
          value: 40,
          prior: 38,
          absoluteChange: 2,
          percentChange: 5.3,
          significant: false,
          direction: 'neutral',
        },
      ],
      refusal: null,
    },
    forecasts: [
      {
        available: false,
        key: 'median_lead_time_hours',
        reason: 'insufficient_history',
      },
    ],
    movements: [],
    suggested: [],
    narrative: null,
    model: null,
    metricsSchemaVersion: 2,
    generatedAt: '2026-08-20T10:00:00.000Z',
    stale: false,
    ...over,
  };
}

describe('renderPeriodReportMarkdown', () => {
  it('titles the report with the date range, never the period key', () => {
    const md = renderPeriodReportMarkdown(baseReport());
    expect(md.split('\n')[0]).toMatch(/^# 18 Aug/);
    expect(md.split('\n')[0]).not.toContain('sprint-2026');
  });

  it('carries the coverage sentence verbatim', () => {
    const md = renderPeriodReportMarkdown(baseReport());
    expect(md).toContain(
      'All 8 repos in this workspace were already being tracked when this period started.',
    );
    const partial = renderPeriodReportMarkdown(
      baseReport({ coverage: { trackedRepos: 5, totalRepos: 8, complete: false } }),
    );
    expect(partial).toContain('**Partial coverage.** 5 of 8 repos in this workspace');
    expect(partial).toContain('which is why the comparison is computed over the repos present in both');
  });

  it('states the comparison subset disclosure verbatim, with the prior period named', () => {
    const md = renderPeriodReportMarkdown(baseReport());
    expect(md).toContain(
      'Comparison covers 7 of 8 repos tracked across both periods · vs sprint-2026-08-04',
    );
  });

  // The one-population rule survives the export: the row's This-period figure is the SUBSET's
  // (113), with the full-membership headline disclosed beside it — never mixed into the
  // subtraction (117 − 146 does not equal the printed −33; 113 − 146 does).
  it('keeps one population per row, disclosing the headline separately', () => {
    const md = renderPeriodReportMarkdown(baseReport());
    const row = md.split('\n').find((l) => l.startsWith('| Merged PRs'))!;
    expect(row).toContain('| 113 (all repos: 117) |');
    expect(row).toContain('| 146 |');
    expect(row).toContain('▼ −33 (−23%)');
  });

  it('renders an insignificant delta without a percentage', () => {
    const md = renderPeriodReportMarkdown(baseReport());
    const row = md.split('\n').find((l) => l.startsWith('| Opened PRs'))!;
    expect(row).toContain('+2 · not significant');
    expect(row).not.toContain('%');
  });

  it('renders null as "—", never 0', () => {
    const md = renderPeriodReportMarkdown(baseReport());
    const row = md.split('\n').find((l) => l.startsWith('| Lead time'))!;
    expect(row).toContain('| — |');
  });

  it('states "no prior period" for a first period rather than inventing a comparison', () => {
    const md = renderPeriodReportMarkdown(
      baseReport({
        comparison: {
          priorPeriodKey: null,
          subsetRepoIds: [],
          subsetDisclosure: '',
          deltas: [],
          refusal: 'no_prior_period',
        },
      }),
    );
    expect(md).toContain(`**No comparison.** ${REFUSAL_TEXT.no_prior_period}`);
    const row = md.split('\n').find((l) => l.startsWith('| Merged PRs'))!;
    expect(row).toContain('no prior period');
    expect(row).not.toMatch(/\| 0 \|/);
  });

  it('lists every refused forecast with its named reason and the reader-facing text', () => {
    const md = renderPeriodReportMarkdown(baseReport());
    expect(md).toContain('Not forecast:');
    expect(md).toContain(`Lead time — insufficient history: ${REFUSAL_TEXT.insufficient_history}`);
  });

  it('includes the narrative verbatim when present, and says so honestly when absent', () => {
    const withNarrative = renderPeriodReportMarkdown(
      baseReport({ narrative: 'A quieter fortnight.', model: 'claude-sonnet-5' }),
    );
    expect(withNarrative).toContain('## Write-up');
    expect(withNarrative).toContain('A quieter fortnight.');
    expect(withNarrative).toContain('written up with claude-sonnet-5');

    const without = renderPeriodReportMarkdown(baseReport());
    expect(without).toContain('Figures only — this period has not been written up.');
  });

  it('is deterministic — the same stored report copies byte-identical markdown', () => {
    const report = baseReport();
    expect(renderPeriodReportMarkdown(report)).toBe(renderPeriodReportMarkdown(report));
  });

  // ── Keys outside the current vocabulary ────────────────────────────────────────────────────
  //
  // A report stored under an OLDER PERIOD_METRICS_SCHEMA_VERSION is still servable (stale +
  // regenerate is the designed path), and its stored forecasts/movements can carry keys the
  // current union renamed away — v1's `median_time_to_first_review_hours`. This crashed live
  // ("Cannot read properties of undefined (reading 'standaloneLabel')") inside a render-time
  // useMemo with no error boundary above it, blanking the whole Reports pane on the workspace
  // holding the row. The renderer must be TOTAL: unknown keys render under their humanized name.
  it('renders a report carrying old-vocabulary keys instead of throwing', () => {
    const report = baseReport({
      forecasts: [
        {
          available: false,
          key: 'median_time_to_first_review_hours' as never,
          reason: 'too_volatile',
        },
      ],
      movements: [
        {
          key: 'median_time_to_first_review_hours' as never,
          absoluteChange: -3,
          percentChange: -12,
          rank: 0,
          favourable: true,
        },
      ],
    });
    const md = renderPeriodReportMarkdown(report);
    expect(md).toContain(
      `median time to first review hours — too volatile: ${REFUSAL_TEXT.too_volatile}`,
    );
    expect(md).toContain('**Biggest movers:** median time to first review hours ▼ −3');
  });
});
