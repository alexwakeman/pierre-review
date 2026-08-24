import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type {
  ActorLane,
  ActorLaneBand,
  PeriodForecast,
  PeriodLaneStats,
  PeriodLanes,
  PeriodMetricDelta,
  PeriodMetricKey,
  PeriodMetricValue,
  PeriodMovement,
  PeriodRefusalReason,
  PeriodReport,
  PeriodReportListItem,
  PeriodReportModelInfo,
  PeriodSuggestedQuestion,
} from '@pierre-review/shared';
import {
  ACTOR_LANES,
  ACTOR_LANE_BAND,
  PERIOD_METRIC_KEYS,
  PERIOD_METRICS_SCHEMA_VERSION,
} from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { useAiUsage } from '../../hooks/useAiUsage.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import {
  periodReportGenerateMutationKey,
  periodReportModelChoices,
  useGeneratePeriodReport,
  usePeriodReport,
  usePeriodReportChat,
  usePeriodReportsList,
} from '../../hooks/usePeriodReports.js';
import { PALETTE, fmtDuration } from '../charts/common.js';
import { PeriodMetricSpark } from './PeriodMetricSpark.js';
import { SummaryMarkdown } from './prRefTable.js';

// The Insights "Reports" sub-tab — one completed period as a forwardable artifact: what happened,
// how it compares like-for-like to the period before it, what that implies for the next one, and
// a grounded drill-down.
//
// The whole surface is built around being honest about what it does not know, and most of the
// rules below exist because the alternative renders a plausible lie:
//
//  • "No prior period" is NOT "no change". One means there is nothing to compare against; the
//    other means we compared and found nothing moved. Rendering the first as a 0 (or as a blank)
//    invents a comparison.
//  • A null metric renders "—". Never 0. `null` means no data; 0 means we counted and got none.
//  • An INSIGNIFICANT delta shows the raw figures and no percentage. A percentage off a tiny
//    base is noise wearing a suit — the same reason `WorkspaceMetricsPanel` drops its ▲/▼ under
//    `lowConfidence`. The server has already decided (`significant`); the SPA must never
//    re-derive it, because the floors that produced it live in CORE and are not on the wire.
//  • A refused forecast names its reason. A blank cell reads as "no change expected".
//  • The comparison states its coverage subset VERBATIM. Retroactive history is biased by repo
//    onboarding — merged-PR counts across the dev workspace's last 6 months read 570…39, which
//    looks like explosive growth and is actually 18 repos shrinking to 4.
//  • The title is the DATE RANGE. The words "monthly" / "month on month" appear nowhere: a
//    14-day cadence is ~2.17 periods per calendar month and that label would simply be false.

// ── Metric presentation ──────────────────────────────────────────────────────────────────────
//
// LABELS AND FORMATTERS ONLY. `direction` is NOT duplicated here — it rides on every
// `PeriodMetricDelta` from the server, which is what keeps this table from becoming a second copy
// of spec §1's direction column that can silently disagree with the significance the server
// computed. The sample/absolute floors are likewise absent on purpose: they are CORE's
// (`db/period-metrics.ts`) and reach the SPA only as the pre-computed `significant` flag.
type Fmt = (n: number) => string;

const countFmt: Fmt = (n) => String(Math.round(n));
const pctFmt: Fmt = (n) => `${Math.round(n)}%`;
const linesFmt: Fmt = (n) => `${Math.round(n)}`;
const ratioFmt: Fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
// The CHANGE in a percentage metric is measured in POINTS, not percent. Without this the CI
// success row reads "▲ +5% (+8%)" — two different quantities wearing the same suffix, which is
// exactly the ambiguity this surface exists to avoid.
const pointsFmt: Fmt = (n) => `${Math.round(n)} pts`;

interface MetricMeta {
  label: string;
  format: Fmt;
  // How the ABSOLUTE CHANGE reads, when that differs from how the value reads (percentages →
  // points). Defaults to `format`.
  changeFormat?: Fmt;
  // A short caption under the label, shown where the metric's definition is narrower than its
  // name. Three of these are not cosmetic — they are the difference between a number the reader
  // trusts and one they think disagrees with another screen.
  note?: string;
  // ⚠ THE LABEL FOR ANYWHERE OUTSIDE THE TABLE ROW.
  //
  // The two human-only twins are labelled `…by people`, which reads correctly ONLY directly under
  // the blended figure they qualify. On a "biggest movers" pill that context is gone, and BOTH of
  // them render as the same pill — a reader seeing "…by people ▼ −47 (−25%)" cannot tell whether
  // their team merged 47 fewer PRs or wrote PRs 47 lines smaller, which are opposite kinds of
  // news. Set this wherever `label` leans on its neighbour to make sense.
  standaloneLabel?: string;
}

/** The label to use where the metric appears on its own — a pill, a tooltip, a chat prompt —
 *  rather than in a table row directly beneath the figure it qualifies. */
function standaloneLabelFor(meta: MetricMeta): string {
  return meta.standaloneLabel ?? meta.label;
}

function changeFmtFor(meta: MetricMeta): Fmt {
  return meta.changeFormat ?? meta.format;
}

const METRIC_META: Record<PeriodMetricKey, MetricMeta> = {
  merged_prs: { label: 'Merged PRs', format: countFmt, note: 'everything that landed' },
  // ⚠ THE HUMAN-ONLY TWIN SITS DIRECTLY UNDER ITS BLENDED PARENT, in `PERIOD_METRIC_KEYS` order,
  // and that adjacency is the feature. `117 / 71` read one under the other states the automation
  // gap with no narration; the same two numbers on opposite sides of a table are two facts nobody
  // joins up.
  human_merged_prs: {
    label: '…by people',
    standaloneLabel: 'Merged PRs by people',
    format: countFmt,
    note: 'excludes bumps, agents, release bots',
  },
  opened_prs: { label: 'Opened PRs', format: countFmt },
  automation_merge_share_pct: {
    label: 'Automation share of merges',
    format: pctFmt,
    changeFormat: pointsFmt,
    note: 'no arrow — more automation is not self-evidently better or worse',
  },
  median_lead_time_hours: {
    label: 'Lead time',
    format: fmtDuration,
    note: 'median open → merge',
  },
  median_time_to_first_human_review_hours: {
    label: 'Time to first review by a person',
    format: fmtDuration,
    // TWO things this caption has to carry, both of which have burned a reader:
    //  • "by a person" — this metric used to attribute to whoever reviewed FIRST, which on a
    //    workspace where CI auto-approves on push is the bot, at zero minutes. It read 0h against
    //    a real human median of 18.3h.
    //  • "counted on the review" — deliberately different from the Flow-metrics tile of nearly
    //    the same name. Bucketing by open date right-censors a recent window (PRs opened in-window
    //    but not yet reviewed contribute nothing, biasing the median DOWN).
    note: 'median, counted on the review — not the open. Bot approvals are excluded',
  },
  merge_ci_success_pct: {
    label: 'Merge CI success',
    format: pctFmt,
    changeFormat: pointsFmt,
    note: '% green at merge',
  },
  median_pr_size_lines: {
    label: 'PR size',
    format: linesFmt,
    note: 'median lines added + deleted',
  },
  median_human_pr_size_lines: {
    label: '…by people',
    standaloneLabel: 'PR size, people only',
    format: linesFmt,
    // The measured case: Dependabot's 14-line bumps and the humans' 142 blended to a reported 68,
    // a number no pull request in the workspace resembled.
    note: 'the blended figure above understated this by 2.1× on the workspace this was built for',
  },
  review_threads_opened: { label: 'Review threads opened', format: countFmt },
  threads_replied_within_36h_pct: {
    label: 'Threads replied within 36h',
    format: pctFmt,
    changeFormat: pointsFmt,
    note: 'same 36h grace the bot verdict uses',
  },
  // Both comment counts are INLINE review comments only — not PR-level comments, not review
  // bodies. The Bots tab's "bot comments" counts all three, so the same workspace legitimately
  // shows a larger figure there; without this caption that reads as one of the two being broken.
  bot_review_comments: {
    label: 'Bot review comments',
    format: countFmt,
    // INLINE ONLY, and that is why the "Effort vs automation" panel above can legitimately show a
    // much larger figure: quality gates post ISSUE comments, so a workspace with 786 SonarQube
    // comments reads 0 here. The panel counts all three channels; this row is the frozen vector
    // metric and stays comparable with every period stored before the panel existed.
    note: 'inline only — see Effort vs automation',
  },
  human_review_comments: {
    label: 'Human review comments',
    format: countFmt,
    note: 'inline only — see Effort vs automation',
  },
  bot_comments_per_merged_pr: { label: 'Bot comments per merged PR', format: ratioFmt },
  reviewer_concentration_pct: {
    label: 'Reviewer concentration',
    format: pctFmt,
    changeFormat: pointsFmt,
    // Bots are excluded from this one — a bot that submits more reviews than anyone would
    // otherwise define "the busiest reviewer" and the number would stop being about the team.
    note: 'share taken by the busiest human reviewer',
  },
};

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────
// A named reason, in the reader's words. Note what is NOT said: `insufficient_history` does not
// quote the minimum number of periods, because that constant (`MIN_FORECAST_POINTS`) lives in
// CORE and a hard-coded "4" here would drift silently the day it moves.
const REFUSAL_TEXT: Record<PeriodRefusalReason, string> = {
  no_prior_period: 'No earlier period is stored, so there is nothing to compare against.',
  cadence_changed:
    'The sprint cadence changed between these two periods. Periods of different lengths are not comparable, so the difference is not shown rather than being quietly subtracted.',
  partial_coverage:
    'No repo in this workspace was being tracked across both periods, so there is no like-for-like subset to compare.',
  insufficient_history:
    'Not enough complete periods yet — a trend needs several periods where every repo in the subset was already being tracked.',
  too_volatile:
    'Too volatile to forecast: the uncertainty band came out wider than the estimate itself.',
};

// ── Dates ────────────────────────────────────────────────────────────────────────────────────
//
// Rendered in UTC, matching the period key (`sprint-2026-08-18` is a UTC date). Local formatting
// would show "17 Aug" to a reader west of Greenwich for a period whose own key says the 18th.
//
// `periodEnd` is the window's EXCLUSIVE bound and is printed as-is: a 14-day period starting
// 18 Aug is titled "18 Aug – 1 Sep", which is how the cadence is spoken about. Do not
// "fix" it by subtracting a day.
const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };

function periodTitle(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const thisYear = new Date().getUTCFullYear();
  const withYear: Intl.DateTimeFormatOptions = { ...DAY_MONTH, year: 'numeric' };
  if (!sameYear) {
    return `${s.toLocaleDateString(undefined, withYear)} – ${e.toLocaleDateString(undefined, withYear)}`;
  }
  const tail =
    s.getUTCFullYear() === thisYear
      ? e.toLocaleDateString(undefined, DAY_MONTH)
      : e.toLocaleDateString(undefined, withYear);
  return `${s.toLocaleDateString(undefined, DAY_MONTH)} – ${tail}`;
}

function shortPeriodLabel(p: PeriodReportListItem): string {
  return periodTitle(p.periodStart, p.periodEnd);
}

// Signed change, in the metric's own units — never a bare number, so "+2h" doesn't read as "+2".
function signed(n: number, format: Fmt): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${format(Math.abs(n))}`;
}

const GOOD = 'text-green-600 dark:text-green-400';
const BAD = 'text-red-500 dark:text-red-400';
const MUTED = 'text-gray-400';

// Did the change go the metric's good way? `null` for a neutral metric (opened PRs, thread
// volume, bot comment counts) — those genuinely have no good direction and must not be coloured.
function favourability(d: PeriodMetricDelta): boolean | null {
  if (d.absoluteChange == null || d.absoluteChange === 0) return null;
  if (d.direction === 'neutral') return null;
  return (d.absoluteChange > 0) === (d.direction === 'up_good');
}

function toneClass(fav: boolean | null): string {
  return fav == null ? MUTED : fav ? GOOD : BAD;
}

function toneHex(fav: boolean | null): string {
  return fav == null ? PALETTE.gray : fav ? PALETTE.green : PALETTE.red;
}

// "There is no earlier period" vs "there is one, but it had no figure for this metric" — two
// different absences, and only the report as a whole knows which. Both render distinctly from
// "no change" and neither renders as 0.
/**
 * The three figures of one metric row, resolved to ONE population.
 *
 * Exported for its unit test: there is no jsdom in this workspace, so the row cannot be rendered,
 * and the invariant that matters here is arithmetic rather than visual — `value − prior` must
 * equal the change the row prints. That is precisely what broke before (see the block comment in
 * `MetricTable`), so it is pinned as a pure function rather than left to a component test that
 * this repo has no way to run.
 *
 * `headline` is the full-membership figure, and is non-null ONLY when it is a genuinely different
 * number from the one being subtracted — it is disclosure, never an input to the arithmetic.
 */
export function rowFigures(
  mv: PeriodMetricValue | undefined,
  delta: PeriodMetricDelta | undefined,
  populationsDiffer: boolean,
): {
  value: number | null;
  prior: number | null;
  headline: number | null;
  /** The displayed figure rests on fewer items than the metric's floor. Taken from whichever
   *  object supplied `value`, so the marker always describes the population on screen. */
  lowSample: boolean;
} {
  // NOT `delta?.value ?? mv?.value`: that silently substitutes the headline whenever the subset
  // legitimately has no figure, which reintroduces the two-population mix in the one case that is
  // hardest to spot.
  const value = delta ? delta.value : (mv?.value ?? null);
  return {
    value,
    prior: delta?.prior ?? null,
    headline: populationsDiffer && delta ? (mv?.value ?? null) : null,
    // From the SAME object as `value`, for the same reason `value` is: the two populations have
    // different sample sizes, and marking the row's figure with the other one's thinness is the
    // same mixing bug in miniature.
    lowSample: (delta ? delta.lowSample : mv?.lowSample) ?? false,
  };
}

/** A backfilled, metrics-only period: no comparison was ATTEMPTED (hence no refusal) and no
 *  forecast was computed. Distinct from a refused comparison and from a genuine first period,
 *  both of which carry a reason — all three rendered identically before this existed. */
function figuresOnly(report: PeriodReport): boolean {
  return (
    report.comparison.deltas.length === 0 &&
    report.comparison.refusal == null &&
    report.comparison.priorPeriodKey == null &&
    report.forecasts.length === 0
  );
}

function NoPrior({
  hasPriorPeriod,
  notComputed,
}: {
  hasPriorPeriod: boolean;
  notComputed: boolean;
}): JSX.Element {
  if (notComputed) {
    return (
      <span
        className={`text-[11px] ${MUTED}`}
        title="This period was backfilled for the forecast series; no comparison was run for it"
      >
        not compared
      </span>
    );
  }
  return hasPriorPeriod ? (
    <span
      className={`text-[11px] ${MUTED}`}
      title="The previous period exists but has no figure for this metric, so there is nothing to subtract"
    >
      no prior figure
    </span>
  ) : (
    <span className={`text-[11px] ${MUTED}`} title="Nothing is stored for the period before this one">
      no prior period
    </span>
  );
}

// ── The change cell ──────────────────────────────────────────────────────────────────────────
function ChangeCell({
  delta,
  format,
  hasPriorPeriod,
}: {
  delta: PeriodMetricDelta;
  format: Fmt;
  hasPriorPeriod: boolean;
}): JSX.Element {
  // NO PRIOR VALUE — rendered distinctly from "no change", and never as a 0. This is the branch
  // the spec is most emphatic about: the two states look identical if you only check for a
  // falsy delta, and conflating them tells the reader we compared when we did not.
  // `notComputed` is false by construction here: this cell only renders when a delta EXISTS, and
  // a figures-only period has none.
  if (delta.prior == null) return <NoPrior hasPriorPeriod={hasPriorPeriod} notComputed={false} />;
  if (delta.value == null || delta.absoluteChange == null) {
    return (
      <span className={`text-[11px] ${MUTED}`} title="No data for this metric in this period">
        —
      </span>
    );
  }
  if (delta.absoluteChange === 0) {
    return <span className={`text-[11px] ${MUTED}`}>no change</span>;
  }

  // INSIGNIFICANT — the raw figures only, no percentage and no verdict colour. The columns either
  // side already carry both real numbers; all this says is "it moved, and we are not calling it".
  if (!delta.significant) {
    return (
      <span
        className={`text-[11px] ${MUTED}`}
        title="Below the sample or size floor for this metric — the figures are real, but the change is not distinguishable from noise, so no percentage is quoted"
      >
        {signed(delta.absoluteChange, format)}
        <span className="ml-1 text-[10px]">· not significant</span>
      </span>
    );
  }

  const fav = favourability(delta);
  return (
    <span className={`text-[11px] font-medium ${toneClass(fav)}`}>
      {delta.absoluteChange > 0 ? '▲' : '▼'} {signed(delta.absoluteChange, format)}
      {delta.percentChange != null ? (
        <span className="ml-1 font-normal">({signed(delta.percentChange, pctFmt)})</span>
      ) : (
        // prior === 0: a percentage would be infinite, so the server sends null and we say why
        // rather than leaving the reader to wonder where the % went.
        <span className={`ml-1 font-normal ${MUTED}`} title="The prior period was 0, so a percentage change is undefined">
          (from 0)
        </span>
      )}
    </span>
  );
}

// ── The forecast cell ────────────────────────────────────────────────────────────────────────
function ForecastCell({
  forecast,
  format,
}: {
  forecast: PeriodForecast | undefined;
  format: Fmt;
}): JSX.Element {
  if (forecast == null) {
    return <span className={`text-[11px] ${MUTED}`}>—</span>;
  }
  if (!forecast.available) {
    return (
      <span className={`text-[11px] ${MUTED}`} title={REFUSAL_TEXT[forecast.reason]}>
        not forecast · {forecast.reason.replace(/_/g, ' ')}
      </span>
    );
  }
  return (
    <span
      className="text-[11px] text-violet-600 dark:text-violet-300"
      title={`${forecast.basis} · ${forecast.periodsUsed} periods`}
    >
      ≈ {format(forecast.point)}
      <span className={`ml-1 ${MUTED}`}>
        ({format(forecast.low)}–{format(forecast.high)})
      </span>
    </span>
  );
}


// ── Effort vs automation ─────────────────────────────────────────────────────────────────────
//
// The panel that answers "how much of this was a person". It exists because the blended figures
// in the table above genuinely cannot: measured on a real workspace, 117 merged PRs in a
// fortnight were 71 human and 46 Dependabot, and the reported median PR size of 68 lines was a
// blend of Dependabot's 14 and the humans' 142 — a number no pull request there resembled.
//
// LANES rather than bot-vs-human, because automation distorts DIFFERENT metrics depending on what
// it does: a dependency bot inflates throughput, a quality gate inflates review counts and
// approvals, and only an AI reviewer's volume says anything about review substance.
//
// The dependency/code-agent split is the one that most resists being collapsed back. Both author
// pull requests, so any bot-vs-human view files them together — and yet a merged Dependabot bump
// is overhead a team absorbed while a merged agent PR is work it shipped. "Automation authored
// 40% of merges" is unreadable until you know which of those two it means.
//
// Colours are chosen so the two AUTHORING lanes read as a pair (teal/grey) and the RESPONDING
// lanes as another (violet/blue/indigo), because the band is the first cut a reader makes.
const LANE_META: Record<ActorLane, { label: string; note: string; hex: string }> = {
  human: { label: 'People', note: 'authored and reviewed by humans', hex: PALETTE.green },
  code_agent: {
    label: 'Code agents',
    note: 'Devin, autofix, codegen, translation sync — writes real changes',
    hex: PALETTE.teal,
  },
  dependency: {
    label: 'Dependency bots',
    note: 'Dependabot, Renovate — version bumps, never reviews',
    hex: PALETTE.gray,
  },
  ai_review: { label: 'AI review', note: 'CodeRabbit, Copilot, Greptile…', hex: PALETTE.violet },
  quality_gate: {
    label: 'Quality gates & CI',
    note: 'SonarQube, scanners, Actions — posts verdicts, not findings',
    hex: PALETTE.blue,
  },
  release: {
    label: 'Release automation',
    note: 'merge queues, release trains, backports — moves code',
    hex: PALETTE.indigo,
  },
  housekeeping: {
    label: 'Housekeeping',
    note: 'CLA, triage, labels, stale, size reports — noise in every review metric',
    hex: PALETTE.slate,
  },
};

// Which lanes AUTHOR the work and which merely RESPOND to it. MIRRORED from `ACTOR_LANE_BAND` in
// shared — the frontend CAN import shared for real (only the backend's release build forbids it),
// so this reads the shared map rather than re-listing it.
//
// The band is what makes seven lanes legible: a reader does not want seven numbers, they want
// "how much of this was people, what wrote the rest, and what merely commented on it".
const BAND_LABEL: Record<ActorLaneBand, string> = {
  people: 'People',
  authors: 'Automation that writes code',
  responds: 'Automation that responds',
};

/** One stacked bar. Zero-total renders as a flat rule rather than an empty box, so the row still
 *  reads as "nothing here" instead of looking broken. */
function LaneBar({
  parts,
  total,
}: {
  parts: { lane: ActorLane; n: number }[];
  total: number;
}): JSX.Element {
  if (total <= 0) {
    return <div className="h-2 w-full rounded-sm bg-gray-100 dark:bg-gray-900" title="nothing in this period" />;
  }
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-sm">
      {parts
        .filter((p) => p.n > 0)
        .map((p) => (
          <div
            key={p.lane}
            style={{ width: `${(p.n / total) * 100}%`, backgroundColor: LANE_META[p.lane].hex }}
            title={`${LANE_META[p.lane].label}: ${p.n} of ${total} (${Math.round((p.n / total) * 100)}%)`}
          />
        ))}
    </div>
  );
}

function LanesPanel({ lanes }: { lanes: PeriodLanes }): JSX.Element | null {
  const byLane = new Map(lanes.lanes.map((l) => [l.lane, l]));
  const order: ActorLane[] = ACTOR_LANES;
  const axes: { key: string; label: string; pick: (l: PeriodLaneStats) => number }[] = [
    { key: 'authored', label: 'PRs merged', pick: (l) => l.mergedPrs },
    { key: 'comments', label: 'Review comments', pick: (l) => l.comments },
    { key: 'approvals', label: 'Approvals', pick: (l) => l.approvals },
  ];
  const anything = axes.some((a) => lanes.lanes.reduce((n, l) => n + a.pick(l), 0) > 0);
  if (!anything) return null;

  const human = byLane.get('human');
  const ai = byLane.get('ai_review');

  // ⚠ THE LEGEND LISTS ONLY LANES THAT DID SOMETHING. Seven chips under a bar with two colours in
  // it reads as five missing measurements rather than five absent tools — and most workspaces run
  // three or four of these. A lane that is genuinely zero is not a fact worth a chip.
  const activeLanes = order.filter((lane) => {
    const l = byLane.get(lane);
    return l != null && axes.some((a) => a.pick(l) > 0);
  });

  // The band rollup, over MERGES. Three numbers is what a reader actually takes away — the
  // per-lane bars are the detail behind it, not the summary.
  const mergeTotal = lanes.lanes.reduce((n, l) => n + l.mergedPrs, 0);
  const bandMerges = (band: ActorLaneBand): number =>
    lanes.lanes.reduce((n, l) => (ACTOR_LANE_BAND[l.lane] === band ? n + l.mergedPrs : n), 0);

  return (
    <div className="space-y-2 rounded-md border border-gray-200 px-3 py-2.5 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[12px] font-medium text-gray-700 dark:text-gray-200">
          Effort vs automation
        </span>
        {lanes.automationMergeSharePct != null && (
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {/* THE headline. One number that reframes every throughput figure above it. */}
            {lanes.automationMergeSharePct}% of merges were automated
          </span>
        )}
      </div>

      {axes.map((axis) => {
        const total = lanes.lanes.reduce((n, l) => n + axis.pick(l), 0);
        return (
          <div key={axis.key} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2">
            <span className="text-[11px] text-gray-500 dark:text-gray-400">{axis.label}</span>
            <LaneBar
              parts={order.map((lane) => ({ lane, n: axis.pick(byLane.get(lane) ?? ({} as PeriodLaneStats) ) || 0 }))}
              total={total}
            />
            <span className="text-right text-[11px] tabular-nums text-gray-400">{total}</span>
          </div>
        );
      })}

      {/* THE BAND ROLLUP — the one line most readers will take away. Three groups, because the
          actionable question is not "which of seven" but "did people write this, did a machine
          write it, or did a machine only comment on it". Rendered only when something merged;
          a share of nothing is not 0%. */}
      {mergeTotal > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
          {(['people', 'authors', 'responds'] as ActorLaneBand[]).map((band) => {
            const n = bandMerges(band);
            // `responds` is ~always 0 merges by construction (a reviewer does not author), so it
            // would render as a permanent "0%" that looks like a broken measurement. Dropping a
            // zero band is the same rule as dropping an inactive lane from the legend.
            if (n === 0) return null;
            return (
              <span key={band}>
                <span className="font-medium text-gray-600 dark:text-gray-300">
                  {Math.round((n / mergeTotal) * 100)}%
                </span>{' '}
                {BAND_LABEL[band].toLowerCase()}
              </span>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
        {activeLanes.map((lane) => (
          <span
            key={lane}
            title={LANE_META[lane].note}
            className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400"
          >
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: LANE_META[lane].hex }} />
            {LANE_META[lane].label}
          </span>
        ))}
      </div>

      {/* A CONFIGURED AI REVIEWER SITTING AT ZERO IS A FINDING, and it is invisible in every
          aggregate — the bar simply has no violet in it, which reads as "we don't use one".
          Measured on a real workspace: Copilot's reviewer was installed and had posted nothing in
          90 days. Only stated when automation is otherwise present, so a team that has genuinely
          not bought an AI reviewer is not nagged about it. */}
      {ai != null && ai.comments === 0 && lanes.silentAutomation.length > 0 && (
        <div className="text-[10px] text-amber-600 dark:text-amber-400">
          No AI-review activity this period, though automation is configured — worth checking it is
          still running.
        </div>
      )}

      {/* The human figures the blended table above cannot show. `fmtDuration`, not a raw number:
          an unformatted 5.484166666666667h is how a panel about honesty starts looking careless. */}
      {human != null && (human.medianPrSizeLines != null || human.medianLeadTimeHours != null) && (
        <div className="text-[10px] text-gray-400">
          Human PRs
          {human.medianPrSizeLines != null && ` ran ${human.medianPrSizeLines} lines at the median`}
          {human.medianLeadTimeHours != null &&
            `${human.medianPrSizeLines != null ? ' and' : ''} merged in ${fmtDuration(human.medianLeadTimeHours)}`}
          .
        </div>
      )}

      {/* ⚠ THIS CAPTION USED TO SAY THE TABLE ABOVE WAS CONTAMINATED, AND IT NO LONGER IS.
          At metrics schema v1 the vector's "Time to first review" attributed to whoever reviewed
          FIRST — a CI bot auto-approving at zero minutes — so this line existed to warn the reader
          off the number directly above it. v2 renamed and redefined that metric to count only a
          person, so the warning would now be actively false: it would tell a reader to distrust a
          figure that IS the human one.
          What is left is a reconciliation. Both figures come from the same fold in
          `getPeriodLanes`, so they cannot disagree — and saying so is what stops the next reader
          assuming one of the two screens is stale. */}
      {lanes.medianTimeToFirstHumanReviewHours != null && (
        <div className="text-[10px] text-gray-400">
          First review by a person: {fmtDuration(lanes.medianTimeToFirstHumanReviewHours)} at the
          median — the same measurement as the row above, which counts people only and excludes
          bot approvals.
        </div>
      )}
    </div>
  );
}

// ── The metric table ─────────────────────────────────────────────────────────────────────────
function MetricTable({ report }: { report: PeriodReport }): JSX.Element {
  // Keyed lookups, so a metric the server did not send (an older schema version, or a key added
  // in a later version) simply renders "—" / "no prior" rather than throwing or landing on the
  // wrong row. PERIOD_METRIC_KEYS is the render order and is part of the contract.
  const values = new Map<PeriodMetricKey, PeriodMetricValue>(
    report.metrics.map((m) => [m.key, m]),
  );
  const deltas = new Map<PeriodMetricKey, PeriodMetricDelta>(
    report.comparison.deltas.map((d) => [d.key, d]),
  );
  const forecasts = new Map<PeriodMetricKey, PeriodForecast>(
    report.forecasts.map((f) => [f.key, f]),
  );
  // Whether an EARLIER PERIOD exists at all — a report-level fact, not a per-metric one, which is
  // why the cells cannot work it out for themselves from a null `prior`.
  const hasPriorPeriod = report.comparison.priorPeriodKey != null;
  const notComputed = figuresOnly(report);

  // ⚠ TWO POPULATIONS, AND A ROW MAY ONLY EVER SHOW ONE.
  //
  // `report.metrics` is the HEADLINE scan over the workspace's FULL CURRENT membership;
  // `report.comparison.deltas` is a SEPARATE scan over the coverage-stable subset — the repos
  // tracked across BOTH this period and the prior one (spec §4). They are different populations
  // and their figures do not belong in one subtraction.
  //
  // This row used to take "This period" from the headline and "Prior"/"Change" from the subset,
  // which rendered arithmetic that does not close. Measured on the real dev DB: workspace BNG's
  // just-closed sprint showed "117 | 146 | −33" — 117 is 8 repos, 146 and the −33 are 7 repos,
  // and 117 − 146 = −29, so none of the three numbers agreed with the other two. It is the SAME
  // defect that was found and fixed in the narration prompt (period-report.ts's two-populations
  // rule, and the test that forbids the headline and subset figures sharing a field name) — the
  // prose was hardened and the table a reader actually looks at was not.
  //
  // So: when a comparison exists, every cell in the row — and the spark — comes from the DELTA.
  // The headline still appears, in its own labelled line, because §4 is right that it is what the
  // reader means by "this period"; it is simply never the thing "Prior" is subtracted from.
  //
  // NOT `delta?.value ?? mv?.value`: that silently substitutes the headline whenever the subset
  // legitimately has no figure (a null median on a thin subset), reintroducing the mix in exactly
  // the case that is hardest to notice.
  const subsetCovers = report.comparison.subsetRepoIds.length;
  const populationsDiffer = subsetCovers > 0 && subsetCovers !== report.coverage.totalRepos;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-left text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-[10px] uppercase tracking-wide text-gray-400 dark:border-gray-800">
            <th className="py-1 pr-3 font-medium">Metric</th>
            <th className="py-1 pr-3 text-right font-medium">This period</th>
            <th className="py-1 pr-3 text-right font-medium">Prior</th>
            <th className="py-1 pr-3 font-medium">Change</th>
            <th className="py-1 pr-3 font-medium">Next period</th>
            <th className="py-1 font-medium" aria-label="Trend" />
          </tr>
        </thead>
        <tbody>
          {PERIOD_METRIC_KEYS.map((key) => {
            const meta = METRIC_META[key];
            const mv = values.get(key);
            const delta = deltas.get(key);
            const forecast = forecasts.get(key);
            // One population per row — see the block comment above. Resolved by `rowFigures`,
            // which is exported and unit-tested because the invariant is arithmetic.
            const { value, prior, headline, lowSample } = rowFigures(mv, delta, populationsDiffer);
            const fav = delta ? favourability(delta) : null;
            // An insignificant change must not colour the spark either — the picture and the
            // number have to tell the same story.
            const sparkTone = delta?.significant ? toneHex(fav) : PALETTE.gray;
            return (
              <tr key={key} className="border-b border-gray-100 last:border-0 dark:border-gray-900">
                <td className="py-1.5 pr-3 align-top">
                  <div className="font-medium text-gray-700 dark:text-gray-200">{meta.label}</div>
                  {meta.note && <div className="text-[10px] text-gray-400">{meta.note}</div>}
                </td>
                <td className="py-1.5 pr-3 text-right align-top">
                  {/* null is "—", never 0. The `sampleSize` title is only shown when this cell IS
                      the headline figure — `PeriodMetricDelta` carries no sample size, so quoting
                      the headline's count beside a subset figure would describe a different
                      population from the number above it. */}
                  <span
                    className="text-[13px] font-semibold text-gray-800 dark:text-gray-100"
                    title={
                      mv && !delta
                        ? `${mv.sampleSize} item${mv.sampleSize === 1 ? '' : 's'} behind this figure`
                        : undefined
                    }
                  >
                    {value == null ? '—' : meta.format(value)}
                  </span>
                  {/* ⚠ THIN SAMPLE. A real figure computed from almost nothing looks exactly like
                      a real figure computed from plenty, and "Time to first review: 0h" off two
                      reviews is the version of that which gets a tool called broken. The marker
                      says the figure is thin; it never suppresses it, because the number IS what
                      was observed. Rendered only when there is a figure — "—" is already the
                      stronger statement. */}
                  {lowSample && value != null && (
                    <span
                      className="ml-1 align-super text-[9px] font-normal text-amber-600 dark:text-amber-400"
                      title={
                        mv
                          ? `Thin sample — ${mv.sampleSize} item${mv.sampleSize === 1 ? '' : 's'} behind this figure. It is what was observed, but it moves easily.`
                          : 'Thin sample — this figure rests on very few items and moves easily.'
                      }
                      aria-label="thin sample"
                    >
                      ▵
                    </span>
                  )}
                  {headline != null && (
                    <div
                      className="text-[10px] text-gray-400"
                      title={`The comparison covers the ${subsetCovers} repo${subsetCovers === 1 ? '' : 's'} tracked across both periods. This is the figure for all ${report.coverage.totalRepos}.`}
                    >
                      all repos: {meta.format(headline)}
                    </div>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right align-top text-[12px] text-gray-500 dark:text-gray-400">
                  {/* '—' for both flavours of absence; the Change cell beside it says which. */}
                  {prior == null ? '—' : meta.format(prior)}
                </td>
                <td className="py-1.5 pr-3 align-top">
                  {delta ? (
                    <ChangeCell
                      delta={delta}
                      format={changeFmtFor(meta)}
                      hasPriorPeriod={hasPriorPeriod}
                    />
                  ) : (
                    // No delta row at all for this key — an older stored schema version, or a
                    // refused comparison (which empties `deltas`). Either way there is nothing to
                    // subtract, which is stated in words and NEVER as 0.
                    <NoPrior hasPriorPeriod={hasPriorPeriod} notComputed={notComputed} />
                  )}
                </td>
                <td className="py-1.5 pr-3 align-top">
                  {notComputed ? (
                    <span className={`text-[11px] ${MUTED}`} title="No forecast was computed for a backfilled period">
                      not forecast
                    </span>
                  ) : (
                    <ForecastCell forecast={forecast} format={meta.format} />
                  )}
                </td>
                <td className="py-1.5 align-top">
                  <PeriodMetricSpark
                    prior={prior}
                    value={value}
                    forecast={forecast?.available ? forecast : null}
                    format={meta.format}
                    favourableColor={sparkTone}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Movements ────────────────────────────────────────────────────────────────────────────────
// Significant movers only (the server ranks them; rank 0 is the biggest).
//
// ⚠ `favourable: false` IS NOT "BAD". `PeriodMovement` carries no `direction`, and the server sets
// `favourable` false for every NEUTRAL metric because a neutral metric has no good direction at
// all — so a two-way green/red on that flag alone paints every change in opened-PR count, thread
// volume and bot-comment count red. (The plugin that computes it says exactly this next to
// `rankMovements`; this component shipped doing it anyway.) The direction does reach the SPA —
// on the matching `PeriodMetricDelta` — so the tone is looked up by key there, and a metric with
// no delta row falls back to neutral rather than guessing.
const NEUTRAL_PILL = 'border-gray-300 text-gray-500 dark:border-gray-700 dark:text-gray-400';
const GOOD_PILL = 'border-green-300 text-green-700 dark:border-green-800 dark:text-green-300';
const BAD_PILL = 'border-red-300 text-red-600 dark:border-red-900 dark:text-red-300';

function Movements({
  movements,
  deltas,
}: {
  movements: PeriodMovement[];
  deltas: PeriodMetricDelta[];
}): JSX.Element | null {
  const top = movements.slice(0, 5);
  if (top.length === 0) return null;
  const directionOf = new Map(deltas.map((d) => [d.key, d.direction]));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
        Biggest movers
      </span>
      {top.map((m) => {
        const meta = METRIC_META[m.key];
        const neutral = (directionOf.get(m.key) ?? 'neutral') === 'neutral';
        return (
          <span
            key={m.key}
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              neutral ? NEUTRAL_PILL : m.favourable ? GOOD_PILL : BAD_PILL
            }`}
            title={
              neutral
                ? 'This metric has no good direction — it moved, and that is all this says.'
                : m.favourable
                  ? 'Moved in this metric’s good direction'
                  : 'Moved against this metric’s good direction'
            }
          >
            {standaloneLabelFor(meta)} {m.absoluteChange > 0 ? '▲' : '▼'}{' '}
            {signed(m.absoluteChange, changeFmtFor(meta))}
            {m.percentChange != null && ` (${signed(m.percentChange, pctFmt)})`}
          </span>
        );
      })}
    </div>
  );
}

// ── The drill-down chat ──────────────────────────────────────────────────────────────────────
// Grounded in the stored report's structured JSON. The pills carry a pre-bound scope server-side,
// so selecting one costs the model no re-derivation and cannot ask about data the report does not
// contain. The transcript is local to the mount: `PeriodChatResponse` has no history route, and
// inventing a client-side persistence layer for it would be a second source of truth.
function ReportChat({
  workspaceId,
  periodKey,
  suggested,
  disabled,
  disabledReason,
}: {
  workspaceId: number | null;
  periodKey: string;
  suggested: PeriodSuggestedQuestion[];
  disabled: boolean;
  disabledReason: string | null;
}): JSX.Element {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<{ question: string; answer: string }[]>([]);
  const chat = usePeriodReportChat(workspaceId, periodKey);

  // A different period is a different conversation: answers about 18 Aug – 1 Sep must not stay on
  // screen under the 1 – 15 Sep heading (the same class of bug as a stale window's numbers under a
  // new window's caption). The panel already remounts this subtree on a `key={periodKey}`, so this
  // is the second line of defence — cheap, and it survives someone removing that key.
  useEffect(() => {
    setTurns([]);
    setQuestion('');
  }, [periodKey]);

  const ask = (text: string, suggestedId?: string): void => {
    const t = text.trim();
    if (!t || disabled || chat.isPending) return;
    chat.mutate(
      { question: t, ...(suggestedId ? { suggestedId } : {}) },
      {
        onSuccess: (res) => {
          if (res.answer) setTurns((prev) => [...prev, { question: t, answer: res.answer }]);
        },
      },
    );
    setQuestion('');
  };

  return (
    <div className="space-y-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
        Ask about this period
      </h4>
      {suggested.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggested.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={disabled || chat.isPending}
              onClick={() => ask(s.text, s.id)}
              className="rounded-full border border-violet-300 px-2 py-0.5 text-[11px] text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
              title="Answered from this report's own figures — the question's scope is already bound to them"
            >
              {s.text}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') ask(question);
          }}
          disabled={disabled || chat.isPending}
          placeholder="e.g. which repos drove the lead-time change?"
          className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950"
        />
        <button
          type="button"
          onClick={() => ask(question)}
          disabled={disabled || chat.isPending || question.trim().length === 0}
          className="rounded border border-violet-300 px-2 py-1 text-[11px] font-medium text-violet-600 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300"
        >
          {chat.isPending ? 'Asking…' : 'Ask'}
        </button>
      </div>
      {disabled && disabledReason && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">{disabledReason}</div>
      )}
      {chat.isError && (
        <div className="text-[11px] text-red-500">
          {(chat.error as Error)?.message ?? 'Couldn’t answer that.'}
        </div>
      )}
      {chat.data?.creditsExhausted && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — questions resume on the 1st.
        </div>
      )}
      {turns.map((t, i) => (
        <div
          key={i}
          className="rounded-md border border-violet-200/70 bg-white/60 p-2.5 dark:border-violet-900/50 dark:bg-gray-900/40"
        >
          <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
            {t.question}
          </div>
          {/* prRefs is empty: PeriodChatResponse carries no resolved PR references, so nothing is
              linkified. SummaryMarkdown still gives the answer the same markdown/table treatment
              every other AI answer in the app gets. */}
          <SummaryMarkdown markdown={t.answer} prRefs={[]} onOpenPr={() => {}} />
        </div>
      ))}
    </div>
  );
}

// ── The report body ──────────────────────────────────────────────────────────────────────────
function ReportBody({
  report,
  workspaceId,
}: {
  report: PeriodReport;
  workspaceId: number | null;
}): JSX.Element {
  const usage = useAiUsage(true);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;
  const comparison = report.comparison;
  // A backfilled, metrics-only row: no comparison was ATTEMPTED (so no refusal either) and no
  // forecast was computed. Distinguishable from a generated report whose comparison was refused —
  // that one carries a `refusal` — and from a real first period, which has a refusal of
  // 'no_prior_period'. All three used to render identically.
  const isFiguresOnly =
    comparison.deltas.length === 0 &&
    comparison.refusal == null &&
    comparison.priorPeriodKey == null &&
    report.forecasts.length === 0;

  return (
    <div className="space-y-3">
      {/* Coverage: stated on EVERY report, not only the incomplete ones — "all 19 repos were
          being tracked" is the sentence that makes the figure trustworthy, and it only means
          something if its absence is meaningful too. */}
      <div
        className={`rounded-md border px-2 py-1.5 text-[11px] ${
          report.coverage.complete
            ? 'border-gray-200 text-gray-500 dark:border-gray-800 dark:text-gray-400'
            : 'border-amber-300 bg-amber-50/50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300'
        }`}
      >
        {report.coverage.complete ? (
          <>
            All {report.coverage.totalRepos} repos in this workspace were already being tracked
            when this period started.
          </>
        ) : (
          <>
            <span className="font-medium">Partial coverage.</span>{' '}
            {report.coverage.trackedRepos} of {report.coverage.totalRepos} repos in this workspace
            were being tracked when this period started. The headline figures below cover the whole
            workspace as it is today, so they under-count this period relative to a later one —
            which is why the comparison is computed over the repos present in both.
          </>
        )}
      </div>

      {/* A report stored under an EARLIER metric schema simply lacks the keys added since, and
          those rows render "—" / "no prior period" rather than 0. Say why, or the blanks read as
          a bug. The report is immutable by design, so this is not something regeneration under
          the same period "fixes" silently — it produces a NEW row at the current version. */}
      {report.metricsSchemaVersion !== PERIOD_METRICS_SCHEMA_VERSION && (
        <div className="text-[11px] text-gray-400">
          Written under metric schema v{report.metricsSchemaVersion} (current is v
          {PERIOD_METRICS_SCHEMA_VERSION}) — any metric added since is blank here, not zero.
        </div>
      )}

      {report.lanes && <LanesPanel lanes={report.lanes} />}

      <Movements movements={report.movements} deltas={comparison.deltas} />

      {/* ⚠ "NOT COMPUTED" IS NOT "NO PRIOR PERIOD", and they had the same pixels.
          A BACKFILLED period (spec §8: up to 8 prior periods stored metrics-only on first
          generate — no LLM, no credits, `model: ''`) carries an EMPTY comparison and EMPTY
          forecasts by construction, not because anything was missing. Rendered through the normal
          path, every row read "no prior period" and every forecast read "—", which is a claim
          about the DATA rather than about what was run — and it invited the reader to press
          Generate on eight periods to fix something that was never broken. */}
      {isFiguresOnly && (
        <div className="rounded-md border border-gray-200 px-2 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <span className="font-medium">Figures only.</span> This period was filled in
          automatically to give the forecast some history — no comparison, forecast or write-up was
          computed for it. Generate it to compare it with the period before.
        </div>
      )}

      {/* What the PROJECTION was fitted on. Separate from the comparison's disclosure above it
          because they are different subsets answering different questions: the comparison covers
          the repos present in this period AND the prior one, the forecast covers the repos present
          across the whole SERIES. A forecast over most of a workspace is worth having; one the
          reader assumes covers all of it is not. */}
      {!isFiguresOnly && report.forecastDisclosure && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          Forecast {report.forecastDisclosure}
        </div>
      )}

      {/* The comparison's own disclosure, VERBATIM from the server. It is the one sentence that
          says which repos the deltas are actually about. */}
      {isFiguresOnly ? null : comparison.refusal ? (
        <div className="rounded-md border border-gray-200 px-2 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <span className="font-medium">No comparison.</span> {REFUSAL_TEXT[comparison.refusal]}
        </div>
      ) : (
        comparison.subsetDisclosure && (
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            Comparison {comparison.subsetDisclosure}
            {comparison.priorPeriodKey && (
              <span className={MUTED}> · vs {comparison.priorPeriodKey}</span>
            )}
          </div>
        )
      )}

      <MetricTable report={report} />

      {/* The narration. A backfilled period has none by design (metrics-only, no LLM, no
          credits) — say that plainly rather than showing an empty box. */}
      {report.narrative ? (
        <div className="rounded-md border border-violet-200/70 bg-white/60 p-3 dark:border-violet-900/50 dark:bg-gray-900/40">
          <SummaryMarkdown markdown={report.narrative} prRefs={[]} onOpenPr={() => {}} />
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-gray-200 px-2 py-1.5 text-[11px] text-gray-400 dark:border-gray-800">
          Figures only — this period has not been written up. Generating a report adds the
          narrative; the numbers above are already final.
        </div>
      )}

      <ReportChat
        workspaceId={workspaceId}
        periodKey={report.periodKey}
        suggested={report.suggested}
        disabled={outOfCredits || workspaceId == null}
        disabledReason={
          outOfCredits ? 'Out of AI credits this month — questions resume on the 1st.' : null
        }
      />
    </div>
  );
}

// ── Generation controls ──────────────────────────────────────────────────────────────────────
function GenerateControls({
  workspaceId,
  periodKey,
  hasReport,
  stale,
  reportLoading,
  modelInfo,
}: {
  workspaceId: number | null;
  periodKey: string | null;
  hasReport: boolean;
  stale: boolean;
  // The report for this period is still in flight, so we do not yet know whether the button
  // should say Generate or Regenerate. Keep it mounted (hiding it makes the layout jump) but
  // disabled — offering a BILLING action under a label we know might be wrong is worse than a
  // moment of nothing.
  reportLoading: boolean;
  // The server's model list + its pre-flight quotes. Optional on the wire (an older plugin omits
  // it), in which case the selector is hidden and no number is quoted — the SPA holds no price
  // table of its own to fall back on, deliberately.
  modelInfo: PeriodReportModelInfo | undefined;
}): JSX.Element {
  const choices = useMemo(() => periodReportModelChoices(modelInfo), [modelInfo]);
  // `null` = "whatever the account is configured for": with no explicit choice the POST body omits
  // `model` and `pro_settings.report_model` governs, which is what that setting is FOR. Picking
  // from the selector overrides it for this run only.
  const [model, setModel] = useState<string | null>(null);
  const effectiveModel = model ?? modelInfo?.model ?? null;
  const estimate = choices.find((c) => c.id === effectiveModel)?.estimate ?? null;
  const generate = useGeneratePeriodReport(workspaceId, periodKey);
  // Mount-shared in-flight state. `generate.isPending` is per-mount and resets to "Generate" the
  // moment this component remounts (a sub-tab switch mid-run), which invites a second BILLED POST
  // — the CiAnalysisCard lesson. The mutation KEY is what two mounts share.
  const running =
    useIsMutating({ mutationKey: periodReportGenerateMutationKey(workspaceId, periodKey) }) > 0;

  const usage = useAiUsage(true);
  const outOfCredits =
    usage.data?.summaryTurnLimit != null && (usage.data.summaryTurnsRemaining ?? 0) <= 0;

  const blocked =
    workspaceId == null || periodKey == null || outOfCredits || running || reportLoading;
  const result = generate.data;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {choices.length > 0 && (
          <label className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
            Model
            <select
              value={effectiveModel ?? ''}
              onChange={(e) => setModel(e.target.value)}
              disabled={running}
              className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-950"
            >
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.hint ? `${c.label} — ${c.hint}` : c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* The estimate sits BESIDE the selector and updates as it changes, so a switch that
            costs several times more is visible before the click rather than in next month's
            usage. SERVED, not computed here — the prices and the token envelope are the
            server's, and a second copy of either only ever produces a differently-wrong promise
            about money. Credits, never dollars: the app's one currency for AI spend. */}
        {estimate && (
          <span
            className="text-[11px] text-gray-400"
            title="Estimated model cost for one generation, priced by the server"
          >
            ≈ {estimate.estimatedCredits} credits
          </span>
        )}
        <button
          type="button"
          onClick={() => generate.mutate(model != null ? { model } : {})}
          disabled={blocked}
          className="rounded border border-violet-300 px-2 py-0.5 text-[11px] font-medium text-violet-600 hover:border-violet-400 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:border-violet-600"
          title={
            outOfCredits
              ? 'Out of AI credits — resets next month'
              : hasReport
                ? 'Write this period up again. The stored figures are immutable; regenerating replaces the narrative for this model.'
                : 'Compute this period and write it up. The first generation also backfills earlier periods (figures only, no AI, no credits) so the forecast has a series.'
          }
        >
          {running
            ? hasReport
              ? 'Regenerating…'
              : 'Generating…'
            : reportLoading
              ? 'Loading…'
              : hasReport
                ? stale
                  ? '↻ Regenerate'
                  : 'Regenerate'
                : 'Generate'}
        </button>
      </div>

      {generate.isError && (
        <div className="text-[11px] text-red-500">
          {(generate.error as Error)?.message ?? 'Couldn’t generate the report.'}
        </div>
      )}
      {result?.cadenceMissing && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          No sprint cadence is configured, so there is no period to report on.
        </div>
      )}
      {result?.creditsExhausted && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          Out of AI credits this month — the figures were computed and stored, but the write-up was
          skipped. Narration resumes on the 1st.
        </div>
      )}
      {/* THE ACTUAL SPEND, after the fact — the RECEIPT that pairs with the quote above, taken
          from the server's own metering (`spend`) rather than by re-quoting the estimate, which
          would only ever be the guess printed back at the reader.
          `spend` is ABSENT on a cached or credit-blocked run because neither charged anything, and
          that absence is meaningful: it renders as "nothing spent", never as 0 credits charged. A
          silent no-op button reads as broken, which is why the cache hit says so out loud.
          The remaining balance is deliberately NOT quoted at this instant: the mutation
          invalidates ['ai-usage'] and the refetch lands a moment later, so any number here would
          be the PRE-run one. Track usage (above) shows the live figure. */}
      {/* ⚠ `generated === false` is OVERLOADED and cannot stand alone as "cache hit": it is also
          false when credits ran out and when no cadence is configured, both of which already print
          their own line above. Keying the cache message on it alone put "Out of AI credits this
          month" and "Already had this one — served from cache" on screen together, which is not
          two facts but a contradiction. */}
      {result != null && !generate.isError && !result.creditsExhausted && !result.cadenceMissing && (
        <div className="text-[11px] text-gray-400">
          {result.generated === false
            ? 'Already had this one — served from cache, nothing spent.'
            : result.spend
              ? `Generated with ${result.spend.model} · ${result.spend.credits} credits${
                  usage.data?.summaryTurnLimit != null ? ' · 1 monthly summary turn' : ''
                }.`
              : `Generated with ${result.report?.model ?? effectiveModel ?? 'the default model'}.`}
        </div>
      )}
    </div>
  );
}

// ── Empty / setup states ─────────────────────────────────────────────────────────────────────
function SetupPrompt(): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
      <div className="mb-1 font-medium text-gray-700 dark:text-gray-200">
        Set a sprint cadence first
      </div>
      Reports are cut on your sprint boundary, so there is nothing to report until one is set. Open
      the header menu → <span className="font-medium">Settings</span> →{' '}
      <span className="font-medium">Sprint</span> and give it a length and a start date.
      <div className="mt-1.5 text-[11px] text-gray-400">
        There is deliberately no fallback to a rolling two weeks: a period you did not choose is
        not an artifact you would forward to anyone.
      </div>
    </div>
  );
}

function Skeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 py-1" aria-hidden="true">
      <div className="digest-skeleton-line h-3.5" style={{ width: '42%' }} />
      {['96%', '90%', '84%', '90%', '76%'].map((w, i) => (
        <div key={i} className="digest-skeleton-line h-3" style={{ width: w }} />
      ))}
    </div>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────────────────────
export function PeriodReportsPanel(): JSX.Element | null {
  const { periodReports } = useProCapabilities();
  // null until the workspaces query resolves the account's Default. Nothing workspace-scoped may
  // render — and nothing billable may fire — before then.
  const workspaceId = useFilters((s) => s.workspaceId);

  const list = usePeriodReportsList(periodReports, workspaceId);
  const periods = useMemo<PeriodReportListItem[]>(() => list.data?.periods ?? [], [list.data]);

  // The selection lives in the FILTERS STORE, not in local state, because it is URL-mirrored as
  // `?report=<periodKey>` (see hooks/useUrlState.ts) — and a link to the period you are reading is
  // the point of the artifact. `useUrlState` hydrates the store from the query string before this
  // panel mounts, so a forwarded link opens on the period it names with no module-load capture
  // trick; selecting another period writes the URL back.
  const selectedKey = useFilters((s) => s.insightsReportKey);
  const setSelectedKey = useFilters((s) => s.setInsightsReportKey);
  // Re-seat the selection when the workspace changes or the selected key is not in the list (a
  // stale link, or a period the plugin's retention has dropped). Written as an effect against the
  // RESOLVED list rather than a corrective render, so the user's own choice is never quietly
  // replaced while it is still valid.
  useEffect(() => {
    // ⚠ WAIT FOR THE LIST TO RESOLVE BEFORE TOUCHING THE SELECTION. `periods` is
    // `list.data?.periods ?? []`, so "still loading" and "this workspace has no periods" are the
    // same empty array — and clearing on the first was enough to break every forwarded link:
    // hydrate put `?report=sprint-2026-07-22` in the store, this effect ran on the cold query and
    // nulled it, and the seat below then chose `periods[0]`. The reader got the NEWEST period, the
    // URL rewrote itself to match, and nothing anywhere indicated that the link had been ignored —
    // which is worse than an error, because the page looks like it worked.
    if (list.data == null) return;
    if (periods.length === 0) {
      if (selectedKey != null) setSelectedKey(null);
      return;
    }
    if (selectedKey == null || !periods.some((p) => p.periodKey === selectedKey)) {
      setSelectedKey(periods[0]!.periodKey);
    }
  }, [list.data, periods, selectedKey, setSelectedKey]);

  const report = usePeriodReport(periodReports, workspaceId, selectedKey);

  // The capability flag and the plugin's own answer must BOTH be on. They can disagree — a stale
  // /api/me, or the plugin's `DIGEST_ENABLED` self-gate flipping — and `enabled: false` from the
  // route means "this workspace has no reports surface", which must render nothing rather than
  // the "no periods yet" empty state (that copy invites a click that cannot work).
  if (!periodReports || list.data?.enabled === false) return null;

  // Fold `isPlaceholderData` into loading everywhere: a stale window's numbers under a new
  // window's caption is a bug this codebase has already shipped once. (Neither of these queries
  // sets placeholderData today — the check is here so adding it later cannot reintroduce that.)
  const listLoading = list.isLoading || list.isPlaceholderData;
  // `selectedKey == null` counts as loading: the seating effect runs one commit after the list
  // lands, and without this the "not generated yet" box paints for that one frame on a workspace
  // that has plenty of reports.
  const reportLoading = report.isLoading || report.isPlaceholderData || selectedKey == null;

  const selected = periods.find((p) => p.periodKey === selectedKey) ?? null;
  const current = report.data?.report ?? null;

  return (
    <div className="space-y-3" data-testid="period-reports">
      {workspaceId == null || listLoading ? (
        <Skeleton />
      ) : list.data?.cadenceConfigured === false ? (
        <SetupPrompt />
      ) : periods.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          No periods yet. A report covers one completed sprint — the first one appears once a
          sprint boundary has passed with activity behind it.
        </div>
      ) : (
        <>
          {/* Period picker. Newest first; the label IS the date range, which is also the title
              below — the reader never has to decode a key to know what they are looking at. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Period
            </span>
            {periods.slice(0, 8).map((p) => {
              const on = p.periodKey === selectedKey;
              return (
                <button
                  key={p.periodKey}
                  type="button"
                  onClick={() => setSelectedKey(p.periodKey)}
                  aria-pressed={on}
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${
                    on
                      ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950/30 dark:text-violet-300'
                      : 'border-gray-300 text-gray-500 hover:border-gray-400 dark:border-gray-700 dark:text-gray-400'
                  }`}
                  title={
                    p.hasNarrative
                      ? `${p.periodKey} · written up${p.model ? ` with ${p.model}` : ''}`
                      : `${p.periodKey} · figures only, not written up`
                  }
                >
                  {shortPeriodLabel(p)}
                  {!p.coverageComplete && (
                    <span className="ml-1 text-amber-600 dark:text-amber-400" title="Partial repo coverage">
                      ◔
                    </span>
                  )}
                </button>
              );
            })}
            {periods.length > 8 && (
              <select
                value={periods.slice(0, 8).some((p) => p.periodKey === selectedKey) ? '' : (selectedKey ?? '')}
                onChange={(e) => e.target.value && setSelectedKey(e.target.value)}
                className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] dark:border-gray-700 dark:bg-gray-950"
              >
                <option value="">Earlier…</option>
                {periods.slice(8).map((p) => (
                  <option key={p.periodKey} value={p.periodKey}>
                    {shortPeriodLabel(p)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* THE TITLE IS THE DATE RANGE, with the grain named beside it. Never "monthly" and
              never "month on month" — a 14-day cadence is ~2.17 periods per calendar month, so
              that wording would be plainly false. */}
          {selected && (
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {periodTitle(selected.periodStart, selected.periodEnd)}
              </h3>
              <span className="text-[11px] text-gray-400">
                sprint · {selected.cadenceDays} days
              </span>
              {current && (
                <span className="text-[10px] text-gray-400" title={current.periodKey}>
                  {current.model ? `${current.model} · ` : ''}
                  generated {new Date(current.generatedAt).toLocaleString()}
                </span>
              )}
              {current?.stale && (
                <span
                  className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300"
                  title="The underlying data changed after this report was written. It is kept exactly as generated — a copy someone has already forwarded has to stay comparable — so regenerate if you want the newer figures."
                >
                  stale
                </span>
              )}
            </div>
          )}

          <GenerateControls
            workspaceId={workspaceId}
            periodKey={selectedKey}
            hasReport={current != null}
            stale={current?.stale === true}
            reportLoading={reportLoading}
            modelInfo={list.data?.modelInfo}
          />

          {reportLoading ? (
            <Skeleton />
          ) : report.isError ? (
            <div className="text-[11px] text-red-500">
              {(report.error as Error)?.message ?? 'Couldn’t load this report.'}
            </div>
          ) : current ? (
            // Keyed by the period so switching periods remounts the body — the chat transcript
            // and every derived map belong to ONE period and must not carry over.
            <div key={current.periodKey}>
              <ReportBody report={current} workspaceId={workspaceId} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 p-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              This period has not been generated yet. Use{' '}
              <span className="font-medium">Generate</span> above — the first run also backfills
              earlier periods with figures only, so the forecast has something to fit.
            </div>
          )}
        </>
      )}
    </div>
  );
}
