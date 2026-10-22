import type {
  BotBenchmarkAnomaly,
  BotBenchmarkAnomalyKind,
  BotBenchmarkPlacementMetric,
} from '@pierre-review/shared';

// THE PRODUCT'S ACTUAL OUTPUT. A placement is a rank; an anomaly is a rank that is worth acting on,
// and it names WHICH action.
//
// ⚠ AN ANOMALY NEEDS BOTH A SHARE AND A MAGNITUDE. This is the Chronology lesson applied verbatim —
// "lopsided AND slow, or say nothing". A percentile alone INVENTS A CRISIS IN A HEALTHY REPOSITORY:
// somebody is always in the 95th percentile, and in a cohort that is fine everywhere the 95th
// percentile is still fine. Chronology shipped a first cut that reported a share without a
// magnitude and manufactured a finding on a repository with an eighteen-minute p75; this file
// exists so that cannot happen here.
//
// ⚠ AND A THIRD GATE THE COHORT ITSELF SUPPLIES: the 95 % CI of the cohort's MEDIAN. At the 30-repo
// floor a rate's median CI routinely spans twenty points, so "your 41 % vs the cohort's 38 %" is
// reporting noise as a gap. A customer value INSIDE that interval is statistically indistinguishable
// from the cohort's own centre, and nothing is said.
//
// ⚠ FOUR KINDS, FOUR ACTIONS, AND THE ACTIONS ARE TEMPLATED — never model-generated. Each sentence
// is a fixed string over numbers this module computed; there is no LLM anywhere in this feature.

/** A percentile at or above this is the top of the cohort. */
const HIGH_PERCENTILE = 90;
/** A percentile at or below this is the bottom of the cohort. */
const LOW_PERCENTILE = 10;

interface AnomalyRule {
  kind: BotBenchmarkAnomalyKind;
  metric: string;
  /** Which tail fires. `high` reads `percentile >= HIGH_PERCENTILE`, `low` the mirror. */
  tail: 'high' | 'low';
  /** GATE 2 — the minimum absolute distance from the cohort median, in the metric's own unit.
   *  Every number here is a JUDGEMENT and is written to be argued with. */
  magnitudeThreshold: number;
  /** Extra precondition on the COHORT, where the finding only means something against a healthy
   *  peer group. */
  cohortMedianAtLeast?: number;
  /** ⚠ TAKES THE REVIEWER'S NAME, because "the same product" is not a phrase anyone says. The
   *  reader is looking at a card headed CodeRabbit; the sentence under it should say CodeRabbit,
   *  not make them work out which product "the same product" refers to. `name` is
   *  `reviewers[0].label` at the call site and falls back to "this reviewer" for an unbranded
   *  account, which is a real and common state — so the sentence is written to read correctly
   *  with EITHER substitution. Still a fixed template over numbers this module computed: there is
   *  no model anywhere in this feature. */
  action: (name: string) => string;
  /** WHAT `units` COUNTS FOR THIS RULE, as a plain noun for the "measured over N …" clause.
   *
   *  ⚠ IT IS NOT ONE NOUN ACROSS THE FOUR RULES, which is why the sentence used to end "(over 84
   *  of yours)" and say nothing. `findings_per_merged_pr` counts MERGED PULL REQUESTS; the other
   *  three count THREADS. A single guessed noun was briefly shipped as "84 of your repos" — false
   *  on a one-repository workspace, and false in the inflating direction, which is the worst way
   *  for a sample size to be wrong. Each noun below is the plain-English form of that metric's own
   *  `denominator` in the corpus's metric_specs, so the wording cannot drift from the fold. */
  unitsNoun: string;
}

const RULES: readonly AnomalyRule[] = [
  {
    kind: 'volume',
    metric: 'findings_per_merged_pr',
    tail: 'high',
    // A WHOLE EXTRA FINDING on every merged pull request, not "measurably more". Below that the
    // gap is smaller than the difference between two of the reviewer's own weeks.
    magnitudeThreshold: 1,
    // metric_specs: "merged, human-authored, detail-observed pull requests"
    unitsNoun: 'merged pull requests',
    action: (name) =>
      `${name} leaves at least one extra comment on every merged pull request, compared with ` +
      `other teams running ${name} on repositories this size. Narrow its rules, or point it at ` +
      'fewer folders.',
  },
  {
    kind: 'engagement',
    metric: 'acted_on_rate',
    tail: 'low',
    // Fifteen points below the cohort's own centre.
    magnitudeThreshold: 0.15,
    // ⚠ "WHILE THE COHORT MEDIAN IS HEALTHY". A low acted-on rate in a cohort where NOBODY acts on
    // this bot is a fact about the product, not about this team, and telling a customer to retire
    // it would be advice derived from the vendor's general reputation wearing their own data.
    cohortMedianAtLeast: 0.5,
    // metric_specs: "settled, fully-read vendor threads"
    unitsNoun: 'finished comment threads',
    action: (name) =>
      `Most teams running ${name} act on what it says. Your team acts on far less of it, so ` +
      'less of what you pay for gets used. Keep the kinds of comment your team acts on and turn ' +
      'off the rest, or drop it.',
  },
  {
    kind: 'latency',
    metric: 'median_hours_to_first_human_reply',
    tail: 'high',
    // A WHOLE DAY slower than the cohort's median. Hours of difference are working patterns.
    magnitudeThreshold: 24,
    // metric_specs: "settled complete vendor threads that received a human reply"
    unitsNoun: 'comment threads someone replied to',
    action: (name) =>
      `Nothing is wrong with what ${name} says. Someone just takes more than a day longer to ` +
      'reply to it here than on similar repositories — so make sure its comments reach a person ' +
      'sooner.',
  },
  {
    kind: 'overlap',
    metric: 'cross_bot_overlap_rate',
    tail: 'high',
    // ⚠ THIS THRESHOLD IS ALSO THE FLOOR ON THE VALUE ITSELF, and deliberately not a second
    // condition beside it. The obvious extra guard — "and the rate must itself exceed 10 %, so the
    // 90th percentile of a cohort where overlap is near zero everywhere cannot fire" — is
    // UNREACHABLE: for a rate the cohort median is non-negative, so `value - median >= 0.1` already
    // implies `value >= 0.1`. It was written, mutation-tested, found unfalsifiable and removed
    // rather than shipped as a guard that cannot fire.
    magnitudeThreshold: 0.1,
    // metric_specs: "settled vendor threads with a (path, line) anchor"
    unitsNoun: 'comment threads anchored to a line',
    action: (name) =>
      `${name} and another bot comment on the same lines, so you are paying twice for one ` +
      'opinion. Limit one of them to certain folders, or drop it.',
  },
];

export interface AnomalyContext {
  cohortRepos: number;
  bandLabel: string;
  /** The reviewer's display name ("CodeRabbit"), or null for an unbranded account — every action
   *  sentence names it rather than saying "the same product". */
  reviewerName: string | null;
}

/**
 * The anomalies for ONE (repository, vendor) unit. Empty is the common and healthy answer.
 *
 * Only a `compared` metric can fire: a refusal has no percentile to read (that is the whole point
 * of the discriminated union), and an `uncompared` value has no cohort to be extreme within.
 */
export function anomaliesFor(
  metrics: Record<string, BotBenchmarkPlacementMetric>,
  context: AnomalyContext,
): BotBenchmarkAnomaly[] {
  const out: BotBenchmarkAnomaly[] = [];
  for (const rule of RULES) {
    const metric = metrics[rule.metric];
    if (metric == null || metric.status !== 'compared') continue;
    const median = metric.cohort.quantiles['p50'];
    if (typeof median !== 'number') continue;

    // GATE 1 — the share. Where in the cohort does this land?
    const share =
      rule.tail === 'high'
        ? metric.percentile >= HIGH_PERCENTILE
        : metric.percentile <= LOW_PERCENTILE;
    if (!share) continue;

    // GATE 2 — the magnitude. How far from the cohort's own centre, in real units?
    const gap = rule.tail === 'high' ? metric.value - median : median - metric.value;
    if (!(gap >= rule.magnitudeThreshold)) continue;

    if (rule.cohortMedianAtLeast != null && !(median >= rule.cohortMedianAtLeast)) continue;

    // GATE 3 — the cohort's own uncertainty about its median. Inside the interval, the gap is not
    // distinguishable from noise and there is nothing to report.
    const ci = metric.cohort.ciMedian95;
    if (ci != null && metric.value >= ci[0] && metric.value <= ci[1]) continue;

    out.push({
      kind: rule.kind,
      metric: rule.metric,
      action: rule.action(context.reviewerName ?? 'This reviewer'),
      share: {
        percentile: metric.percentile,
        threshold: rule.tail === 'high' ? HIGH_PERCENTILE : LOW_PERCENTILE,
        direction: metric.cohort.direction,
      },
      magnitude: {
        value: metric.value,
        cohortMedian: median,
        gap,
        threshold: rule.magnitudeThreshold,
        unit: metric.cohort.unit,
      },
      units: metric.units,
      unitsNoun: rule.unitsNoun,
      cohortRepos: context.cohortRepos,
      bandLabel: context.bandLabel,
    });
  }
  return out;
}

/** The kinds this build can emit, in reporting order — so a consumer can render an empty state per
 *  kind rather than "no anomalies", which reads as "not checked". */
export const ANOMALY_KINDS: readonly BotBenchmarkAnomalyKind[] = RULES.map((r) => r.kind);
