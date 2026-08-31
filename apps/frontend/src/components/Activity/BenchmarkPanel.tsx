import { useMemo, useState } from 'react';
import type {
  BotBenchmarkDirection,
  BotBenchmarkPlacementCost,
  BotBenchmarkPlacementResponse,
  BotBenchmarkPlacementUnit,
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
  WarningIcon,
} from '../Icons.js';
import {
  COST_BASIS_LABEL,
  COST_REFUSAL_HEADLINE,
  DERIVATION_LABEL,
  EXCLUSION_HEADLINE,
  FINDINGS_EMPTY_HEADLINE,
  PLACEMENT_REFUSAL_HEADLINE,
  STALENESS_LABEL,
  UNAVAILABLE_HEADLINE,
  absentMetricRows,
  anomalyRows,
  bandFitNote,
  collapsedCostRefusal,
  collapsedExclusion,
  costHeadline,
  costPriceLine,
  costPricedReviewersNote,
  costSeatUnresolvedNote,
  costSeatZeroNote,
  costSharedNote,
  findingsEmptyState,
  formatCount,
  formatMetricValue,
  formatSpanDays,
  formatThreadCount,
  formatUsd,
  metricLabel,
  metricRows,
  orderedUnits,
  percentileSentence,
  placementTally,
  reviewerColor,
  reviewerLabel,
  stripGeometry,
  unitTitle,
  type CostBasis,
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
      className="text-gray-300 dark:text-gray-600"
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
   Cost — what this reviewer costs per unit of the work it produces
   ───────────────────────────────────────────────────────────────────────────────────────── */

/** The small chip that says WHERE a row's number came from. ⚠ Three sources sit in this one block
 *  — a price a human typed, rates counted from this Workspace's rows, and an engagement rate FITTED
 *  from the peer corpus — and the counterfactual is the one that must never read as an invoice. */
function BasisChip({ basis }: { basis: CostBasis }): JSX.Element {
  return (
    <span
      className="rounded bg-gray-500/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-gray-500"
      data-testid={`benchmark-cost-basis-${basis}`}
    >
      {COST_BASIS_LABEL[basis]}
    </span>
  );
}

/** One refused cost figure, inline — the same grammar an excluded metric row uses. The server's
 *  own sentence rides the `title`; the headline is the scannable half. */
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

/**
 * What this reviewer costs per unit of the work it produces, and what better engagement with it
 * would be worth.
 *
 * ⚠ THIS COMPONENT IS NEVER MOUNTED WITHOUT A PRICE. `unit.cost` is ABSENT when no price is set for
 * this reviewer in this Workspace — not empty, not zero — so there is no placeholder, no "add a
 * price" prompt and no US$0.00 anywhere in the no-price case. TWO other states are DIFFERENT and
 * both render: a price of exactly 0 is real and shows as "recorded as free"; a `monthlyUsd` of
 * `null` is a price somebody ENTERED that could not be multiplied out of a per-seat unit, and the
 * card says exactly that rather than going silent. Both refuse every derived figure with a
 * sentence, rather than printing a row of zeros that reads as a broken panel.
 *
 * ⚠ EVERY REVIEWER-SIDE FIGURE IS A RATE AT THE CURRENT PRICE, NOT A SPEND. The span on this card
 * is the window the WORK was measured over; it carries no money, and no sentence here may imply a
 * subscription was prorated across it.
 *
 * ⚠ NOTHING HERE COMPUTES A COST. Every figure, gap and expected count is the server's — the same
 * rule the rest of this panel keeps. This file positions marks and picks words.
 */
function CostBlock({ cost }: { cost: BotBenchmarkPlacementCost }): JSX.Element {
  const headline = costHeadline(cost);
  const collapsed = collapsedCostRefusal(cost);
  const shared = costSharedNote(cost);
  const summed = costPricedReviewersNote(cost);
  const seatNote = costSeatUnresolvedNote(cost);
  const seatZeroNote = costSeatZeroNote(cost);
  // The span caveat rides any figure anchored on the span — which is every reviewer-side one.
  const showsSpan =
    cost.yours.status === 'value' ||
    cost.atPeerEngagement.status === 'value' ||
    cost.unacted.status === 'value';

  return (
    <div
      className="mt-2 rounded border border-gray-200 bg-gray-50/60 px-2.5 py-2 dark:border-gray-800 dark:bg-gray-900/30"
      data-testid="benchmark-cost"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-700 dark:text-gray-200">
          <CoinIcon size={12} className="text-gray-400" />
          Cost
        </span>
        <span className="text-[11px] tabular-nums text-gray-600 dark:text-gray-300">
          {costPriceLine(cost)}
        </span>
        <BasisChip basis="stored" />
      </div>

      {/* ⚠ THE PRICE IS PER WORKSPACE AND THIS CARD IS PER REPOSITORY. Said out loud UNCONDITIONALLY
          — the per-repository Bots tab narrows to one repository, so a caveat gated on "more than
          one card" would never appear on the screen that needs it most. ⚠ The ONE exception is a
          price that could not be STATED: this sentence points at a figure, and there is none. */}
      {cost.monthlyUsd != null && (
        <p
          className="mt-1 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400"
          data-testid="benchmark-cost-shared"
        >
          {shared}
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
        // ⚠ ONE SENTENCE, NOT THREE. A price of 0 (or a repository that merged nothing) refuses
        // every derived figure for the SAME reason, and three identical dimmed rows read as three
        // separate measurements that each came back empty.
        <div className="mt-1.5">
          <RefusalNote
            testId={`benchmark-cost-collapsed-${collapsed}`}
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
              testId="benchmark-cost-per-merged-pr"
              label="Per merged PR"
              figure={formatUsd(cost.perMergedPr.value)}
              detail={
                `over ${formatCount(cost.perMergedPr.mergedPrs)} merged in the last ` +
                `${formatCount(cost.windowDays)} days`
              }
              basis="counted"
            />
          ) : (
            <CostRefusedRow label="Per merged PR" refusal={cost.perMergedPr} />
          )}

          {cost.yours.status === 'value' ? (
            <CostValueRow
              testId="benchmark-cost-per-acted-on"
              label="Per acted-on thread"
              figure={formatUsd(cost.yours.perActedOnUsd)}
              // ⚠ COUNTED, NOT PROJECTED, and the detail says so: real threads over the stretch of
              // time they were measured across, not a fortnight's merges times two rates. ⚠ AND THE
              // SPAN IS NAMED AS A MEASUREMENT WINDOW, NEVER AS A BILLING PERIOD — "2 of 20 threads
              // acted on, over 9 days" is the pace this monthly price is divided by, which is the
              // whole reason `actedPerMonth` rides the wire beside the quotient.
              detail={
                `${formatThreadCount(cost.yours.actedThreads)} of ` +
                `${formatCount(cost.yours.settledThreads)} threads acted on` +
                (cost.span == null ? '' : `, over ${formatSpanDays(cost.span.days)}`) +
                ` — about ${formatThreadCount(cost.yours.actedPerMonth)} a month`
              }
              basis="counted"
            />
          ) : (
            <CostRefusedRow label="Per acted-on thread" refusal={cost.yours} />
          )}

          {cost.atPeerEngagement.status === 'value' ? (
            <CostValueRow
              testId="benchmark-cost-counterfactual"
              label="At peer engagement"
              figure={formatUsd(cost.atPeerEngagement.perActedOnUsd)}
              // ⚠ WORDED AS A COUNTERFACTUAL, NEVER AS A PEER DISTRIBUTION. Your threads, your
              // price, THEIR rate — exactly one factor moved, and the row says which one.
              detail={
                `your threads and price with the cohort's median ` +
                `${formatMetricValue(cost.atPeerEngagement.cohortActedOnRate, 'rate')} acted-on ` +
                `rate — ${formatThreadCount(cost.atPeerEngagement.actedThreadsAtPeer)} acted on, ` +
                `about ${formatThreadCount(cost.atPeerEngagement.actedPerMonthAtPeer)} a month`
              }
              basis="fitted"
            />
          ) : (
            <CostRefusedRow label="At peer engagement" refusal={cost.atPeerEngagement} />
          )}
        </div>
      )}

      {/* ⚠ THE HEADLINE IS A FIGURE, NOT A FINDING, so it does NOT borrow the amber chrome the
          anomaly cards use — those cleared a share gate, a magnitude gate and the cohort's own
          median CI. This one is arithmetic and says so.

          ⚠ AND IT IS TWO PARAGRAPHS, NEVER ONE. The MEASURED figure and the COUNTERFACTUAL gap are
          different quantities that differ by a factor of the cohort's rate; the first cut printed
          the second's number under the first's words. They are two fields on the model and two
          elements here, so a renderer cannot reunite them by accident.

          ⚠ BOTH ARE PER-MONTH RATES AT TODAY'S PRICE, never a spend over the span. The sentences
          shipped as shares of a prorated `span.usd` — "US$189.22 of this reviewer's US$236.53 over
          the 8.6 weeks its comments span here" — which is a history this app cannot evidence. */}
      {headline != null && (
        <div
          className="mt-1.5 space-y-1 border-t border-gray-200 pt-1.5 text-[11px] leading-relaxed text-gray-700 dark:border-gray-800 dark:text-gray-200"
          data-testid={`benchmark-cost-headline-${headline.tone}`}
        >
          <p data-testid="benchmark-cost-headline-spend">{headline.spend}</p>
          {headline.comparison != null && (
            <p className="text-gray-500 dark:text-gray-400" data-testid="benchmark-cost-headline-comparison">
              {headline.comparison}
            </p>
          )}
        </div>
      )}

      {/* The time base's own caveat, server-authored so it cannot be dropped by a renderer that
          did not know it existed. */}
      {showsSpan && (
        <p className="mt-1 text-[10px] leading-relaxed text-gray-400">{cost.spanNote}</p>
      )}
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
            <p className="mt-1 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
              {anomaly.action}
            </p>
            {/* ⚠ BOTH GATES, SEPARATELY. The share and the magnitude are published as two numbers
                rather than as their conjunction so a reader can see WHY this fired and argue with
                the threshold instead of the verdict. */}
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
              <div className="flex gap-1.5">
                <dt className="text-amber-700/70 dark:text-amber-300/70">Rank</dt>
                <dd className="tabular-nums text-amber-900 dark:text-amber-100">
                  {percentileSentence({
                    percentile: anomaly.share.percentile,
                    nRepos: rankRepos,
                    bandLabel: anomaly.bandLabel,
                  })}
                </dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-amber-700/70 dark:text-amber-300/70">Gap</dt>
                <dd className="tabular-nums text-amber-900 dark:text-amber-100">
                  {row.metricLabel} {formatMetricValue(anomaly.magnitude.value, anomaly.magnitude.unit)}{' '}
                  vs a peer median of{' '}
                  {formatMetricValue(anomaly.magnitude.cohortMedian, anomaly.magnitude.unit)} (over{' '}
                  {formatCount(anomaly.units)} of yours)
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
          <span className="text-[10px] text-gray-400">
            {unit.reviewers.map((r) => r.login).join(', ')}
          </span>
        )}
      </div>

      {placement.status === 'placed' ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
          {/* ⚠ THE BAND COUNT RIDES THE BAND. "Band 6" is meaningless; "band 6 of 10" is a rank. */}
          <span className="tabular-nums">
            Activity band {placement.bandLabel} ({formatCount(placement.bandRange[0])}–
            {formatCount(placement.bandRange[1])} merged PRs a fortnight)
          </span>
          <span className="tabular-nums">
            {formatCount(placement.cohortRepos)} peer repositories defined this band
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
                  <span className="ml-1 text-[10px] text-gray-400">
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
                  <span className="text-[10px] text-gray-400">
                    {geom == null ? 'No readable distribution to draw' : ''}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* ⚠ BENEATH THE STRIPS, AND ABSENT WHEN NO PRICE IS SET. `unit.cost` is simply not on the
          wire for a reviewer nobody priced — no placeholder, no empty card, no zero. */}
      {unit.cost != null && <CostBlock cost={unit.cost} />}
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
                  <dd className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
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
      <Body data={data} isLoading={isLoading} isError={isError} width={width} />
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
  width,
}: {
  data: BotBenchmarkPlacementResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  width: number;
}): JSX.Element {
  const units = useMemo(() => orderedUnits(data?.units ?? []), [data?.units]);
  const tally = useMemo(() => placementTally(units), [units]);
  const absent = useMemo(() => absentMetricRows(data?.absentMetrics), [data?.absentMetrics]);

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
            : 'No peer corpus is being served'
        }
        message={
          data.message ??
          'Peer benchmarking compares your review bots against the same products running in ' +
            'comparable repositories. This build is not serving that corpus.'
        }
      />
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-400">
        <span className="inline-flex items-center gap-1">
          <ChartIcon size={12} />
          Each reviewer is compared with the SAME product running in repositories of comparable
          activity.
        </span>
        {data.staleness != null && (
          <span title={`The corpus's newest observation is ${Math.round(data.staleness.corpusAgeDays)} days old.`}>
            {STALENESS_LABEL[data.staleness.state]} ·{' '}
            {Math.round(data.staleness.corpusAgeDays)} days old
          </span>
        )}
        {data.fitKey != null && data.fitKey !== '' && (
          <span className="font-mono">{data.fitKey}</span>
        )}
      </div>

      {/* ⚠ NEVER A SILENT TRUNCATION. The omitted repositories are not "no data". */}
      {data.truncated === true && (
        <RefusalNote
          testId="benchmark-truncated"
          headline="More repositories than one request folds"
          message={
            'This Workspace holds more (repository × reviewer) pairs than one request may measure, ' +
            'so only the first are shown. The rest are not “no data” — open a repository’s own ' +
            'Bots tab to place it.'
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
          <FindingsSection units={units} tally={tally} />
          <div className="space-y-2">
            {units.map((unit) => (
              <UnitCard key={`${unit.repoId}:${unit.vendor ?? unit.botKind ?? 'bot'}`} unit={unit} width={width} />
            ))}
          </div>
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
            <span className="rounded bg-gray-500/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-gray-500">
              {DERIVATION_LABEL.model}
            </span>
          </div>
          <ul className="mt-1 space-y-1">
            {absent.map((m) => (
              <li key={m.name} className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
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
