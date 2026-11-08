import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  ACTOR_LANES,
  ACTOR_LANE_BAND,
  PERIOD_METRIC_KEYS,
  type ActorLane,
  type ActorLaneBand,
  type PeriodGrain,
  type PeriodLaneStats,
  type PeriodLanes,
  type PeriodMetricKey,
  type PeriodRefusalReason,
  type PeriodSeriesPoint,
  type PeriodSeriesResponse,
} from '@pierre-review/shared';
import { useFilters } from '../../store/filters.js';
import { usePeriodSeries } from '../../hooks/usePeriodReports.js';
import {
  PERIOD_SERIES_DEFAULT_METRICS,
  PERIOD_UNIT_WORDS,
  changeAxis,
  changeLabel,
  changeSeries,
  deltaOf,
  metricOf,
  projectionIn,
  seriesMarkdown,
  toggleMetric,
  unitGroups,
  valuesOf,
} from '../../lib/periodSeries.js';
import { CopyButton } from '../CopyButton.js';
import { InfoButton } from '../InfoModal.js';
import { ThinSampleIcon } from '../Icons.js';
import { FOCUS_RING } from '../ui/index.js';
import { METRIC_META, metaFor, periodTitle, signed, changeFmtFor } from './periodMetricMeta.js';
import { PALETTE, SERIES_COLORS, fmtDuration, niceMax } from '../charts/common.js';
import { PeriodSeriesChart, type PeriodChartLine } from './PeriodSeriesChart.js';


// REPORTS → PERIOD REPORTS (docs/FRONTEND.md § Period reports; docs/PERIOD-REPORTING.md § The series).
// CODE ONLY: nothing here calls a model (the AI write-up and its Generate button were removed
// 2026-11-08). ONE read, `usePeriodSeries`: every completed period of the last 12 weeks (sprint
// grain) or 6 months (month grain), all over ONE repo set, plus the projection for the period in
// progress. Top to bottom: Grain · Show as (Change | Values) · Copy as Markdown, the metric chips
// (Merged PRs on at first), the repo line, the CHART — one shaded band per period, a popover per
// band, a click selects the period — and Effort vs automation for the selected period.
//
// ⚠ THE HONESTY RULES STILL HOLD, in fewer words: a null is "—" and a gap in the line, never 0; a
// change off a thin or empty baseline is REFUSED (`changeSeries`), not drawn; an insignificant
// change shows the figures, not a percentage (the server's `significant`, never re-derived here);
// a refused projection names its reason; and Values never put two units on one axis.

const MAX_METRICS = 6;

/** Why there is no projection, in one short line. */
const NO_PROJECTION: Partial<Record<PeriodRefusalReason, string>> = {
  insufficient_history: 'Not enough periods to project.',
  too_volatile: 'Too uneven to project.',
  uneven_periods: 'No projection for calendar months: their lengths differ.',
};

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
    note: 'CLA, triage, labels, stale, size reports',
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
    return <div className="h-2 w-full rounded-ui bg-ui-raise" title="nothing in this period" />;
  }
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-ui">
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

/** The "i" beside "Effort vs automation": what each lane holds. Touch readers cannot reach the
 *  legend chips' `title=`, so the lane meanings are spelled out here too. */
function LanesInfo(): JSX.Element {
  return (
    <>
      <p>
        Who did the work this period: merged pull requests, review comments and approvals, split by
        who did each one.
      </p>
      <dl className="space-y-1.5">
        {ACTOR_LANES.map((lane) => (
          <div key={lane}>
            <dt className="font-medium text-ui-ink">{LANE_META[lane].label}</dt>
            <dd>{LANE_META[lane].note}.</dd>
          </div>
        ))}
      </dl>
      <p>
        The line under the bars groups merges three ways: by people, by automation that writes code
        (code agents, dependency bots, release automation), and by automation that only responds
        (AI review, quality gates, housekeeping). A group with no merges is left out.
      </p>
      <p>The legend lists only lanes that did something this period.</p>
      <p>
        “First review by a person” is the same figure as the chart’s “Time to first review by a
        person”. Bot approvals do not count.
      </p>
    </>
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
    <div className="space-y-2 rounded-ui px-3 py-2.5 bg-ui-surface">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="flex items-center gap-1">
          <span className="text-meta font-medium text-ui-ink">
            Effort vs automation
          </span>
          <InfoButton title="Effort vs automation">
            <LanesInfo />
          </InfoButton>
        </span>
        {lanes.automationMergeSharePct != null && (
          <span className="text-meta text-ui-mute">
            {/* THE headline. One number that reframes every throughput figure above it. */}
            {lanes.automationMergeSharePct}% of merges were automated
          </span>
        )}
      </div>

      {axes.map((axis) => {
        const total = lanes.lanes.reduce((n, l) => n + axis.pick(l), 0);
        return (
          <div key={axis.key} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2">
            <span className="text-meta text-ui-mute">{axis.label}</span>
            <LaneBar
              parts={order.map((lane) => ({ lane, n: axis.pick(byLane.get(lane) ?? ({} as PeriodLaneStats) ) || 0 }))}
              total={total}
            />
            <span className="text-right text-meta tabular-nums text-ui-faint">{total}</span>
          </div>
        );
      })}

      {/* THE BAND ROLLUP — the one line most readers will take away. Three groups, because the
          actionable question is not "which of seven" but "did people write this, did a machine
          write it, or did a machine only comment on it". Rendered only when something merged;
          a share of nothing is not 0%. */}
      {mergeTotal > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-meta text-ui-mute">
          {(['people', 'authors', 'responds'] as ActorLaneBand[]).map((band) => {
            const n = bandMerges(band);
            // `responds` is ~always 0 merges by construction (a reviewer does not author), so it
            // would render as a permanent "0%" that looks like a broken measurement. Dropping a
            // zero band is the same rule as dropping an inactive lane from the legend.
            if (n === 0) return null;
            return (
              <span key={band}>
                <span className="font-medium text-ui-mute">
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
            className="flex items-center gap-1 text-meta text-ui-mute"
          >
            <span className="h-2 w-2 rounded-ui" style={{ backgroundColor: LANE_META[lane].hex }} />
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
        <div className="text-meta text-ui-warn">
          No AI review comments this period, though automation is set up. Check it is still running.
        </div>
      )}

      {/* The human figures the blended table above cannot show. `fmtDuration`, not a raw number:
          an unformatted 5.484166666666667h is how a panel about honesty starts looking careless. */}
      {human != null && (human.medianPrSizeLines != null || human.medianLeadTimeHours != null) && (
        <div className="text-meta text-ui-faint">
          Pull requests by people
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
        <div className="text-meta text-ui-faint">
          First review by a person: {fmtDuration(lanes.medianTimeToFirstHumanReviewHours)} at the
          median.
        </div>
      )}
    </div>
  );
}

// ── Empty / setup states ─────────────────────────────────────────────────────────────────────
function SetupPrompt(): JSX.Element {
  return (
    <div className="rounded-ui p-4 text-meta text-ui-mute bg-ui-surface">
      <div className="mb-1 font-medium text-ui-ink">
        Set a sprint cadence first
      </div>
      Sprint reports follow this workspace’s sprints. Set a sprint length and start date in{' '}
      <span className="font-medium">Settings → Sprint cadence and comparison window</span>, or
      switch to <span className="font-medium">Month</span>, which needs no setting.
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

type Mode = 'change' | 'values';

/** A metric's name standing alone: the table's "…by people" rows read "Merged PRs by people". */
function metricName(k: PeriodMetricKey): string {
  const label = metaFor(k).label;
  if (!label.startsWith('…')) return label;
  const parent: PeriodMetricKey = k === 'human_merged_prs' ? 'merged_prs' : 'median_pr_size_lines';
  return `${metaFor(parent).label} ${label.slice(1)}`;
}

const bandTitle = (p: Pick<PeriodSeriesPoint, 'periodStart' | 'periodEnd'>, grain: PeriodGrain): string =>
  periodTitle(p.periodStart, p.periodEnd, grain);
/** Under a narrow band: the start date only ("18 Aug"), or the month's short name. */
const bandShort = (startIso: string, grain: PeriodGrain): string =>
  new Date(startIso).toLocaleDateString(undefined, grain === 'month' ? { month: 'short', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });

function PeriodReportsInfo(): JSX.Element {
  return (
    <>
      <p>
        Each band is one completed period: a sprint at this workspace’s sprint length (the last 12 weeks), or a calendar month
        (the last 6). The hatched band is the period in progress, with the projection for it.
      </p>
      <p>
        Every period is measured over the same repos: the ones tracked since the first period shown. A repo added later is left
        out, so a line shows the work, not the repos being added.
      </p>
      <p>
        <span className="font-medium">Change</span> shows each metric as the change from its first period with enough data, so
        metrics of any size compare on one chart. <span className="font-medium">Values</span> shows the figures, one chart per unit.
      </p>
      <p>Hover or tap a band for its figures. Select one to see its effort vs automation.</p>
      <p>Months run 28 to 31 days, so months have no projection.</p>
    </>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string, string][]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-0.5 text-meta text-ui-mute">{label}</span>
      {options.map(([v, text, hint]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          title={hint}
          className={`inline-flex h-7 items-center rounded-ui px-2.5 text-body touch:h-10 ${FOCUS_RING} ${
            value === v ? 'bg-ui-sel text-ui-ink' : 'bg-ui-surface text-ui-mute hover:bg-ui-hover hover:text-ui-ink'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function MetricChips({ picked, colorOf, onToggle }: { picked: PeriodMetricKey[]; colorOf: (k: PeriodMetricKey) => string; onToggle: (k: PeriodMetricKey) => void }): JSX.Element {
  const full = picked.length >= MAX_METRICS;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Metrics" data-testid="period-metric-chips">
      {PERIOD_METRIC_KEYS.map((k) => {
        const on = picked.includes(k);
        const meta = METRIC_META[k];
        const name = metricName(k);
        return (
          <button
            key={k}
            type="button"
            data-metric={k}
            aria-pressed={on}
            disabled={!on && full}
            title={!on && full ? `Up to ${MAX_METRICS} at once` : meta.note}
            onClick={() => onToggle(k)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-ui px-2 text-meta touch:h-10 disabled:opacity-50 ${FOCUS_RING} ${
              on ? 'bg-ui-sel font-medium text-ui-ink' : 'bg-ui-surface text-ui-mute hover:bg-ui-hover hover:text-ui-ink'
            }`}
          >
            <span aria-hidden className="decorative-mark h-2 w-2 rounded-[2px]" style={on ? { background: colorOf(k) } : { border: `1.5px solid ${PALETTE.gray}` }} />
            {name}
          </button>
        );
      })}
    </div>
  );
}

/** One band's figures in its popover: the value, a thin-sample mark, the change vs the period before. */
function BandFigures({ point, keys, since }: { point: PeriodSeriesPoint; keys: PeriodMetricKey[]; since?: (k: PeriodMetricKey) => string | null }): JSX.Element {
  return (
    <ul className="space-y-1.5">
      {keys.map((k) => {
        const meta = metaFor(k);
        const m = metricOf(point, k);
        const d = deltaOf(point, k);
        return (
          <li key={k}>
            <div className="font-medium text-ui-ink">{metricName(k)}</div>
            <div className="tabular-nums text-ui-mute">
              <span className="text-ui-ink">{m?.value == null ? '—' : meta.format(m.value)}</span>
              {m?.lowSample === true && m.value != null && (
                <span className="ml-1 text-ui-warn" aria-label="thin sample" title={`${m.sampleSize} item${m.sampleSize === 1 ? '' : 's'} behind this figure`}>
                  <ThinSampleIcon />
                </span>
              )}
              {/* vs the period before: a percentage only when the server calls the change significant. */}
              {d?.prior != null && d.value != null && d.absoluteChange != null && (
                <span>
                  {' · '}
                  {d.significant && d.percentChange != null ? changeLabel(d.percentChange) : signed(d.absoluteChange, changeFmtFor(meta))} vs the
                  period before
                </span>
              )}
            </div>
            {since?.(k) != null && <div className="text-ui-faint">{since(k)}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function ProjectionFigures({ series, keys }: { series: PeriodSeriesResponse; keys: PeriodMetricKey[] }): JSX.Element {
  return (
    <ul className="space-y-1.5">
      {keys.map((k) => {
        const meta = metaFor(k);
        const f = series.forecasts.find((x) => x.key === k);
        return (
          <li key={k}>
            <div className="font-medium text-ui-ink">{metricName(k)}</div>
            <div className="tabular-nums text-ui-mute">
              {f?.available ? (
                <>
                  <span className="text-ui-ink">{meta.format(f.point)}</span> projected · {meta.format(f.low)}–{meta.format(f.high)}
                </>
              ) : (
                (f != null && NO_PROJECTION[f.reason]) ?? 'No projection.'
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PeriodReportsPanel(): JSX.Element | null {
  // null until the workspaces query resolves the account's Default: nothing workspace-scoped renders.
  const workspaceId = useFilters((s) => s.workspaceId);
  // The grain is a READING choice (store + `?reportGrain=`), never the sprint-cadence setting.
  const grain = useFilters((s) => s.insightsReportGrain);
  const setGrain = useFilters((s) => s.setInsightsReportGrain);
  // The selected period (store + `?report=`): Effort vs automation follows it.
  const selectedKey = useFilters((s) => s.insightsReportKey);
  const setSelectedKey = useFilters((s) => s.setInsightsReportKey);
  const [mode, setMode] = useState<Mode>('change');
  const [picked, setPicked] = useState<PeriodMetricKey[]>(() => [...PERIOD_SERIES_DEFAULT_METRICS]);
  const q = usePeriodSeries(workspaceId, grain);
  const series = q.data ?? null;
  const periods = useMemo(() => series?.periods ?? [], [series]);

  // Seat the selection on the newest period when it names none of these (a new grain, a stale link).
  useEffect(() => {
    if (series == null || periods.length === 0) return;
    if (selectedKey == null || !periods.some((p) => p.periodKey === selectedKey)) setSelectedKey(periods[periods.length - 1]!.periodKey);
  }, [series, periods, selectedKey, setSelectedKey]);
  const selected = Math.max(0, periods.findIndex((p) => p.periodKey === selectedKey));

  const colorOf = (k: PeriodMetricKey): string => SERIES_COLORS[picked.indexOf(k) % SERIES_COLORS.length] ?? PALETTE.blue;
  const change = useMemo(() => new Map(picked.map((k) => [k, changeSeries(periods, k)] as const)), [picked, periods]);
  const refusedBaseline = picked.filter((k) => change.get(k)?.base == null);

  const markdown = useMemo(() => {
    if (series == null || periods.length === 0) return '';
    try {
      return seriesMarkdown(periods, picked, metricName, (k, v) => metaFor(k).format(v), (p) => bandTitle(p, grain), series.repos);
    } catch {
      return '';
    }
  }, [series, periods, picked, grain]);

  if (series?.enabled === false) return null;
  const bands = periods.map((p) => ({ key: p.periodKey, label: bandTitle(p, grain), short: bandShort(p.periodStart, grain) }));
  const next = series?.next != null && periods.length > 0 ? { label: bandTitle(series.next, grain), short: bandShort(series.next.periodStart, grain) } : null;
  const nextLabel = series?.next != null ? bandTitle(series.next, grain) : '';

  const chartFor = (keys: PeriodMetricKey[], testId: string): JSX.Element => {
    const lines: PeriodChartLine[] = keys.map((k) => {
      const c = change.get(k)!;
      return {
        key: k,
        label: metricName(k),
        color: colorOf(k),
        values: mode === 'change' ? c.values : valuesOf(periods, k),
        projection: projectionIn(series?.forecasts.find((f) => f.key === k), mode, c.base),
      };
    });
    const all = lines.flatMap((l) => [...l.values, l.projection?.low ?? null, l.projection?.high ?? null]);
    let domain: { min: number; max: number };
    let ticks: number[];
    let formatTick: (v: number) => string;
    if (mode === 'change') {
      const axis = changeAxis(all);
      domain = { min: axis.min, max: axis.max };
      ticks = axis.ticks;
      formatTick = (v) => changeLabel(v);
    } else {
      const max = niceMax(Math.max(0, ...all.filter((v): v is number => v != null)));
      domain = { min: 0, max };
      ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
      const fmt = metaFor(keys[0]!).format;
      formatTick = (v) => (keys[0]!.endsWith('_hours') ? fmtDuration(v) : fmt(v));
    }
    return (
      <PeriodSeriesChart
        testId={testId}
        bands={bands}
        next={next}
        lines={lines}
        domain={domain}
        ticks={ticks}
        formatTick={formatTick}
        zeroRule={mode === 'change'}
        selected={selected}
        onSelect={(i) => setSelectedKey(periods[i]!.periodKey)}
        bandLabel={(i) => (i < periods.length ? bands[i]!.label : nextLabel)}
        popover={(i) =>
          i < periods.length ? (
            <>
              <div className="mb-1 font-semibold text-ui-ink">{bands[i]!.label}</div>
              <BandFigures
                point={periods[i]!}
                keys={keys}
                since={(k) => {
                  if (mode !== 'change') return null;
                  const c = change.get(k);
                  const v = c?.values[i];
                  return c?.base != null && v != null && c.base.index !== i ? `${changeLabel(v)} since ${bands[c.base.index]!.label}` : null;
                }}
              />
            </>
          ) : series != null ? (
            <>
              <div className="mb-1 font-semibold text-ui-ink">{nextLabel} · in progress</div>
              <ProjectionFigures series={series} keys={keys} />
            </>
          ) : null
        }
      />
    );
  };

  return (
    <div className="space-y-3" data-testid="period-reports" data-print-report>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 print:hidden">
        <Segmented
          label="Grain"
          value={grain}
          onChange={setGrain}
          options={[
            ['sprint', 'Sprint', 'The last 12 weeks, at this workspace’s sprint length'],
            ['month', 'Month', 'The last 6 calendar months'],
          ]}
        />
        <Segmented
          label="Show as"
          value={mode}
          onChange={setMode}
          options={[
            ['change', 'Change', 'Each metric as the change from its first period, so any metrics compare on one chart'],
            ['values', 'Values', 'The figures, one chart per unit'],
          ]}
        />
        <span className="flex items-center gap-1">
          <InfoButton title="Period reports" className="text-ui-mute hover:text-ui-ink">
            <PeriodReportsInfo />
          </InfoButton>
          <CopyButton text={markdown} what="periods as Markdown" />
        </span>
      </div>

      {workspaceId == null || q.isLoading ? (
        <Skeleton />
      ) : q.isError ? (
        <div className="text-meta text-ui-danger">Couldn’t load the periods.</div>
      ) : series?.cadenceConfigured === false ? (
        <SetupPrompt />
      ) : periods.length === 0 ? (
        <div className="rounded-ui p-4 text-meta text-ui-mute bg-ui-surface">
          {grain === 'month' ? 'No completed months with tracked repos yet.' : 'No completed sprints with tracked repos yet.'}
        </div>
      ) : (
        <>
          <MetricChips picked={picked} colorOf={colorOf} onToggle={(k) => setPicked((p) => toggleMetric(p, k))} />
          <p data-testid="period-series-repos" className="text-meta text-ui-mute">
            {series!.repos.measured === series!.repos.total
              ? `All ${series!.repos.total} repos.`
              : `${series!.repos.measured} of ${series!.repos.total} repos: the ones tracked across every period.`}
            {series!.forecastDisclosure != null && ` Projection ${series!.forecastDisclosure}.`}
          </p>
          {mode === 'change' ? (
            <div className="rounded-ui bg-ui-bg">
              {chartFor(picked.filter((k) => change.get(k)?.base != null), 'period-chart')}
              {refusedBaseline.length > 0 && (
                <p data-testid="period-no-baseline" className="mt-1 text-meta text-ui-mute">
                  No baseline for {refusedBaseline.map(metricName).join(', ')}: no period has enough data. Show as Values to see
                  the figures.
                </p>
              )}
            </div>
          ) : (
            <>
            {picked.some((k) => valuesOf(periods, k).every((v) => v == null)) && (
              <p data-testid="period-no-figures" className="text-meta text-ui-mute">
                No figures for {picked.filter((k) => valuesOf(periods, k).every((v) => v == null)).map(metricName).join(', ')} in these periods.
              </p>
            )}
            {unitGroups(picked).map((g) => (
              <div key={g.unit}>
                <h4 className="mb-0.5 text-meta font-medium text-ui-mute">{PERIOD_UNIT_WORDS[g.unit]}</h4>
                {chartFor(g.keys, `period-chart-${g.unit}`)}
              </div>
            ))}
            </>
          )}
          {periods[selected]?.lanes != null && (
            <div data-testid="period-lanes">
              <div className="mb-1 text-meta text-ui-mute">{bands[selected]!.label} · all {series!.repos.total} repos</div>
              <LanesPanel lanes={periods[selected]!.lanes!} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
