// UNITS ON PERIOD-REPORT FIGURES.
//
// The narrative shipped "Reviewer concentration: 50 (was 38.55, +29.70%)" and a reader took the
// 50 for a count of PRs. It is a PERCENTAGE — `reviewer_concentration_pct` — and its unit was
// already computed, already on the narration payload beside the phrase, and simply never spliced
// into the string. These tests pin the spelling of every figure class, and — the one that
// actually protects the feature — that a unit-suffixed phrase still passes the D4 grounded-figure
// check against its OWN grounding set. A regression there is silent: every AI narrative would be
// discarded and replaced by the templated fallback, with nothing thrown and nothing logged as an
// error.
//
// `−` below is U+2212 MINUS SIGN, written as an escape so it cannot be mistaken for a hyphen —
// it is the character the phrase builder emits.
import { describe, expect, it } from 'vitest';
import type { PeriodMetricDelta, PeriodMovement, PeriodReport } from '@pierre-review/shared';
import {
  formatFigure,
  formatMetricChange,
  formatMetricValue,
  movementPhrase,
} from '../insights/period-questions.js';
import { groundingFigureSet, templatedNarrative, ungroundedNumerals } from '../insights/grounded-figures.js';
import { narrationPayload } from '../insights/period-report.js';

const MINUS = '−';

const delta = (over: Partial<PeriodMetricDelta> & Pick<PeriodMetricDelta, 'key'>): PeriodMetricDelta => ({
  value: null,
  prior: null,
  absoluteChange: null,
  percentChange: null,
  significant: true,
  direction: 'neutral',
  ...over,
});

const movement = (over: Partial<PeriodMovement> & Pick<PeriodMovement, 'key'>): PeriodMovement => ({
  absoluteChange: 0,
  percentChange: null,
  rank: 0,
  favourable: false,
  ...over,
});

// ── The three figure classes from the bug report, plus the two that share their shapes ───────

describe('formatMetricValue', () => {
  it('binds % tight — the figure that was misread as a count of PRs', () => {
    expect(formatMetricValue('reviewer_concentration_pct', 50)).toBe('50%');
    expect(formatMetricValue('reviewer_concentration_pct', 38.55)).toBe('38.55%');
  });

  it('binds hours tight as `h`, the way the table and PersonPeriodSection already spell it', () => {
    expect(formatMetricValue('median_time_to_first_human_review_hours', 19.56)).toBe('19.56h');
    expect(formatMetricValue('median_lead_time_hours', 18)).toBe('18h');
  });

  it('spaces every noun unit', () => {
    expect(formatMetricValue('merged_prs', 117)).toBe('117 PRs');
    expect(formatMetricValue('median_pr_size_lines', 142)).toBe('142 lines');
    expect(formatMetricValue('review_threads_opened', 19)).toBe('19 threads');
    // Two decimals, not one: the number spelling is unchanged by this fix (`toFixed(2)` on any
    // non-integer), and only the unit is new.
    expect(formatMetricValue('bot_comments_per_merged_pr', 4.2)).toBe('4.20 comments/PR');
  });

  it('keeps the number spelling: integers bare, everything else to two decimals', () => {
    expect(formatFigure(117)).toBe('117');
    expect(formatFigure(38.55)).toBe('38.55');
    expect(formatFigure(4.2)).toBe('4.20');
    expect(formatMetricValue('merged_prs', 117.5)).toBe('117.50 PRs');
  });
});

describe('formatMetricChange', () => {
  it('measures a percentage metric’s change in POINTS, matching the on-screen movement pill', () => {
    // "+11.45%" would be a percentage of a percentage — the exact ambiguity `pointsFmt` exists
    // for in periodReportMarkdown.ts, and the prose sits next to that pill.
    expect(formatMetricChange('reviewer_concentration_pct', 11.45)).toBe('11.45 pts');
    expect(formatMetricChange('merge_ci_success_pct', 5)).toBe('5 pts');
  });

  it('is the value spelling for every other metric', () => {
    expect(formatMetricChange('merged_prs', 29)).toBe('29 PRs');
    expect(formatMetricChange('median_lead_time_hours', 3.91)).toBe('3.91h');
  });
});

// ── The phrase the prompt orders copied character for character ──────────────────────────────

describe('movementPhrase', () => {
  it('units both sides of a percentage metric and leaves the percent CHANGE alone', () => {
    const phrase = movementPhrase(
      movement({ key: 'reviewer_concentration_pct', absoluteChange: 11.45, percentChange: 29.7 }),
      delta({ key: 'reviewer_concentration_pct', value: 50, prior: 38.55, absoluteChange: 11.45, percentChange: 29.7 }),
    );
    // The bug report's line, fixed. The trailing token is the RELATIVE change — a different
    // quantity — so it stays a bare `%` and must never become `pts`.
    expect(phrase).toBe('50% (was 38.55%, +29.70%)');
  });

  it('units an hours metric with `h` and still reports the change as a percentage', () => {
    const phrase = movementPhrase(
      movement({ key: 'median_time_to_first_human_review_hours', absoluteChange: 3.91, percentChange: 24.98 }),
      delta({
        key: 'median_time_to_first_human_review_hours',
        value: 19.56,
        prior: 15.65,
        absoluteChange: 3.91,
        percentChange: 24.98,
      }),
    );
    expect(phrase).toBe('19.56h (was 15.65h, +24.98%)');
    // Regression guard for the rule above: the phrase ends on the percent-change token, not on
    // a unit borrowed from the metric.
    expect(phrase.endsWith('%)')).toBe(true);
  });

  it('units a count metric on both sides', () => {
    const phrase = movementPhrase(
      movement({ key: 'merged_prs', absoluteChange: -29, percentChange: -19.86 }),
      delta({ key: 'merged_prs', value: 117, prior: 146, absoluteChange: -29, percentChange: -19.86 }),
    );
    expect(phrase).toBe(`117 PRs (was 146 PRs, ${MINUS}19.86%)`);
  });

  it('units the absolute-change branch — the defensive form with no delta pair', () => {
    // A percentage metric's absolute change is POINTS here too.
    expect(
      movementPhrase(
        movement({ key: 'reviewer_concentration_pct', absoluteChange: 11.45, percentChange: 29.7 }),
        undefined,
      ),
    ).toBe('+11.45 pts, +29.70%');
    // …and a delta whose pair is half-null takes the same branch.
    expect(
      movementPhrase(
        movement({ key: 'review_threads_opened', absoluteChange: -7 }),
        delta({ key: 'review_threads_opened', value: 19, prior: null, absoluteChange: null }),
      ),
    ).toBe(`${MINUS}7 threads`);
  });
});

// ── The one that protects the feature ────────────────────────────────────────────────────────

function report(movements: PeriodMovement[], deltas: PeriodMetricDelta[]): PeriodReport {
  return {
    periodKey: 'sprint-2026-08-18',
    periodStart: '2026-08-18T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    grain: 'sprint',
    cadenceDays: 14,
    coverage: { trackedRepos: 7, totalRepos: 8, complete: false },
    metrics: [
      { key: 'merged_prs', value: 117, sampleSize: 117 },
      { key: 'reviewer_concentration_pct', value: 50, sampleSize: 42 },
      { key: 'median_time_to_first_human_review_hours', value: 19.56, sampleSize: 42 },
    ],
    comparison: {
      priorPeriodKey: 'sprint-2026-08-04',
      subsetRepoIds: [1, 2, 3, 4, 5, 6, 7],
      subsetDisclosure: 'covers 7 of 8 repos tracked across both periods',
      deltas,
      refusal: null,
    },
    forecasts: [],
    movements,
    suggested: [],
    narrative: null,
    model: null,
    metricsSchemaVersion: 2,
    generatedAt: '2026-08-25T14:37:52.481Z',
    stale: false,
  };
}

const CASES: { movements: PeriodMovement[]; deltas: PeriodMetricDelta[] } = {
  movements: [
    movement({ key: 'reviewer_concentration_pct', absoluteChange: 11.45, percentChange: 29.7, rank: 0 }),
    movement({
      key: 'median_time_to_first_human_review_hours',
      absoluteChange: 3.91,
      percentChange: 24.98,
      rank: 1,
    }),
    movement({ key: 'merged_prs', absoluteChange: -29, percentChange: -19.86, rank: 2 }),
    // No delta pair → the absolute-change branch, inside a real payload.
    movement({ key: 'review_threads_opened', absoluteChange: -7, rank: 3 }),
  ],
  deltas: [
    delta({ key: 'reviewer_concentration_pct', value: 50, prior: 38.55, absoluteChange: 11.45, percentChange: 29.7 }),
    delta({
      key: 'median_time_to_first_human_review_hours',
      value: 19.56,
      prior: 15.65,
      absoluteChange: 3.91,
      percentChange: 24.98,
    }),
    delta({ key: 'merged_prs', value: 117, prior: 146, absoluteChange: -29, percentChange: -19.86 }),
    delta({ key: 'review_threads_opened', value: 19, prior: null, absoluteChange: null }),
  ],
};

describe('a unit-suffixed phrase stays grounded (D4)', () => {
  const r = report(CASES.movements, CASES.deltas);
  const payload = narrationPayload(r);
  const allowed = groundingFigureSet(payload);

  it('every pre-rendered phrase passes the grounded-figure check verbatim', () => {
    // The prompt orders these copied character for character, so a model that OBEYS must not be
    // the thing that trips the check. `%`, `h`, ` PRs`, ` threads` and ` pts` carry no digits, so
    // each phrase tokenizes to exactly the figures the payload holds.
    const phrases = (payload.movements as Array<{ phrase: string }>).map((m) => m.phrase);
    expect(phrases).toEqual([
      '50% (was 38.55%, +29.70%)',
      '19.56h (was 15.65h, +24.98%)',
      `117 PRs (was 146 PRs, ${MINUS}19.86%)`,
      `${MINUS}7 threads`,
    ]);
    for (const phrase of phrases) {
      expect(ungroundedNumerals(phrase, allowed)).toEqual([]);
    }
  });

  it('a whole bullet list built from the phrases is grounded', () => {
    const bullets = (payload.movements as Array<{ metric: string; phrase: string }>)
      .map((m) => `- ${m.metric}: ${m.phrase} — steady as she goes`)
      .join('\n');
    expect(ungroundedNumerals(bullets, allowed)).toEqual([]);
  });

  it('the templated fallback — same renderer — is still grounded by construction', () => {
    expect(ungroundedNumerals(templatedNarrative(r), allowed)).toEqual([]);
    expect(templatedNarrative(r)).toContain('reviewer concentration 50% (was 38.55%, +29.70%)');
  });

  it('still rejects an invented figure — the units did not widen the set', () => {
    expect(ungroundedNumerals('concentration hit 91% across 340 PRs', allowed)).toEqual(
      expect.arrayContaining(['91', '340']),
    );
  });
});
