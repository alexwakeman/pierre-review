import { useMemo, useState } from 'react';
import type {
  BotBenchmarkDirection,
  BotBenchmarkPlacementCounters,
  BotBenchmarkPlacementResponse,
  BotBenchmarkPlacementUnit,
  BotBenchmarkRollupExpectation,
  BotBenchmarkRollupRefusalReason,
  BotBenchmarkWorkspaceCost,
} from '@pierre-review/shared';
import { useBotBenchmarkPlacement, useBotBenchmarkSpecs } from '../../hooks/useBotBenchmark.js';
import { useFilters } from '../../store/filters.js';
import { PALETTE, useChartWidth } from '../charts/common.js';
import { SkeletonBlock } from '../Skeleton.js';
import {
  BotIcon,
  ChartIcon,
  ChevronIcon,
  CoinIcon,
  InfoIcon,
  ScalesIcon,
  ThinSampleIcon,
  ThreadsIcon,
  WarningIcon,
  WorkspaceIcon,
} from '../Icons.js';
import {
  COST_BASIS_LABEL,
  COST_REFUSAL_HEADLINE,
  DERIVATION_LABEL,
  EXCLUSION_HEADLINE,
  FINDINGS_EMPTY_HEADLINE,
  PLACEMENT_REFUSAL_HEADLINE,
  ROLLUP_REFUSAL_HEADLINE,
  STALENESS_LABEL,
  UNAVAILABLE_HEADLINE,
  absentMetricRows,
  anomalyRows,
  bandFitNote,
  collapsedExclusion,
  collapsedWorkspaceCostRefusal,
  contributionRows,
  costPricedReviewersNote,
  costSeatUnresolvedNote,
  costSeatZeroNote,
  findingsEmptyState,
  formatCount,
  formatMetricValue,
  formatThreadCount,
  formatUsd,
  metricLabel,
  metricRows,
  orderedUnits,
  percentileSentence,
  placementTally,
  reviewerColor,
  reviewerLabel,
  rollupExpectationSentence,
  rollupRows,
  rollupSpreadSentence,
  sharedComparisonRefusal,
  stripGeometry,
  unitTitle,
  workspaceCostActedOnDetail,
  workspaceCostActedOnLabel,
  workspaceCostCoverageNote,
  workspaceCostHeadline,
  workspaceCostPartialWindowNote,
  workspaceCostPriceLine,
  workspaceCostSpanUnobservedNote,
  workspaceCostWindowIncompleteNote,
  type CostBasis,
  type RollupRow,
  type StripGeometry,
} from './benchmarkModel.js';

// **Bots → Benchmark** — the customer side of "how does our review bot compare".
//
// The cohort lives in a fitted artifact bundled with the plugin (per vendor × activity band,
// drawn from 2,204 public repositories); `GET /api/pro/bot-benchmark/placement` folds THIS
// workspace's (repository × reviewer) units over the CORPUS's own metric definitions, places each
// one in its band and reads a percentile off the cell. This file draws the answer.
//
// ── THREE RULES THIS PANEL KEEPS ───────────────────────────────────────────────────────────────
//
//  1. THE ANOMALY LIST IS THE HEADLINE. A percentile is trivia; "your team acts on far less of
//     this reviewer than its peer repositories do, and here is what to do about it" is a work
//     item. The findings lead, the distributions are evidence UNDER them, and the empty case says
//     how much was checked so that "nothing stands out" reads as CHECKED rather than NOT RUN.
//
//  2. EVERY PERCENTILE CARRIES ITS COHORT n AND ITS BAND COUNT. "Upper fifth of Greptile
//     repositories" is honest at 5 bands and a misrepresentation at 10 — and the seven fitted
//     vendors carry 10/10/9/7/4/3/2. Widening is visible or it does not happen.
//
//  3. A REFUSAL READS AS A REFUSAL, NEVER AS AN EMPTY CHART. "We have never measured this
//     reviewer" (DeepSource is a real case), "we have too little of it to stratify", "no peer
//     repository of this size runs it", "your repository is too new to place" and "this build
//     ships no corpus" are five different facts. Every one of them renders its own sentence plus
//     the server's own message; none of them renders a zero, an empty axis or a blank cell.
//
//  4. TWO GRAINS, TWO SCREENS, AND THE PROP THAT DECIDES IS `repoId`. The RAIL (`repoId == null`)
//     draws ONE CARD PER VENDOR over the whole Workspace — pooled counters, the money, the spread
//     of placements and the estate-matched expectation, with the per-repository placements folded
//     underneath as an evidence table. The REPOSITORY's own Bots tab (`repoId != null`) draws the
//     per-repository cards it always drew — thirteen metric strips, band placement, refusals.
//     ⚠ NEITHER SCREEN DRAWS THE OTHER'S CARD, and MONEY LIVES ONLY ON THE ROLLUP. A price is
//     bought once for a Workspace, so a subscription measured against ONE repository's work was an
//     upper bound that shipped once per repository under a "do not add these up" caveat. The server
//     enforces the same split — a repo-narrowed request carries no `rollup` and no cost figure
//     anywhere in its payload — so there is nothing here to render even if a future edit went
//     looking.
//
// ── AND ONE COST RULE ──────────────────────────────────────────────────────────────────────────
// NOTHING FETCHES ON MOUNT except the ONE scoped placement query. The definitions disclosure at
// the bottom is CLICK-GATED (the Pending board's `MergeWhenReadyControl` precedent, where an eager
// per-card fetch turned a fifty-card board into 150 GitHub calls). No chart library, no icon font:
// the strips are inline SVG over the existing zero-dependency toolkit, and every glyph is a
// component from `Icons.tsx`.
//
// ⚠ NO RADAR CHART. Thirteen metrics on one polygon implies the axes are commensurable and share a
// scale; they are a rate, a count per pull request and a duration. Small multiples, each with its
// own axis, are the only honest form for this shape.

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The strip
   ───────────────────────────────────────────────────────────────────────────────────────── */

const STRIP_HEIGHT = 18;

/**
 * One metric's cohort distribution with the customer's value on it: the p10–p90 spread, the
 * p25–p75 box, the median tick, the median's 95% CI, and your dot.
 *
 * ⚠ THE DOT CARRIES NO VERDICT COLOUR. Whether high is good is served as `direction` and rendered
 * as WORDS beside the label; painting 13 dots green-or-amber would turn a distribution into a
 * scorecard, and a percentile on its own is exactly the claim the anomaly gates exist to refuse.
 * The only coloured mark on this panel is on a row that produced a finding.
 */
function DistributionStrip({
  geom,
  width,
  flagged,
}: {
  geom: StripGeometry;
  width: number;
  flagged: boolean;
}): JSX.Element {
  const x = (f: number): number => f * width;
  const mid = STRIP_HEIGHT / 2;
  return (
    <svg
      width={width}
      height={STRIP_HEIGHT}
      className="decorative-mark text-gray-300 dark:text-gray-600"
      aria-hidden="true"
    >
      {/* The p10–p90 spread, then the p25–p75 box on top of it. */}
      <rect
        x={x(geom.p10)}
        y={mid - 4}
        width={Math.max(1, x(geom.p90) - x(geom.p10))}
        height={8}
        fill={PALETTE.slate}
        opacity={0.16}
        rx={2}
      />
      <rect
        x={x(geom.p25)}
        y={mid - 4}
        width={Math.max(1, x(geom.p75) - x(geom.p25))}
        height={8}
        fill={PALETTE.slate}
        opacity={0.32}
        rx={2}
      />
      {/* The cohort's median. */}
      <line
        x1={x(geom.p50)}
        x2={x(geom.p50)}
        y1={mid - 6}
        y2={mid + 6}
        stroke={PALETTE.slate}
        strokeWidth={1.5}
      />
      {/* ⚠ THE MEDIAN'S 95% CI, drawn because at the 30-repo floor it routinely spans twenty
          points — "your 41% vs the cohort's 38%" inside this interval is noise reported as a gap,
          and the anomaly rules suppress exactly that. Showing it is what lets a reader apply the
          same discount to a row that did NOT fire. */}
      {geom.ci != null && (
        <line
          x1={x(geom.ci[0])}
          x2={x(geom.ci[1])}
          y1={mid - 7.5}
          y2={mid - 7.5}
          stroke={PALETTE.slate}
          strokeWidth={2}
          opacity={0.45}
          strokeLinecap="round"
        />
      )}
      {/* Your value. */}
      <circle
        cx={x(geom.value)}
        cy={mid}
        r={4}
        fill={flagged ? PALETTE.red : PALETTE.blue}
        stroke="currentColor"
        strokeWidth={1}
      />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Small parts
   ───────────────────────────────────────────────────────────────────────────────────────── */

const DIRECTION_LABEL: Record<BotBenchmarkDirection, string> = {
  higher_is_better: 'higher is better',
  lower_is_better: 'lower is better',
  neutral: 'neither better nor worse',
};

/** ⚠ A FALLBACK ONLY, and only for the `uncompared` arm — the one arm that carries a value but no
 *  cohort, and therefore no served `unit`. Every `compared` row formats with the unit the COHORT
 *  served, never this table. It is a presentation fact (how to print the number), never a
 *  definition: the numerator/denominator/population lives in `metricSpecs` and is rendered from
 *  the server in the disclosure at the bottom of this panel. */
const FALLBACK_UNIT: Readonly<Record<string, string>> = {
  acted_on_rate: 'rate',
  acted_on_rate_with_outdated: 'rate',
  thread_resolved_rate: 'rate',
  thread_outdated_rate: 'rate',
  human_reply_rate: 'rate',
  human_followed_last_bot_rate: 'rate',
  median_hours_to_first_human_reply: 'hours',
  overdue_untouched_rate_72h: 'rate',
  overdue_untouched_rate_168h: 'rate',
  findings_per_merged_pr: 'count_per_pr',
  threads_per_merged_pr: 'count_per_pr',
  pr_comment_coverage: 'rate',
  cross_bot_overlap_rate: 'rate',
};

function Card({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-950 ${className}`}
    >
      {children}
    </div>
  );
}

/** A refusal, in the app's "we are declining to answer, and here is why" grammar: a HEADLINE the
 *  reader can scan, the SERVER's own sentence beneath it, and the numbers behind it where the
 *  server sent them. Never a chart, never a zero. */
function RefusalNote({
  headline,
  message,
  observed,
  required,
  testId,
}: {
  headline: string;
  message: string;
  observed?: Record<string, number>;
  required?: Record<string, number>;
  testId?: string;
}): JSX.Element {
  const shortfall =
    observed != null && required != null
      ? Object.keys(required)
          .map((k) => {
            const o = observed[k];
            const r = required[k];
            return o == null || r == null ? null : `${k.replace(/_/g, ' ')}: ${o} of ${r}`;
          })
          .filter((s): s is string => s != null)
      : [];
  return (
    <div
      data-testid={testId}
      className="rounded border border-dashed border-gray-300 bg-gray-50 px-2.5 py-2 text-[11px] dark:border-gray-700 dark:bg-gray-900/40"
    >
      <div className="flex items-start gap-1.5">
        <InfoIcon className="mt-0.5 shrink-0 text-gray-400" />
        <div>
          <div className="font-medium text-gray-700 dark:text-gray-200">{headline}</div>
          <p className="mt-0.5 leading-relaxed text-gray-500 dark:text-gray-400">{message}</p>
          {shortfall.length > 0 && (
            <p className="mt-1 tabular-nums text-gray-400 dark:text-gray-500">
              {shortfall.join(' · ')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Cost primitives — shared by the Workspace cost block and the estate-matched expectation
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** The small chip that says WHERE a row's number came from. ⚠ Three sources sit in this one block
 *  — a price a human typed, rates counted from this Workspace's rows, and an engagement rate FITTED
 *  from the peer corpus — and the counterfactual is the one that must never read as an invoice. */
function BasisChip({ basis }: { basis: CostBasis }): JSX.Element {
  return (
    <span
      className="rounded bg-gray-500/10 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300"
      data-testid={`benchmark-cost-basis-${basis}`}
    >
      {COST_BASIS_LABEL[basis]}
    </span>
  );
}

/** One refused cost figure, inline — the same grammar an excluded metric row uses. The server's
 *  own sentence rides the `title`; the headline is the scannable half.
 *
 *  ⚠ IT SPEAKS ONE VOCABULARY, `BotBenchmarkCostRefusalReason`, AND ONLY THAT ONE. The rollup
 *  sections beside this block refuse in a DIFFERENT vocabulary — money reasons all have a remedy
 *  involving a price, comparison reasons have none — and they render their own sentences in their
 *  own sections rather than borrowing this row. A shared row keyed on a union of the two would let
 *  a renderer reach for the wrong sentence with nothing to stop it. */
function CostRefusedRow({
  label,
  refusal,
}: {
  label: string;
  refusal: { reason: keyof typeof COST_REFUSAL_HEADLINE; message: string };
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 py-1">
      <span className="w-44 shrink-0 text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
      <span
        className="text-[11px] font-medium text-gray-400"
        title={refusal.message}
        data-testid={`benchmark-cost-refused-${refusal.reason}`}
      >
        <ThinSampleIcon className="mr-1 inline-block align-[-0.05em]" />
        {COST_REFUSAL_HEADLINE[refusal.reason]}
      </span>
    </div>
  );
}

function CostValueRow({
  label,
  figure,
  detail,
  basis,
  testId,
}: {
  label: string;
  figure: string;
  detail: string;
  basis: CostBasis;
  testId: string;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 py-1" data-testid={testId}>
      <span className="w-44 shrink-0 text-[11px] text-gray-600 dark:text-gray-300">{label}</span>
      <span className="shrink-0 text-[11px] font-semibold tabular-nums text-gray-800 dark:text-gray-100">
        {figure}
      </span>
      <span className="text-[10px] tabular-nums text-gray-400">{detail}</span>
      <BasisChip basis={basis} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Findings — the headline
   ───────────────────────────────────────────────────────────────────────────────────────── */

function FindingsSection({
  units,
  tally,
}: {
  units: BotBenchmarkPlacementUnit[];
  tally: ReturnType<typeof placementTally>;
}): JSX.Element {
  const rows = useMemo(() => anomalyRows(units), [units]);

  if (rows.length === 0) {
    const empty = findingsEmptyState(tally);
    if (empty === 'nothing_comparable') {
      // ⚠ A REFUSAL, IN THE REFUSAL GRAMMAR — not a clean bill of health. A reviewer can be placed
      // in a band and still have every metric withheld (a quiet repository is `below_min_units`
      // thirteen times over). Saying "nothing stands out" there issues a verdict off no
      // measurement at all.
      return (
        <RefusalNote
          testId="benchmark-nothing-comparable"
          headline={FINDINGS_EMPTY_HEADLINE.nothing_comparable}
          message={
            `None of your ${formatCount(tally.units)} reviewer${tally.units === 1 ? '' : 's'} ` +
            'produced a single metric this corpus could rank — every one was withheld, and the ' +
            'reason is on each row below. That is a refusal, not a clean result: nothing here ' +
            'says your reviewers are behaving normally, only that there was not enough to compare.'
          }
        />
      );
    }
    // ⚠ "CHECKED", NOT "NOTHING HERE". Empty is the common and healthy answer, and the numbers say
    // so — a bare "no findings" is indistinguishable from a panel that never ran.
    return (
      <Card className="border-gray-200 dark:border-gray-800">
        <div className="flex items-start gap-2 text-[11px]">
          <ScalesIcon className="mt-0.5 shrink-0 text-gray-400" />
          <div>
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              {FINDINGS_EMPTY_HEADLINE.nothing_stands_out}
            </div>
            <p className="mt-0.5 leading-relaxed text-gray-500 dark:text-gray-400">
              {formatCount(tally.compared)} comparison
              {tally.compared === 1 ? '' : 's'} across {formatCount(tally.placed)} placed reviewer
              {tally.placed === 1 ? '' : 's'} — none of them far enough from its peer cohort, in
              both rank and real units, to be worth acting on. The distributions are below.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-2" data-testid="benchmark-findings">
      {rows.map((row) => {
        const { anomaly } = row;
        const rankRepos = row.rankRepos ?? anomaly.cohortRepos;
        return (
          <div
            key={row.key}
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <WarningIcon className="shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                {row.headline}
              </span>
              <span className="text-[11px] text-amber-700/80 dark:text-amber-300/80">
                {reviewerLabel(row.unit.botKind)} in {unitTitle(row.unit)}
              </span>
            </div>
            {/* The ACTION. Templated server-side — there is no model anywhere in this feature. */}
            <p className="mt-1 text-[12px] leading-relaxed text-amber-800 dark:text-amber-200">
              {anomaly.action}
            </p>
            {/* ⚠ BOTH GATES, SEPARATELY. The share and the magnitude are published as two numbers
                rather than as their conjunction so a reader can see WHY this fired and argue with
                the threshold instead of the verdict. */}
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
              <div className="flex gap-1.5">
                <dt className="text-amber-700/80 dark:text-amber-300/90">Rank</dt>
                <dd className="tabular-nums text-amber-900 dark:text-amber-100">
                  {percentileSentence({
                    percentile: anomaly.share.percentile,
                    nRepos: rankRepos,
                    bandLabel: anomaly.bandLabel,
                  })}
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-amber-700/80 dark:text-amber-300/90">Gap</dt>
                <dd className="tabular-nums text-amber-900 dark:text-amber-100">
                  {row.metricLabel}: yours {formatMetricValue(anomaly.magnitude.value, anomaly.magnitude.unit)},
                  {' '}a typical team{' '}
                  {formatMetricValue(anomaly.magnitude.cohortMedian, anomaly.magnitude.unit)}
                  {/* ⚠ THE SAMPLE SIZE NAMES WHAT IT COUNTED, AND THE NOUN IS THE SERVER'S. It is
                      not the same noun for every rule — one counts merged pull requests and three
                      count threads — so a noun chosen here would be false on three cards in four.
                      Absent (an older plugin), the clause drops the noun rather than guessing. */}
                  {' '}(measured over {formatCount(anomaly.units)}
                  {anomaly.unitsNoun != null ? ` of your ${anomaly.unitsNoun}` : ' of yours'})
                </dd>
              </div>
            </dl>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   One (repository × reviewer) unit
   ───────────────────────────────────────────────────────────────────────────────────────── */

function UnitCard({
  unit,
  width,
}: {
  unit: BotBenchmarkPlacementUnit;
  width: number;
}): JSX.Element {
  const rows = useMemo(() => metricRows(unit), [unit]);
  const flagged = useMemo(
    () => new Set(unit.anomalies.map((a) => a.metric)),
    [unit.anomalies],
  );
  const color = reviewerColor(unit.botKind);
  const placement = unit.placement;
  const bandNote =
    placement.status === 'placed'
      ? bandFitNote({
          activity: unit.activity.mergedPrsLast14d,
          bandRange: placement.bandRange,
          aboveTopBandBy: placement.aboveTopBandBy,
        })
      : null;
  // ⚠ ONE SENTENCE, NOT THIRTEEN. When every metric was withheld under the SAME reason, thirteen
  // identical rows read as thirteen separate measurements that each came back empty.
  const collapsed = useMemo(() => collapsedExclusion(rows), [rows]);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
          style={
            color != null
              ? { color, background: `${color}1a` }
              : undefined
          }
        >
          <BotIcon size={12} />
          {/* ⚠ THE REVIEWER IS NAMED EVEN WHEN THE COHORT REFUSES IT. A bot the corpus has never
              seen is still this workspace's biggest reviewer, and it must not read as a zero. */}
          {reviewerLabel(unit.botKind)}
        </span>
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
          {unitTitle(unit)}
        </span>
        {/* The logins folded into this one unit — two accounts the workspace classifies as one
            vendor are ONE unit, which is the corpus's own semantics. */}
        {unit.reviewers.length > 0 && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {unit.reviewers.map((r) => r.login).join(', ')}
          </span>
        )}
      </div>

      {placement.status === 'placed' ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
          {/* ⚠ THE BAND COUNT RIDES THE BAND. "Band 6" is meaningless; "band 6 of 10" is a rank. */}
          <span className="tabular-nums">
            Size group {placement.bandLabel} ({formatCount(placement.bandRange[0])}–
            {formatCount(placement.bandRange[1])} merged PRs a fortnight)
          </span>
          <span className="tabular-nums">
            Compared with {formatCount(placement.cohortRepos)} other teams’ repos this size
          </span>
          <span className="tabular-nums">
            You: {formatCount(unit.activity.mergedPrsLast14d)} merged in 14 days
          </span>
          {/* Why the samples below are the size they are: the corpus's own per-repository cap,
              applied to this repository's pull requests. */}
          <span className="tabular-nums" title="The corpus walk capped each repository the same way; folding your whole history instead would measure older threads than any cohort describes.">
            {formatCount(unit.activity.prsConsidered)} of its most recent PRs read
          </span>
          {placement.aboveTopBandBy != null && (
            <span className="text-amber-600 dark:text-amber-400">
              Busier than the top band’s own edge by {formatCount(placement.aboveTopBandBy)} —
              the outermost band is open in the direction it faces.
            </span>
          )}
          {/* ⚠ SAID OUT LOUD, because "band 1 of 10 (2–3 merged PRs)" beside "You: 0 merged"
              otherwise reads as a contradiction. It is not one: the band is a rank CUT drawn over
              the support repositories, not a bucket the customer has to fall inside. */}
          {bandNote != null && <span className="text-gray-400">{bandNote}</span>}
        </div>
      ) : (
        <div className="mt-2">
          <RefusalNote
            testId={`benchmark-placement-refusal-${placement.reason}`}
            headline={PLACEMENT_REFUSAL_HEADLINE[placement.reason]}
            message={placement.message}
            observed={placement.observed}
            required={placement.required}
          />
        </div>
      )}

      {/* ⚠ THE METRICS RENDER WHETHER OR NOT THE COHORT PLACED THIS UNIT. Without a cohort every
          row is `uncompared` or `excluded` — the customer's own numbers with no rank — and that is
          still worth showing: it is the difference between "we cannot compare this" and "we
          measured nothing". */}
      {collapsed != null ? (
        <div className="mt-2">
          <RefusalNote
            testId={`benchmark-metric-collapsed-${collapsed}`}
            headline={`${EXCLUSION_HEADLINE[collapsed]} — all ${formatCount(rows.length)} metrics`}
            message={
              (rows[0]?.metric.status === 'excluded' ? rows[0].metric.message : '') +
              ' Every metric this corpus measures is withheld for the same reason, so this is one ' +
              'refusal, not ' +
              formatCount(rows.length) +
              ' measurements that each came back empty.'
            }
          />
        </div>
      ) : (
      <div className="mt-2 divide-y divide-gray-100 dark:divide-gray-800/70">
        {rows.map((row) => {
          const m = row.metric;
          if (m.status === 'excluded') {
            return (
              <div key={row.name} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="w-52 shrink-0 text-[11px] text-gray-500 dark:text-gray-400">
                  {row.label}
                </span>
                <span
                  className="text-[11px] font-medium text-gray-400"
                  title={m.message}
                  data-testid={`benchmark-metric-excluded-${m.reason}`}
                >
                  <ThinSampleIcon className="mr-1 inline-block align-[-0.05em]" />
                  {EXCLUSION_HEADLINE[m.reason]}
                </span>
              </div>
            );
          }
          const unitStr =
            m.status === 'compared' ? m.cohort.unit : (FALLBACK_UNIT[row.name] ?? '');
          if (m.status === 'uncompared') {
            return (
              <div key={row.name} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="w-52 shrink-0 text-[11px] text-gray-500 dark:text-gray-400">
                  {row.label}
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                  {formatMetricValue(m.value, unitStr)}
                </span>
                {/* ⚠ NO PERCENTILE, AND NOT A ZERO. The customer has a real value; the COHORT
                    refused this metric in this cell, so there is no distribution to rank within. */}
                <span
                  className="text-[11px] text-gray-400"
                  title={m.cohortRefusal.message}
                  data-testid="benchmark-metric-uncompared"
                >
                  No peer distribution for this metric in this cohort
                </span>
              </div>
            );
          }
          const geom = stripGeometry(m.cohort.quantiles, m.value, m.cohort.ciMedian95);
          const isFlagged = flagged.has(row.name);
          return (
            <div key={row.name} className="py-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="w-52 shrink-0 text-[11px] text-gray-600 dark:text-gray-300">
                  {row.label}
                  <span className="ml-1 text-[11px] text-gray-500 dark:text-gray-400">
                    {DIRECTION_LABEL[m.cohort.direction]}
                  </span>
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] font-semibold tabular-nums text-gray-800 dark:text-gray-100">
                  {formatMetricValue(m.value, m.cohort.unit)}
                </span>
                {/* ⚠ RULE 2: the cohort n and the band count ride EVERY percentile. */}
                <span className="text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
                  {percentileSentence({
                    percentile: m.percentile,
                    nRepos: m.cohort.nRepos,
                    bandLabel:
                      placement.status === 'placed' ? placement.bandLabel : '',
                  })}
                </span>
                <span className="text-[10px] tabular-nums text-gray-400">
                  over {formatCount(m.units)} of yours
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="w-52 shrink-0 text-[10px] tabular-nums text-gray-400">
                  peer median {formatMetricValue(m.cohort.quantiles['p50'] ?? 0, m.cohort.unit)}
                  {m.cohort.ciMedian95 != null && (
                    <>
                      {' '}
                      (95% CI {formatMetricValue(m.cohort.ciMedian95[0], m.cohort.unit)}–
                      {formatMetricValue(m.cohort.ciMedian95[1], m.cohort.unit)})
                    </>
                  )}
                </span>
                {geom != null && width > 0 ? (
                  <span
                    title={`Cohort p10 ${formatMetricValue(m.cohort.quantiles['p10'] ?? 0, m.cohort.unit)} to p90 ${formatMetricValue(m.cohort.quantiles['p90'] ?? 0, m.cohort.unit)}; your value ${formatMetricValue(m.value, m.cohort.unit)}`}
                  >
                    <DistributionStrip
                      geom={geom}
                      width={Math.max(80, width - 240)}
                      flagged={isFlagged}
                    />
                  </span>
                ) : (
                  // ⚠ NO STRIP RATHER THAN A PARTIAL ONE. A chart drawn from an incomplete grid is
                  // a picture of a distribution nobody fitted.
                  <span className="text-[11px] text-gray-500 dark:text-gray-400">
                    {geom == null ? 'No readable distribution to draw' : ''}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* ⚠ NO COST BLOCK ON A UNIT CARD, AND NOT BECAUSE THE PRICE IS MISSING. A unit is one
          (repository, vendor) pair and the price is per WORKSPACE, so any figure here was the whole
          subscription measured against one repository's work — an upper bound that shipped once per
          repository under a "do not add these up" caveat. Money is stated once per vendor on the
          rollup card instead; `cost` is no longer on `BotBenchmarkPlacementUnit` and the server
          sends no cost figure at all on a repo-narrowed request, so there is nothing here to render
          even if a future edit went looking. THE COMPONENT IS GONE, not merely unmounted — an
          unmounted renderer for a removed field is an invitation. */}
    </Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The Workspace rollup — one card per VENDOR
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * WHAT THIS VENDOR COSTS PER UNIT OF WORK, AT THE GRAIN THE PRICE IS BOUGHT AT.
 *
 * ⚠ THIS COMPONENT IS NEVER MOUNTED WITHOUT A PRICE. `rollup.cost` is ABSENT when nobody priced
 * this reviewer in this Workspace — not empty, not zero — so the caller's presence check is the
 * only thing between an unpriced reviewer and a confident US$0.00. TWO other states are DIFFERENT
 * and both render: a stored price of exactly 0 is real and reads as "recorded as free", and a
 * `monthlyUsd` of `null` is a price somebody ENTERED that could not be multiplied out of a per-seat
 * unit, which the card says out loud rather than going silent.
 *
 * ⚠ EVERY FIGURE IS A RATE AT TODAY'S PRICE, NEVER A SPEND OVER A PERIOD. The observation spans on
 * this card measure the WORK; they carry no money, and no sentence here may imply a subscription was
 * prorated across them.
 *
 * ⚠ NOTHING HERE COMPUTES A COST — the panel's standing rule. Every figure, sum, gap and expected
 * count is the server's; this file positions marks and picks words.
 *
 * ⚠ IT TAKES THE EXPECTATION AS A SECOND ARGUMENT because at THIS grain the counterfactual is a
 * SIBLING of the cost rather than an arm inside it: a vendor the corpus has never measured — Sonar,
 * GHAS, `github-actions`, most of a real estate — still gets its money while only the comparison
 * refuses. The "At the peer median rate" row and the headline's second sentence both read from it,
 * and both go quiet when it withheld its money halves.
 */
function WorkspaceCostBlock({
  cost,
  expectation,
}: {
  cost: BotBenchmarkWorkspaceCost;
  expectation: BotBenchmarkRollupExpectation;
}): JSX.Element {
  const headline = workspaceCostHeadline(cost, expectation);
  const collapsed = collapsedWorkspaceCostRefusal(cost);
  const coverage = workspaceCostCoverageNote(cost);
  const summed = costPricedReviewersNote(cost);
  const seatNote = costSeatUnresolvedNote(cost);
  const seatZeroNote = costSeatZeroNote(cost);
  const spanUnobserved = workspaceCostSpanUnobservedNote(cost);
  const partialWindow = workspaceCostPartialWindowNote(cost);
  const windowIncomplete = workspaceCostWindowIncompleteNote(cost);

  return (
    <div
      className="mt-2 rounded border border-gray-200 bg-gray-50/60 px-2.5 py-2 dark:border-gray-800 dark:bg-gray-900/30"
      data-testid="benchmark-workspace-cost"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-700 dark:text-gray-200">
          <CoinIcon size={12} className="text-gray-400" />
          Cost
        </span>
        <span className="text-[11px] tabular-nums text-gray-600 dark:text-gray-300">
          {workspaceCostPriceLine(cost)}
        </span>
        <BasisChip basis="stored" />
      </div>

      {/* ⚠ THE ONE HONEST CAVEAT THAT SURVIVED THE GRAIN CHANGE, and it is UNCONDITIONAL. The price
          and the work now describe the same repositories, so there is nothing left to add up — but
          a subscription may also cover repositories OUTSIDE this Workspace, which this app cannot
          see. In that one direction the figure is still an upper bound, and dropping the sentence
          because the big error was fixed would leave the small one unstated. ⚠ The ONE exception is
          a price that could not be STATED: this sentence points at a figure, and there is none. */}
      {cost.monthlyUsd != null && (
        <p
          className="mt-1 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400"
          data-testid="benchmark-workspace-cost-coverage"
        >
          {coverage}
        </p>
      )}
      {summed != null && (
        <p className="mt-0.5 text-[10px] leading-relaxed text-gray-400">{summed}</p>
      )}
      {seatNote != null && (
        <p
          className="mt-0.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400"
          data-testid="benchmark-cost-seat-unresolved"
        >
          {seatNote}
        </p>
      )}
      {/* ⚠ ITS OWN LINE AND ITS OWN TESTID. A seat count this build could not READ and a seat count
          that is genuinely ZERO have different remedies, and a per-seat price silently multiplied
          by 0 is what put "Recorded as free" on a reviewer somebody priced. */}
      {seatZeroNote != null && (
        <p
          className="mt-0.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400"
          data-testid="benchmark-cost-seat-zero"
        >
          {seatZeroNote}
        </p>
      )}

      {collapsed != null ? (
        // ⚠ ONE SENTENCE, NOT THREE. A price of 0 (or an estate that merged nothing, or a truncated
        // request) refuses every derived figure for the SAME reason, and three identical dimmed rows
        // read as three separate measurements that each came back empty.
        <div className="mt-1.5">
          <RefusalNote
            testId={`benchmark-workspace-cost-collapsed-${collapsed}`}
            headline={COST_REFUSAL_HEADLINE[collapsed]}
            message={
              (cost.perMergedPr.status === 'refused' ? cost.perMergedPr.message : '') +
              ' Every figure this price would produce is withheld for the same reason, so this is ' +
              'one refusal rather than three measurements that each came back empty.'
            }
          />
        </div>
      ) : (
        <div className="mt-1 divide-y divide-gray-200/70 dark:divide-gray-800/70">
          {/* ⚠ NO WINDOW SUFFIX ON A RATIO. "US$5.52 per 14 days" reads as $/PR/fortnight and
              invites the reader to double it for a month, but a cost per merged pull request does
              not scale with the window at all — both halves of the fraction scale together. The
              basis belongs in the detail, as prose. That shipped on both ratio rows. */}
          {cost.perMergedPr.status === 'value' ? (
            <CostValueRow
              testId="benchmark-workspace-cost-per-merged-pr"
              label="Per merged PR"
              figure={formatUsd(cost.perMergedPr.value)}
              detail={
                `over ${formatCount(cost.perMergedPr.mergedPrs)} merged across the estate in the ` +
                `last ${formatCount(cost.windowDays)} days`
              }
              basis="counted"
            />
          ) : (
            <CostRefusedRow label="Per merged PR" refusal={cost.perMergedPr} />
          )}

          {/* ⚠ THE ONE FIGURE ON THIS CARD A READER IS INVITED TO CHECK. Label names the window,
              detail names the two numbers, figure is their quotient — `US$783.00 ÷ 243 = US$3.22`.
              The version this replaced printed "255 of 544 threads acted on across 1 repository —
              about 32.7 a month" beside US$23.94, where 32.7 came from dividing by a 237-day span
              that appeared nowhere on the card and was never chosen. Nothing here computes: both
              halves and the quotient are the server's. */}
          {cost.yours.status === 'value' ? (
            <CostValueRow
              testId="benchmark-workspace-cost-per-acted-on"
              label={workspaceCostActedOnLabel(cost)}
              figure={formatUsd(cost.yours.perActedOnUsd)}
              detail={workspaceCostActedOnDetail(cost, cost.yours)}
              basis="counted"
            />
          ) : (
            <CostRefusedRow label={workspaceCostActedOnLabel(cost)} refusal={cost.yours} />
          )}

          <AtPeerEngagementRow expectation={expectation} />
        </div>
      )}

      {/* ⚠ THE HEADLINE IS A FIGURE, NOT A FINDING, so it does NOT borrow the amber chrome the
          anomaly cards use — those cleared a share gate, a magnitude gate and the cohort's own
          median CI. This one is arithmetic and says so.

          ⚠ AND IT IS TWO PARAGRAPHS, NEVER ONE. The MEASURED figure and the COUNTERFACTUAL gap are
          different quantities that differ by a factor of the cohort's rate, AND THEY ARE QUOTED
          OVER DIFFERENT POPULATIONS — the first over every live repository, the second over the
          fitted subset alone. They are two fields on the model and two elements here, so a renderer
          cannot reunite them by accident. */}
      {headline != null && (
        <div
          className="mt-1.5 space-y-1 border-t border-gray-200 pt-1.5 text-[12px] leading-relaxed text-gray-700 dark:border-gray-800 dark:text-gray-200"
          data-testid={`benchmark-workspace-cost-headline-${headline.tone}`}
        >
          <p data-testid="benchmark-workspace-cost-headline-spend">{headline.spend}</p>
          {headline.comparison != null && (
            <p
              className="text-gray-500 dark:text-gray-400"
              data-testid="benchmark-workspace-cost-headline-comparison"
            >
              {headline.comparison}
            </p>
          )}
        </div>
      )}

      {/* THE BASIS, server-authored so it cannot be dropped by a renderer that did not know it
          existed — one sentence naming the two numbers the per-thread figure divides.

          ⚠ IT RIDES THE MONEY, NOT A SPAN. Its predecessor was gated on whether a span-anchored
          figure was on screen; there are no span-anchored figures left, and the sentence a reader
          uses to check the arithmetic must be there whenever the arithmetic is. */}
      {collapsed == null && (
        <p className="mt-1 text-[10px] leading-relaxed text-gray-400">{cost.basisNote}</p>
      )}

      {/* ⚠ TWO DISCLOSURES WITH TWO CAUSES AND TWO SENTENCES, and neither is optional chrome: a
          repository whose span could not be read contributed nothing to the pace above (so the pace
          understates), and a repository the host has held for less than the window is left out of
          the per-merged-PR denominator alone (so leaving it in would inflate that figure, silently
          and in the flattering direction). A missing disclosure is the same defect as a wrong
          number, one line quieter. */}
      {spanUnobserved != null && (
        <p
          className="mt-0.5 text-[10px] leading-relaxed text-gray-400"
          data-testid="benchmark-workspace-cost-span-unobserved"
        >
          {spanUnobserved}
        </p>
      )}
      {partialWindow != null && (
        <p
          className="mt-0.5 text-[10px] leading-relaxed text-gray-400"
          data-testid="benchmark-workspace-cost-partial-window"
        >
          {partialWindow}
        </p>
      )}
      {/* ⚠ A THIRD CAUSE AND A THIRD SENTENCE — and the only one that explains a WITHHELD figure
          rather than a missing term. A repository younger than the cost window makes the month of
          work partial against a whole price, which inflates; the figure refuses and this says why
          and for how long. */}
      {windowIncomplete != null && (
        <p
          className="mt-0.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-400"
          data-testid="benchmark-workspace-cost-window-incomplete"
        >
          {windowIncomplete}
        </p>
      )}
    </div>
  );
}

/**
 * The counterfactual row — your threads, your price, each repository's OWN cohort median.
 *
 * ⚠ ONE FACTOR IS SWAPPED, NEVER TWO, and the row's words say which one. The thread counts and the
 * price stay the customer's; only the rate comes from the corpus, and it comes from each
 * repository's own cell rather than from a single blended median.
 *
 * ⚠ IT DRAWS NOTHING WHEN THE EXPECTATION ITSELF REFUSED, and that is the "one sentence, not three"
 * rule crossing a section boundary. A refused expectation is stated ONCE, in full and in the
 * server's own words, in the expectation section further down this card; a dimmed row up here
 * carrying the same headline would read as a second measurement that also came back empty. The row
 * DOES render a refusal when the expectation stands and only its MONEY halves went quiet — that is
 * a COST reason, it is the same object the arms above are refusing with, and nothing else on the
 * card would otherwise account for it.
 */
function AtPeerEngagementRow({
  expectation,
}: {
  expectation: BotBenchmarkRollupExpectation;
}): JSX.Element | null {
  // ⚠ THE LABEL STATES THE HYPOTHETICAL, NOT THE STATISTIC. Two earlier attempts named the
  // machinery — "At peer engagement", then "At the peer median rate" — and a reader reported that
  // neither told them what was being compared. Both were accurate and both described a swap only
  // someone who had read the fold could picture.
  //
  // ⚠ AND IT IS NOT "WHAT PEERS PAY". We do not know what any other team pays; nobody tells us.
  // The only thing swapped is the RATE: your own price and your own thread counts, re-divided by
  // how many of those comments your team WOULD have used at the rate similar teams manage. So the
  // sentence has to be conditional and has to stay in the second person — "if your team used it as
  // much" — because the moment it reads as "peers spend US$2.47" it is a claim about other
  // people's invoices that this feature cannot make.
  //
  // ⚠ STILL THE CARD'S ONE NOUN FOR THIS FACT: the two refusals that stand IN PLACE of this row
  // ("We have no typical team to compare with") and the headline's `ahead` branch describe the
  // same comparison, because two wordings for one fact on one card is how a reader stops believing
  // either.
  const label = 'If your team used it as much';
  if (expectation.status !== 'value') return null;
  if (expectation.perActedOnUsd != null && expectation.actedPerMonthAtPeer != null) {
    return (
      <CostValueRow
        testId="benchmark-workspace-cost-counterfactual"
        label={label}
        figure={formatUsd(expectation.perActedOnUsd)}
        detail={
          `your price, divided by the roughly ` +
          `${formatThreadCount(expectation.actedPerMonthAtPeer)} comments a month your team would ` +
          `have used if it used this bot as much as teams with similar repos do`
        }
        basis="fitted"
      />
    );
  }
  if (expectation.moneyRefusal != null) {
    return <CostRefusedRow label={label} refusal={expectation.moneyRefusal} />;
  }
  // ⚠ NO ROW RATHER THAN AN EMPTY ONE. `moneyRefusal === null` with the figures absent means the
  // card carries no price at all — and this component only renders inside a cost block, so it is
  // unreachable here. Drawing a dimmed placeholder for it would assert a measurement nobody made.
  return null;
}

/** ⚠ THE FOUR COUNTER MAPS IN A FIXED ORDER, so two cards on one screen never disagree about how a
 *  reviewer's numbers are laid out. Iterating `Object.entries(counters)` would take the order off
 *  the wire, which is stable today and is not a promise. */
const COUNTER_GROUPS: readonly (keyof BotBenchmarkPlacementCounters)[] = [
  'volume',
  'outcome',
  'overdueEligible',
  'overdueUntouched',
  'repository',
];

/**
 * ⚠ EVERY GROUP NAMES ITS POPULATION, BECAUSE TWO OF THEM SHARE A KEY AND DISAGREE.
 *
 * `volume.commentsObserved` and `outcome.commentsObserved` are different numbers — 22 and 53 for one
 * real reviewer — because the fitter's two populations are different: VOLUME is merged, human-
 * authored, detail-observed pull requests (merged, because an open PR is still accumulating comments
 * and averaging it in understates every vendor); OUTCOME is the same set MERGED OR NOT (conditioning
 * a thread outcome on the merge would select on the dependent variable). Printed under bare headings
 * the two read as a contradiction — as does "Threads 18" beside "Threads settled 38" — and a reader
 * who spots an apparent contradiction stops believing the rest of the card. The populations are the
 * corpus's own, quoted from `populations` in the artifact.
 */
const COUNTER_GROUP_LABEL: Record<
  keyof BotBenchmarkPlacementCounters,
  { label: string; population: string }
> = {
  volume: { label: 'Volume', population: 'merged PRs only' },
  outcome: { label: 'Thread outcomes', population: 'merged or not' },
  overdueEligible: { label: 'Eligible to go overdue', population: 'by grace' },
  overdueUntouched: { label: 'Still untouched past grace', population: 'by grace' },
  repository: { label: 'Repository disclosure', population: 'what was read' },
};

/** ⚠ REDUNDANT PREFIXES THE GROUP HEADING ALREADY CARRIES. Nine of the thirteen outcome keys begin
 *  "threads", and four of those "threadsSettled" — printing them in full gave a column of
 *  "Threads settled complete acted outdated", which is unscannable and pushed the value an inch
 *  away from its label. Stripping is per GROUP, never global: `volume.threads` keeps its name
 *  because there is nothing above it to supply the word. */
const COUNTER_KEY_PREFIX: Partial<Record<keyof BotBenchmarkPlacementCounters, RegExp>> = {
  outcome: /^threads(?=[A-Z])/,
};

/** ⚠ A PRESENTATION FACT ONLY — how to print a key the FITTER named, so a new counter needs no wire
 *  edit and no edit here. The two overdue maps are keyed by grace HOURS rather than by a name. */
function counterLabel(key: string, group?: keyof BotBenchmarkPlacementCounters): string {
  if (/^\d+$/.test(key)) return `${key} h`;
  const prefix = group != null ? COUNTER_KEY_PREFIX[group] : undefined;
  // Strip only when something survives it — `outcome.threadsSettled` itself must stay "Settled",
  // and a hypothetical bare `threads` key must not become the empty string.
  const stripped = prefix != null ? key.replace(prefix, '') : key;
  const base = stripped.length > 0 ? stripped : key;
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  const sentence = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  // ⚠ THE ONE ACRONYM THE FITTER'S camelCase DESTROYS. `prsWithFinding` sentence-cases to "Prs with
  // finding", which reads as a typo of a word rather than as "pull requests" — and this block is
  // the audit trail, where looking sloppy costs it the trust it exists to earn. Applied to the
  // rendered LABEL only; the wire key is the fitter's and is never rewritten.
  return sentence.replace(/\bPrs\b/g, 'PRs');
}

/**
 * THE POOLED COUNTERS — plain sums over the repositories this vendor is live in.
 *
 * ⚠ PUBLISHED IN FULL, NOT SUMMARISED, AND THAT IS THE POINT. The additivity invariant is that the
 * whole equals the sum of the parts for EVERY key; a curated shortlist would make the card's own
 * arithmetic uncheckable against the evidence table underneath it. Nothing in here is a rate, so
 * nothing in here needs a denominator to be honest — which is exactly why the RATES on this card
 * live elsewhere, each beside the population it was computed over.
 */
function PooledCounters({ counters }: { counters: BotBenchmarkPlacementCounters }): JSX.Element {
  // ⚠ FOLDED BY DEFAULT, AND LAST ON THE CARD — a deliberate demotion, not a hiding. Twenty-five
  // raw fitter counters were the FIRST thing on every card, above the price and the comparison,
  // so the card led with its workings and buried its answer. They stay in full (the additivity
  // invariant is only checkable against a complete list) and one click away, which is what an
  // audit trail needs to be.
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2" data-testid="benchmark-rollup-counters">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="benchmark-rollup-counters-toggle"
        className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} />
        <ThreadsIcon size={12} className="text-gray-400" />
        The raw counts behind every figure on this card
      </button>
      {/* ⚠ THE VALUE SITS AGAINST ITS OWN LABEL, NOT AT THE FAR EDGE OF THE CARD. The first cut was
          `justify-between` inside a half-width column, which on a wide rail put ~650px of empty
          space between "Threads settled complete acted" and the number it names — a reader had to
          track across the card per row, twenty-five times. Pairs wrap instead: adjacency beats
          decimal alignment here because nothing in this block is compared DOWN a column (they are
          different quantities), only read one at a time. */}
      {!open ? null : (
        <div className="mt-1 flex flex-col gap-1.5">
        {COUNTER_GROUPS.map((group) => {
          const entries = Object.entries(counters[group]);
          if (entries.length === 0) return null;
          const meta = COUNTER_GROUP_LABEL[group];
          return (
            <div key={group}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                {meta.label}{' '}
                <span className="font-normal normal-case tracking-normal text-gray-400/80">
                  · {meta.population}
                </span>
              </div>
              <dl className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                {entries.map(([key, value]) => (
                  <div key={key} className="flex items-baseline gap-1">
                    <dt className="text-[10px] text-gray-500 dark:text-gray-400">
                      {counterLabel(key, group)}
                    </dt>
                    <dd className="text-[10px] font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                      {formatCount(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

/**
 * THE EVIDENCE TABLE — one row per repository this vendor is live in.
 *
 * ⚠ THE AUDIT TRAIL FOR EVERY SUM ON THE CARD. A reader who doubts a total can find the repository
 * responsible for it without leaving the card, and a card whose spread says "3 of 5 above the
 * median" while the table lists four repositories is caught on sight — which is why it ships beside
 * the numbers rather than behind a link.
 *
 * ⚠ EVERY `—` MEANS WITHHELD AND NEVER ZERO, and a REFUSED PLACEMENT KEEPS ITS ROW with its reason
 * where the band would be. The repository is live, it contributed counts, and it is part of the
 * estate the money is divided by; dropping it would make the table disagree with the card's own
 * coverage. Both rules are enforced in `contributionRows`, so this component holds no arithmetic.
 */
function EvidenceTable({
  rows,
  statedRefusal,
}: {
  rows: ReturnType<typeof contributionRows>;
  /** The card-level comparison refusal, when one note already covers both sections. Rows whose own
   *  refusal is that same VENDOR-WIDE fact then show `—` instead of restating it. */
  statedRefusal: BotBenchmarkRollupRefusalReason | null;
}): JSX.Element {
  return (
    <div className="mt-2" data-testid="benchmark-rollup-evidence">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-700 dark:text-gray-200">
        <WorkspaceIcon size={12} className="text-gray-400" />
        Where these numbers come from
      </div>
      {/* ⚠ THE TABLE SCROLLS INSIDE ITS OWN BOX. The panel's body must never scroll horizontally —
          the rail is a narrow column on a laptop and five columns do not fit it. */}
      <div className="mt-1 overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wide text-gray-400 dark:border-gray-800">
              <th scope="col" className="py-1 pr-3 font-semibold">
                Repository
              </th>
              <th scope="col" className="py-1 pr-3 font-semibold">
                Size group
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-semibold">
                Merged PRs, 14 days
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-semibold">
                Acted on
              </th>
              <th scope="col" className="py-1 text-right font-semibold">
                Rank in its group
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800/70">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="py-1 pr-3 text-gray-700 dark:text-gray-200">{row.repo}</td>
                <td className="py-1 pr-3 text-gray-500 dark:text-gray-400">
                  {!row.bandRefused ? (
                    <span className="tabular-nums">{row.band}</span>
                  ) : statedRefusal != null && row.refusalIsVendorWide ? (
                    <span className="text-gray-400">—</span>
                  ) : (
                    <span className="text-gray-400">
                      <ThinSampleIcon className="mr-1 inline-block align-[-0.05em]" />
                      {row.band}
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-gray-600 dark:text-gray-300">
                  {row.mergedPrs}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-gray-600 dark:text-gray-300">
                  {row.actedOn}
                </td>
                <td className="py-1 text-right tabular-nums text-gray-600 dark:text-gray-300">
                  {row.percentile}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-gray-400">
        A dash means this repo had too little to measure — never that the answer was zero. Its
        counts are still included in the totals above. Each rank is against other repos of that
        repo’s own size, so the ranks in this column are not comparable with each other.
      </p>
    </div>
  );
}

/**
 * ONE VENDOR, ONE CARD, THE WHOLE WORKSPACE.
 *
 * ⚠ THE REACT KEY IS THE WORKSPACE'S VENDOR KEY, NEVER `repoId:vendor`. A rollup card has n
 * repositories and would collide with itself on the unit card's key; and it cannot key on `vendor`
 * either, which is `null` for every brand the corpus has never seen — most of the reviewers a real
 * workspace runs — so n unbranded vendors would collapse onto one card. `rollupRows` resolves the
 * key, the title, the label and the colour once, so no renderer re-derives any of them.
 *
 * ⚠ THE CARD COMPUTES A PERCENTILE NOWHERE, because there is no distribution of workspaces. The
 * ranks on it are the per-repository ones, in the evidence table, each against its own band.
 */
function RollupCard({ row }: { row: RollupRow }): JSX.Element {
  const { rollup } = row;
  const contributions = useMemo(
    () => contributionRows(rollup.contributions),
    [rollup.contributions],
  );
  const spread = rollupSpreadSentence(rollup.spread);
  const expectation = rollupExpectationSentence(rollup.expectation);
  const shared = sharedComparisonRefusal(rollup.spread, rollup.expectation);

  return (
    <Card>
      {/* The unit card's header grammar, one grain up: the reviewer is the identity here, and the
          repositories are the evidence. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1" title={row.title}>
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
          style={row.color != null ? { color: row.color, background: `${row.color}1a` } : undefined}
        >
          <BotIcon size={12} />
          {/* ⚠ THE REVIEWER IS NAMED EVEN WHEN THE COHORT REFUSES IT. A bot the corpus has never
              seen is still this workspace's biggest reviewer, and it must not read as a zero. */}
          {row.label}
        </span>
        {/* ⚠ BOTH NUMBERS, ALWAYS — "live in 4 of 8 repositories". `liveInRepos` alone is an
            unanchored count, and it is the denominator every sum on this card runs over. */}
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{row.coverage}</span>
        {/* The logins folded into this one card — two accounts the workspace classifies as one
            vendor are ONE card, which is the corpus's own semantics. */}
        {rollup.reviewers.length > 0 && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {rollup.reviewers.map((r) => r.login).join(', ')}
          </span>
        )}
      </div>

      {/* ⚠ ABSENT, NEVER A US$0.00. `cost` is missing exactly when nobody priced this reviewer in
          this Workspace, and this presence check is the whole of the difference between saying
          nothing and asserting that the reviewer is free. */}
      {rollup.cost != null && (
        <WorkspaceCostBlock cost={rollup.cost} expectation={rollup.expectation} />
      )}

      {/* ⚠ A SHAPE, NEVER A TOTAL, and its denominator is the PLACED subset rather than the card's
          coverage — the sentence says which. Averaging n percentiles is the obvious alternative and
          is meaningless twice over: they come from different cohorts, and a mean of ranks is not
          the rank of anything. */}
      {spread != null && (
        <div
          className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-gray-600 dark:text-gray-300"
          data-testid="benchmark-rollup-spread"
        >
          <ScalesIcon className="mt-0.5 shrink-0 text-gray-400" />
          <p>{spread}</p>
        </div>
      )}
      {/* ⚠ ONE NOTE WHEN ONE REASON DISQUALIFIES BOTH — see `sharedComparisonRefusal`. This card
          shipped printing the identical `vendor_not_in_corpus` paragraph twice in a row, which is
          the commonest case of all: most reviewers a real workspace runs are not in the corpus. */}
      {shared != null ? (
        <div className="mt-2">
          <RefusalNote
            testId={`benchmark-rollup-comparisons-refused-${shared.reason}`}
            headline={ROLLUP_REFUSAL_HEADLINE[shared.reason]}
            message={shared.message}
          />
        </div>
      ) : (
        rollup.spread.status === 'refused' && (
          <div className="mt-2">
            <RefusalNote
              testId={`benchmark-rollup-spread-refused-${rollup.spread.reason}`}
              headline={ROLLUP_REFUSAL_HEADLINE[rollup.spread.reason]}
              message={rollup.spread.message}
            />
          </div>
        )
      )}

      {/* ⚠⚠ THE ONE SENTENCE ON THIS CARD CARRYING TWO RATES, AND IT NAMES ITS POPULATION TWICE.
          `expectedRate` exists only where a cohort published a median, so the customer's rate it is
          set against is computed over that SAME fitted subset — never the pooled headline rate the
          cost block quotes. Both are on the wire, with both repository counts, precisely so this
          renderer is physically able to label them apart. Mixing them in one row is the defect
          docs/PERIOD-REPORTING.md names "ONE ROW MUST NEVER MIX THE HEADLINE AND SUBSET
          POPULATIONS", shipped three times in that feature before it was believed. */}
      {expectation != null && (
        <div
          className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-gray-600 dark:text-gray-300"
          data-testid="benchmark-rollup-expectation"
        >
          <ChartIcon size={13} className="mt-0.5 shrink-0 text-gray-400" />
          <p>{expectation}</p>
        </div>
      )}
      {shared == null && rollup.expectation.status === 'refused' && (
        <div className="mt-2">
          <RefusalNote
            testId={`benchmark-rollup-expectation-refused-${rollup.expectation.reason}`}
            headline={ROLLUP_REFUSAL_HEADLINE[rollup.expectation.reason]}
            message={rollup.expectation.message}
          />
        </div>
      )}

      {/* ⚠ THE BAND COLUMN GOES SILENT WHEN THE NOTE ABOVE ALREADY SAID IT. A two-repository card
          otherwise printed "We have never measured this reviewer" four times — twice as notes and
          once per row. Rows whose refusal DIFFERS from the shared one still name it, because that
          is a fact the card has not stated anywhere else. */}
      <EvidenceTable rows={contributions} statedRefusal={shared?.reason ?? null} />

      <PooledCounters counters={rollup.counters} />
    </Card>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The definitions disclosure — CLICK-GATED
   ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠ THE CORPUS'S COLUMNS ARE NOT THIS APP'S COLUMNS OF THE SAME NAME, and this is where that is
 * said. `getBotAnalytics`' acted-on rate folds the `likely_addressed` COMMIT HEURISTIC into its
 * numerator and divides by every in-window thread; the corpus's `acted_on_rate` divides by SETTLED,
 * fully-read threads. Six of the thirteen have no app counterpart at all. The definitions are
 * SERVED (`metricSpecs`, shipped in full on the cohort route) rather than re-typed here, and the
 * fetch does not happen until this is opened.
 */
function MeasuredDisclosure(): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useBotBenchmarkSpecs(open);
  const specs = data?.manifest?.metricSpecs ?? [];
  const populations = data?.manifest?.populations ?? {};
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="benchmark-specs-toggle"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900/60"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} />
        How these are measured
        <span className="font-normal text-gray-400">
          — the peer corpus counts these differently from this app’s own bot columns
        </span>
      </button>
      {open && (
        <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-800">
          {isLoading && <SkeletonBlock className="h-16" />}
          {!isLoading && specs.length === 0 && (
            <p className="text-[11px] text-gray-400">
              No metric definitions are available in this build.
            </p>
          )}
          {specs.length > 0 && (
            <dl className="space-y-2">
              {specs.map((s) => (
                <div key={s.name}>
                  <dt className="text-[11px] font-medium text-gray-700 dark:text-gray-200">
                    {metricLabel(s.name)}{' '}
                    <span className="font-normal text-gray-400">
                      {DERIVATION_LABEL[s.derivation]} · {DIRECTION_LABEL[s.direction]} · needs at
                      least {formatCount(s.minUnits)}
                    </span>
                  </dt>
                  <dd className="text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">
                    {s.definition}
                    <br />
                    <span className="text-gray-400">
                      {s.numerator} ÷ {s.denominator} · over {populations[s.population] ?? s.population}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   The panel
   ───────────────────────────────────────────────────────────────────────────────────────── */

export function BenchmarkPanel({ repoId }: { repoId?: number } = {}): JSX.Element {
  const workspaceId = useFilters((s) => s.workspaceId);
  // The per-repo console's Bots tab narrows the DATA to one repository; the cross-repo rail covers
  // the whole workspace. `repoIds` is data narrowing only — the server intersects it with the
  // workspace's membership, so it can never reach outside the scope.
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const { data, isLoading, isError } = useBotBenchmarkPlacement(workspaceId, repoScope);
  // ONE ResizeObserver for the whole panel, measured once and handed down: every strip sits in the
  // same column, so a per-row observer would be n observers for one width.
  const [wrapRef, width] = useChartWidth();

  return (
    <div className="space-y-3" ref={wrapRef} data-testid="benchmark-panel">
      {/* ⚠ THE GRAIN IS DECIDED BY THE PROP, NOT BY THE PAYLOAD. `repoId == null` is the rail and
          draws the vendor rollups; anything else is a repository's own Bots tab and draws that
          repository's placements. Branching on `data.rollup != null` instead would let a version
          skew silently change which screen the reader is looking at. */}
      <Body
        data={data}
        isLoading={isLoading}
        isError={isError}
        width={width}
        isRail={repoId == null}
      />
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
  width,
  isRail,
}: {
  data: BotBenchmarkPlacementResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  width: number;
  isRail: boolean;
}): JSX.Element {
  const units = useMemo(() => orderedUnits(data?.units ?? []), [data?.units]);
  const tally = useMemo(() => placementTally(units), [units]);
  const absent = useMemo(() => absentMetricRows(data?.absentMetrics), [data?.absentMetrics]);
  const rollups = useMemo(() => rollupRows(data?.rollup ?? []), [data?.rollup]);

  if (isLoading) return <SkeletonBlock className="h-40" />;
  if (isError || data == null) {
    return (
      <Card>
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          Could not load the peer benchmark for this Workspace.
        </p>
      </Card>
    );
  }

  // ⚠ ONE BANNER, NOT n IDENTICAL PARAGRAPHS, and a DIFFERENT SENTENCE from "there isn't enough
  // peer data yet". This is a build-configuration fact: an OSS checkout, or an image whose corpus
  // copy step was forgotten.
  if (!data.available) {
    return (
      <RefusalNote
        testId="benchmark-unavailable"
        headline={
          data.reason != null
            ? UNAVAILABLE_HEADLINE[data.reason]
            : 'No comparison data is available'
        }
        message={
          data.message ??
          'This tab compares each of your review bots against the same bot running in other ' +
            'teams’ repositories of a similar size. That comparison data is not available in ' +
            'this build.'
        }
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-600 dark:text-gray-300">
        <span className="inline-flex items-center gap-1">
          <ChartIcon size={12} />
          Every bot here is compared with the same bot running in other teams’ repos of a similar
          size.
        </span>
        {data.staleness != null && (
          <span title={`The newest measurement in the comparison data is ${Math.round(data.staleness.corpusAgeDays)} days old.`}>
            {STALENESS_LABEL[data.staleness.state]} ·{' '}
            {Math.round(data.staleness.corpusAgeDays)} days old
          </span>
        )}
        {data.fitKey != null && data.fitKey !== '' && (
          <span className="font-mono">{data.fitKey}</span>
        )}
      </div>

      {/* ⚠ NEVER A SILENT TRUNCATION. The omitted repositories are not "no data".
          ⚠ AND THE REMEDY IS ONLY OFFERED WHERE IT IS ONE. "Open a repository's own Bots tab" is
          advice on the rail and a no-op on that very tab, where it shipped unconditionally; on the
          rail it also has to say what truncation costs, which is the MONEY — a whole price divided
          by a partial estate is wrong in the inflating direction, so the rollups below withhold it
          while their counters and spreads, which are honest sums over a stated subset, still
          render. */}
      {data.truncated === true && (
        <RefusalNote
          testId="benchmark-truncated"
          headline="More repositories than one request folds"
          message={
            'This Workspace holds more (repository × reviewer) pairs than one request may measure, ' +
            'so only the first are shown. The rest are not “no data”' +
            (isRail
              ? ': every card below sums a partial estate, so its counters and its spread still ' +
                'read as sums over the repositories named on it, while its money is withheld — a ' +
                'whole subscription over part of the work is not an approximation of the answer. ' +
                'Open a repository’s own Bots tab to place it on its own.'
              : '.')
          }
        />
      )}

      {units.length === 0 ? (
        // A THIRD distinct sentence: the corpus is here, the build is fine, and there is simply no
        // automated reviewer in this scope to place.
        <RefusalNote
          testId="benchmark-no-units"
          headline="No automated reviewer to place"
          message={
            'Nothing in this Workspace is classified as an automated reviewer with activity to ' +
            'measure. Bots → Settings is where a reviewer is classified; a bot classified there ' +
            'appears here once it has commented.'
          }
        />
      ) : (
        <>
          {/* ⚠ THE ANOMALY LIST LEADS ON BOTH SCREENS. A finding is per (repository × reviewer) and
              stays that way — it is the one thing on the rail that names a repository, because
              "acted on far less of this reviewer than its peers" is a work item somebody has to do
              IN a repository. Folding findings up to the vendor would turn n actionable rows into
              one unactionable average. */}
          <FindingsSection units={units} tally={tally} />
          {isRail ? (
            rollups.length > 0 ? (
              <div className="space-y-2">
                {rollups.map((row) => (
                  <RollupCard key={row.key} row={row} />
                ))}
              </div>
            ) : data.rollup == null ? (
              // ⚠ A SENTENCE RATHER THAN A BLANK. The rollup is OPTIONAL on the wire, so a host
              // running an older plugin serves units with no rollup — and the rail deliberately
              // draws no per-repository cards, which would otherwise leave the reader with a
              // findings list and nothing under it.
              <RefusalNote
                testId="benchmark-no-rollup"
                headline="No Workspace rollup is being served"
                message={
                  'This build served the per-repository placements but no per-vendor rollup, which ' +
                  'is what this view is made of. A repository’s own Bots tab still shows its ' +
                  'placements, and nothing here is a statement about your reviewers.'
                }
              />
            ) : (
              // ⚠⚠ ABSENT AND EMPTY ARE TWO DIFFERENT FACTS AND THEY GET TWO DIFFERENT SENTENCES.
              // The server is deliberate about the distinction — a MISSING `rollup` key says the
              // fold did not run, `[]` says it ran and dropped every card because no reviewer was
              // live anywhere — and the route has a test pinning each. Collapsing them with a
              // `?? []` told a reader whose bots simply had not commented yet that their BUILD was
              // deficient, sending them to chase a deployment problem that does not exist. This is
              // the ordinary state right after somebody classifies a reviewer in Bots → Settings.
              // ⚠ THE HEADLINE IS SCOPED TO WHAT WAS READ, AND THAT IS NOT PEDANTRY. The first
              // wording — "No reviewer has been active in this Workspace yet" — is FALSE of a
              // workspace whose bots are merely quiet in the sampled window: one real workspace
              // showing this note has 906 comments from one reviewer across four repositories and
              // 369 from another. The body sentence was correctly qualified ("in the pull requests
              // read here") while the headline made the unqualified claim, and the headline is the
              // half that gets read. The walk is capped at each repository's most recently updated
              // pull requests, so "we saw nothing" and "there is nothing" are genuinely different
              // statements and only the first is ours to make.
              <RefusalNote
                testId="benchmark-no-live-reviewers"
                headline="No reviewer commented on the pull requests we read"
                message={
                  'The rollup ran and found no automated reviewer that has commented in the pull ' +
                  'requests read here, so there is nothing to place, pool or price — every card ' +
                  'would be a column of zeros about a reviewer that has not been given the chance ' +
                  'to do anything. That is a statement about this sample, not about your ' +
                  'reviewers: the walk is capped at each repository’s most recently updated pull ' +
                  'requests, so a reviewer that is busy outside that window is absent here and ' +
                  'still working. A reviewer classified in Bots → Settings appears once it has ' +
                  'commented on a pull request in range; each repository’s own Bots tab says the ' +
                  'same thing per repository.'
                }
              />
            )
          ) : (
            <div className="space-y-2">
              {units.map((unit) => (
                <UnitCard key={`${unit.repoId}:${unit.vendor ?? unit.botKind ?? 'bot'}`} unit={unit} width={width} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ⚠ STRUCTURALLY ABSENT, NOT EMPTY AND NOT ZERO. Severity and category are MODEL-DERIVED and
          the corpus is unscored, so no cell holds these keys. The host already HAS these numbers —
          ML severity is a shipped free feature — which is exactly why the temptation is to render
          the customer's severity distribution against nothing. */}
      {absent.length > 0 && (
        <div
          className="rounded-lg border border-dashed border-gray-300 px-3 py-2 dark:border-gray-700"
          data-testid="benchmark-absent-metrics"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-600 dark:text-gray-300">
            <InfoIcon className="text-gray-400" />
            Not in this corpus yet
            <span className="rounded bg-gray-500/10 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
              {DERIVATION_LABEL.model}
            </span>
          </div>
          <ul className="mt-1 space-y-1">
            {absent.map((m) => (
              <li key={m.name} className="text-[12px] leading-relaxed text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-600 dark:text-gray-300">{m.label}</span> —{' '}
                {m.note}
                {Object.entries(m.requires).length > 0 && (
                  <span className="text-gray-400">
                    {' '}
                    ({Object.entries(m.requires)
                      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
                      .join('; ')})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <MeasuredDisclosure />

      {/* Caveats that are NOT refusals — every one is a limit of the comparison, disclosed rather
          than used to withhold it. Server-authored, rendered verbatim. */}
      {data.disclosures != null && data.disclosures.length > 0 && (
        <ul className="space-y-1 text-[10px] leading-relaxed text-gray-400">
          {data.disclosures.map((d) => (
            <li key={d}>· {d}</li>
          ))}
        </ul>
      )}
    </>
  );
}
