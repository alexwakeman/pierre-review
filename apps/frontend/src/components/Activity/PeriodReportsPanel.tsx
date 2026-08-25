import { Fragment, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import type {
  ActorLane,
  ActorLaneBand,
  PeriodByWorkspace,
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
  PeriodWorkspaceRow,
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
  usePeriodReportsList,
} from '../../hooks/usePeriodReports.js';
import { AdHocChatPanel } from './AdHocChatPanel.js';
import { PeriodPeopleSection } from './PeriodPeopleSection.js';
import { CopyButton } from '../CopyButton.js';
import type { Fmt, MetricMeta } from './periodReportMarkdown.js';
import {
  METRIC_META,
  REFUSAL_TEXT,
  changeFmtFor,
  figuresOnly,
  metaFor,
  pctFmt,
  periodTitle,
  renderPeriodReportMarkdown,
  rowFigures,
  signed,
  standaloneLabelFor,
} from './periodReportMarkdown.js';
import { PALETTE, fmtDuration } from '../charts/common.js';

// Re-exported for periodMetricRow.test.ts, which pins the one-population row rule through this
// module's public surface (the definition moved to periodReportMarkdown.ts with the rest of the
// presentation metadata).
export { rowFigures } from './periodReportMarkdown.js';
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
// The labels, formatters, refusal copy and the one-population row rule moved to
// `periodReportMarkdown.ts` — ONE definition serving both this panel and the "Copy as Markdown"
// export, so the copied artifact can never disagree with the screen it was copied from.
// `rowFigures` is re-exported below for its unit test (periodMetricRow.test.ts).

function shortPeriodLabel(p: PeriodReportListItem): string {
  return periodTitle(p.periodStart, p.periodEnd);
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
      className="text-[11px] text-ai-signal"
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

// ── The "By workspace" axis (C4 — Compare workspaces folded into Reports) ────────────────────
//
// One metric, every workspace: the expansion under a metric row showing that metric's value per
// workspace for the viewed period and the one before it. This replaced the standalone "Compare
// workspaces" matrix, and it inherits Reports' honesty rules wholesale:
//
//  • ⚠ ONE POPULATION PER ROW. A workspace's current and prior figures are BOTH its full
//    membership (the server computes no coverage-stable subset at this grain), so the subtraction
//    is legitimate — and the onboarded-mid-window honesty travels as the row's own coverage
//    annotation (◔), the same disclosure the headline report carries. The headline table's
//    subset figures must never leak into these rows, nor these into it.
//  • ⚠ The ◔ reads BOTH windows' coverage, not just the current row's. Coverage is measured at
//    each window's own START, and tracking is monotone (`repos.createdAt <= atMs`), so the
//    COMMON biased case is prior-partial-with-current-complete — repos onboarded between the
//    two window starts make the prior figure under-count and the raw change over-state growth,
//    with nothing visibly wrong on the current side. That is the 39→570 onboarding artifact at
//    workspace grain; annotating only `row.coverage` missed it entirely.
//  • The change is the RAW difference, muted and un-arrowed: no significance test runs at
//    workspace grain, and a percentage off an untested base is noise wearing a suit.
//  • `null` renders "—", never 0. "No prior period" renders as such, never as a zero column.
//  • ⚠ NO MONEY. The vector carries no cost key and this axis must never grow one — a bot's
//    price is per workspace and cross-workspace surfaces cannot even total it honestly.
function WorkspaceAxis({
  axis,
  metricKey,
  meta,
}: {
  axis: PeriodByWorkspace;
  metricKey: PeriodMetricKey;
  meta: MetricMeta;
}): JSX.Element {
  const priorBy =
    axis.prior == null ? null : new Map(axis.prior.map((r) => [r.workspaceId, r]));
  const cellFor = (row: PeriodWorkspaceRow | undefined): PeriodMetricValue | undefined =>
    row?.metrics.find((m) => m.key === metricKey);
  const changeFmt = changeFmtFor(meta);
  return (
    <div className="space-y-0.5">
      <div className="grid grid-cols-[minmax(8rem,16rem)_5.5rem_5.5rem_1fr] items-baseline gap-2 text-[9px] uppercase tracking-wide text-gray-400">
        <span>Workspace</span>
        <span className="text-right">This period</span>
        <span className="text-right">Prior</span>
        <span>Change</span>
      </div>
      {axis.current.map((row) => {
        const cur = cellFor(row);
        const priorRow = priorBy?.get(row.workspaceId);
        const prior = priorBy == null ? undefined : cellFor(priorRow);
        const value = cur?.value ?? null;
        const priorValue = prior?.value ?? null;
        const delta = value != null && priorValue != null ? value - priorValue : null;
        // Coverage honesty must consider BOTH windows. Since tracking is monotone, a partial
        // current side implies a partial prior side (when a prior row exists) — so the three
        // reachable annotated states are: prior-only partial (repos onboarded between the two
        // window starts — the change over-states growth), both partial (both under-count), and
        // current partial with no prior period at all.
        const curPartial = !row.coverage.complete;
        const priorCov = priorRow?.coverage;
        const priorPartial = priorCov != null && !priorCov.complete;
        const coveragePartial = curPartial || priorPartial;
        const coverageTitle =
          curPartial && priorPartial
            ? `Partial coverage in both windows: ${row.coverage.trackedRepos} of ${row.coverage.totalRepos} repos in this workspace were tracked when this period started, and ${priorCov.trackedRepos} when the prior one did — both figures under-count, and the change mixes two different memberships.`
            : priorPartial
              ? `Partial prior coverage: the prior period started before ${priorCov.totalRepos - priorCov.trackedRepos} of ${priorCov.totalRepos} repos in this workspace were tracked, so the prior figure under-counts and the change over-states growth.`
              : `Partial coverage: ${row.coverage.trackedRepos} of ${row.coverage.totalRepos} repos in this workspace were being tracked when this period started, so its figures under-count the period.`;
        return (
          <div
            key={row.workspaceId}
            className="grid grid-cols-[minmax(8rem,16rem)_5.5rem_5.5rem_1fr] items-baseline gap-2 text-[11px]"
          >
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="truncate text-gray-600 dark:text-gray-300">{row.name}</span>
              {row.isDefault && <span className="shrink-0 text-[9px] text-gray-400">default</span>}
              {/* Per-workspace coverage honesty — the same disclosure the headline report makes,
                  where THIS workspace's repos onboarded mid-window. Without it a freshly-onboarded
                  workspace's small figures read as a quiet team rather than a short observation.
                  Renders when EITHER window's coverage is partial — the title names which window
                  under-counts, because a complete current window over a partial prior one is a
                  change biased UPWARD, not a clean row. */}
              {coveragePartial && (
                <span
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                  title={coverageTitle}
                >
                  ◔
                </span>
              )}
            </span>
            <span className="text-right tabular-nums text-gray-700 dark:text-gray-200">
              {value == null ? '—' : meta.format(value)}
              {cur?.lowSample && value != null && (
                <span
                  className="ml-0.5 align-super text-[9px] text-amber-600 dark:text-amber-400"
                  title={`Thin sample — ${cur.sampleSize} item${cur.sampleSize === 1 ? '' : 's'} behind this figure.`}
                  aria-label="thin sample"
                >
                  ▵
                </span>
              )}
            </span>
            <span className="text-right tabular-nums text-gray-400">
              {priorValue == null ? '—' : meta.format(priorValue)}
            </span>
            {axis.prior == null ? (
              <span className={`text-[10px] ${MUTED}`} title="Nothing exists for the period before this one on the cadence grid">
                no prior period
              </span>
            ) : priorValue == null || value == null ? (
              <span
                className={`text-[10px] ${MUTED}`}
                title="One side has no figure for this metric in this workspace, so there is nothing to subtract"
              >
                {value == null && priorValue == null ? '—' : 'no prior figure'}
              </span>
            ) : delta === 0 ? (
              <span className={`text-[10px] ${MUTED}`}>no change</span>
            ) : (
              <span
                className={`text-[10px] ${MUTED}`}
                title={
                  coveragePartial
                    ? 'Raw change — coverage-biased: one window was only partially tracked (see ◔), so this difference mixes memberships. No significance test is run at workspace grain, so no percentage and no verdict colour.'
                    : "Raw change over this workspace's full membership — no significance test is run at workspace grain, so no percentage and no verdict colour"
                }
              >
                {signed(delta!, changeFmt)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── The metric table ─────────────────────────────────────────────────────────────────────────
function MetricTable({
  report,
  byWorkspace,
}: {
  report: PeriodReport;
  // The optional per-workspace axis off the RESPONSE (not the stored report): null on older
  // plugins, single-workspace accounts and stored-report-only renders — all of which must render
  // the table exactly as before, expander-less. Absence, never an error.
  byWorkspace: PeriodByWorkspace | null;
}): JSX.Element {
  // Which metric rows are expanded to their per-workspace breakdown (the C4 axis). Local and
  // transient on purpose: an expansion is a reading gesture, not a filter worth a URL or the
  // store. Hook sits above every early-return-free map (hooks-order rule).
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<PeriodMetricKey>>(new Set());
  const toggleExpanded = (key: PeriodMetricKey): void => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
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
            const wsOpen = byWorkspace != null && expandedKeys.has(key);
            return (
              <Fragment key={key}>
              <tr className="border-b border-gray-100 last:border-0 dark:border-gray-900">
                <td className="py-1.5 pr-3 align-top">
                  <div className="font-medium text-gray-700 dark:text-gray-200">{meta.label}</div>
                  {meta.note && <div className="text-[10px] text-gray-400">{meta.note}</div>}
                  {/* The C4 expander. Only rendered when the response carries the axis — the
                      server already omits it for single-workspace accounts, older plugins send
                      nothing, and in both cases this row is byte-identical to the pre-axis one. */}
                  {byWorkspace != null && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(key)}
                      aria-expanded={wsOpen}
                      className="mt-0.5 text-[10px] text-sky-600 hover:underline dark:text-sky-400"
                      title="This metric, per workspace, for this period and the prior one"
                    >
                      {wsOpen ? '▾' : '▸'} By workspace
                    </button>
                  )}
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
              {wsOpen && byWorkspace != null && (
                <tr className="border-b border-gray-100 last:border-0 dark:border-gray-900">
                  <td colSpan={6} className="bg-gray-50/60 py-1.5 pl-4 pr-3 dark:bg-gray-900/30">
                    <WorkspaceAxis axis={byWorkspace} metricKey={key} meta={meta} />
                  </td>
                </tr>
              )}
              </Fragment>
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
        // metaFor, not a direct index: movements ride the report array, and a stale row stored
        // under an older schema version can carry keys the current vocabulary renamed away.
        const meta = metaFor(m.key);
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

// ── "Ask about this period" — the ad-hoc chat, grounded in THIS period (plan C5) ────────────
//
// The ad-hoc chat (pins, history, @-mentions, optional chart + bot-performance passes) moved
// here from the deleted Insights Overview tab. It mounts EXPANDED under the report — the
// conversation is the report's follow-up surface, and a collapsed one-line toggle proved to be
// where the feature went to die — with the toggle kept for readers who want the report alone
// (the collapse is session-local, like the panel's other disclosure state). The `periodWindow` prop
// carries the viewed period's exact [fromMs, toMs) (`periodStart`/`periodEnd` ARE those bounds,
// ISO-serialised), which `useSprintChat` sends as `SprintChatBody.window`, so every answer is
// grounded in the period on screen rather than a trailing window ending now.
//
// This REPLACED the old `ReportChat` (the pill-driven drill-down grounded in the stored report
// JSON via `usePeriodReportChat`): two chats titled "Ask about this period" on one report was a
// coherence bug waiting to ship, and this one is a strict superset of what a reader could do
// there. Its suggested pills are templated CLIENT-SIDE from the report's own significant deltas —
// the numbers in a pill are computed (the same `signed`/`changeFmtFor` the table renders), never
// model-authored (D4).
//
// Gated on `activityDigest` exactly as the panel gates itself: absent → the section renders
// nothing (free posture — absence, never an error). The transcript/draft live in the filters
// store keyed by WORKSPACE, so an answer asked under one period can survive into another
// period's view — the answer's own window caption ("Report period · 5 Aug – 19 Aug") is the
// existing defence, stating what it covered.
function AskAboutPeriod({ report }: { report: PeriodReport }): JSX.Element | null {
  const { activityDigest } = useProCapabilities();
  const [open, setOpen] = useState(true);
  if (!activityDigest) return null;
  const fromMs = Date.parse(report.periodStart);
  const toMs = Date.parse(report.periodEnd);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return (
    <div className="border-t border-gray-200 pt-2 dark:border-gray-800 print:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        title="Ask free-form questions grounded in this period's data (Pro, runs your configured report model)"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        Ask about this period
      </button>
      {open && (
        <div className="mt-2">
          <AdHocChatPanel
            periodWindow={{ fromMs, toMs }}
            periodLabel={periodTitle(report.periodStart, report.periodEnd)}
            suggestedQuestions={suggestedDeltaQuestions(report)}
          />
        </div>
      )}
    </div>
  );
}

// The chat's suggested pills, derived from the viewed report's SIGNIFICANT deltas and templated
// client-side: "Why did Merged PRs by people fall −33 (−22%)?". Allowed under D4 because every
// number here is computed — the label, verb and figures come from the same METRIC_META
// formatters the table rows use (`standaloneLabelFor`, because a pill has no neighbouring row to
// lean on). Biggest absolute movers first, capped like the Movements strip.
function suggestedDeltaQuestions(report: PeriodReport): { label: string; question: string }[] {
  return report.comparison.deltas
    .filter((d) => d.significant && d.absoluteChange != null && d.absoluteChange !== 0)
    .sort((a, b) => Math.abs(b.absoluteChange!) - Math.abs(a.absoluteChange!))
    .slice(0, 4)
    .map((d) => {
      const meta = metaFor(d.key); // report array — old-vocabulary keys possible on stale rows
      const verb = d.absoluteChange! > 0 ? 'rise' : 'fall';
      const change = signed(d.absoluteChange!, changeFmtFor(meta));
      const pct = d.percentChange != null ? ` (${signed(d.percentChange, pctFmt)})` : '';
      const name = standaloneLabelFor(meta);
      return {
        label: `Why did ${name} ${verb} ${change}?`,
        question: `Why did ${name} ${verb} ${change}${pct} over this period? Point to the PRs, repos or people in the data that explain the movement.`,
      };
    });
}

// ── The report body ──────────────────────────────────────────────────────────────────────────
function ReportBody({
  report,
  byWorkspace,
}: {
  report: PeriodReport;
  // The C4 "By workspace" axis, off the RESPONSE (computed live, never stored on the report).
  byWorkspace: PeriodByWorkspace | null;
}): JSX.Element {
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

      <MetricTable report={report} byWorkspace={byWorkspace} />

      {/* The narration. A backfilled period has none by design (metrics-only, no LLM, no
          credits) — say that plainly rather than showing an empty box. */}
      {report.narrative ? (
        <div className="rounded-md border border-ai-hairline bg-white/60 p-3 dark:bg-gray-900/40">
          <SummaryMarkdown markdown={report.narrative} prRefs={[]} onOpenPr={() => {}} />
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-gray-200 px-2 py-1.5 text-[11px] text-gray-400 dark:border-gray-800">
          Figures only — this period has not been written up. Generating a report adds the
          narrative; the numbers above are already final.
        </div>
      )}

      <AskAboutPeriod report={report} />
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
          className="rounded border border-ai-border px-2 py-0.5 text-[11px] font-medium text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2 disabled:opacity-50"
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

  // The "Copy as Markdown" text — the report rendered by the deterministic exporter, built from
  // the SAME METRIC_META/REFUSAL_TEXT/rowFigures this panel renders (periodReportMarkdown.ts).
  // Hook sits above the capability early-return (hooks-order rule); empty string ⇒ CopyButton
  // renders nothing.
  const reportMarkdown = useMemo(() => {
    const r = report.data?.report;
    // try/catch, not trust: this memo runs during render with no error boundary above it, so a
    // renderer defect on one stored row (it happened — a stale v1 row's renamed metric key)
    // must degrade to "no copy button" ('' ⇒ CopyButton renders nothing), never blank the pane.
    try {
      return r ? renderPeriodReportMarkdown(r, PERIOD_METRICS_SCHEMA_VERSION) : '';
    } catch (err) {
      console.error('period report markdown failed', err);
      return '';
    }
  }, [report.data]);

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
    // `data-print-report` scopes the @media print stylesheet (index.css): printing the Reports
    // pane prints THIS subtree — title, coverage, figures table, forecast, narrative — with the
    // rail/tabs/chat/buttons hidden and light colors forced. Print-to-PDF is the board-pack path.
    <div className="space-y-3" data-testid="period-reports" data-print-report>
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
          <div className="flex flex-wrap items-center gap-1.5 print:hidden">
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
                      ? 'border-ai-signal/50 bg-ai-signal/10 text-ai-signal'
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
              {/* Copy the whole report as markdown — the forwardable artifact (plan N3). The text
                  is the deterministic export above; an empty string (no report yet) renders no
                  button at all, per CopyButton's own contract. */}
              <CopyButton text={reportMarkdown} what="report as Markdown" className="print:hidden" />
            </div>
          )}

          {/* Generation is a screen affordance, not part of the printed artifact. */}
          <div className="print:hidden">
          <GenerateControls
            workspaceId={workspaceId}
            periodKey={selectedKey}
            hasReport={current != null}
            stale={current?.stale === true}
            reportLoading={reportLoading}
            modelInfo={list.data?.modelInfo}
          />
          </div>

          {reportLoading ? (
            <Skeleton />
          ) : report.isError ? (
            <div className="text-[11px] text-red-500">
              {(report.error as Error)?.message ?? 'Couldn’t load this report.'}
            </div>
          ) : current ? (
            // Keyed by the period so switching periods remounts the body — the chat transcript
            // and every derived map belong to ONE period and must not carry over (including the
            // by-workspace expansions, which are per-period readings too).
            <div key={current.periodKey}>
              <ReportBody report={current} byWorkspace={report.data?.byWorkspace ?? null} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 p-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              This period has not been generated yet. Use{' '}
              <span className="font-medium">Generate</span> above — the first run also backfills
              earlier periods with figures only, so the forecast has something to fit.
            </div>
          )}

          {/* People (plan P4.2, now the People-report picker): pick people AND bots from the
              WORKSPACE's own membership, then "Begin report" opens the people-report tab for
              the period selected above (via `insightsReportKey`). Alphabetical, metric-free,
              never a leaderboard. */}
          <PeriodPeopleSection />
        </>
      )}
    </div>
  );
}
