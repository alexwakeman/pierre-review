import { useMemo, useState, type ReactNode } from 'react';
import {
  FLOW_BUDGET_LABEL,
  FLOW_BUDGET_MEASURES,
  FLOW_TREND,
  type FlowTrendEvent,
  type FlowTrendEventKind,
  type FlowTrendLensRow,
  type FlowTrendResponse,
  type FlowTrendWeek,
  type PrCourt,
} from '@pierre-review/shared';
import { useFlowTrend } from '../../hooks/useFlowTrend.js';
import { BOT_VENDOR_META } from '../../lib/ui.js';
import { EventMarkerLines, EventMarkerRail, type ChartEventMarker } from '../charts/EventMarkers.js';
import { FloatingTip, niceMax, useChartWidth } from '../charts/common.js';
import { InfoButton } from '../InfoModal.js';
import { BotIcon, ChartIcon, CloseIcon, GearIcon, PersonIcon, WarningIcon, WorkspaceIcon } from '../Icons.js';
import { COURT_LABEL, COURT_ORDER } from './bottlenecksModel.js';
import { COURT_FILL, COURT_SWATCH } from './ChronologyCharts.js';
import { VERDICT_LABEL } from './chronologyModel.js';
import {
  clusterEvents,
  EVENT_KIND_LABEL,
  EVENT_KIND_ORDER,
  eventCounts,
  hoursShort,
  lensChange,
  lensSignificance,
  lensValue,
  runningGain,
  signedHours,
  usableWeek,
  weekLabel,
  type EventCluster,
} from './chronologyTrendModel.js';

// CHRONOLOGY OVER TIME — four charts on ONE fetch (`GET /api/flow-trend`), docs/BOTTLENECKS.md
// § Over time:
//   (a) where the working hours went, week by week (the split as a stacked area);
//   (b) each wait against TODAY's budgets, one coloured cell per week;
//   (c) before and after any marked week, in a panel opened from a marker;
//   (d) working hours saved against a baseline the reader can move.
//
// ⚠ EVERY CHART SHARES ONE X-AXIS (`geometry`), so an event's line falls on the same week in all
// three. Only the top chart's marker rail is interactive; the others are decorative copies.
//
// ⚠ "LAST 26 WEEKS" IS ON SCREEN. This view is the one labelled exception to Chronology's 90-day
// cap, and coverage is shown, never implied: faint weeks, contributing-repo counts on hover, and a
// marker for every repository that joined.
//
// ⚠ A MARKER NAMES A FIRST APPEARANCE AND NOTHING ELSE. No figure is attributed to the person or
// bot it names; the lens compares weeks, not people.

const NOTE = 'text-xs text-gray-500 dark:text-gray-400';
const AXIS_TEXT = 'fill-gray-500 dark:fill-gray-400 text-[11px]';
const VEIL = 'fill-white dark:fill-gray-950';
const PAD_L = 124;
const PAD_R = 12;
/** Lines in a marker's hover box before "and N more". */
const HOVER_LINES = 8;

const KIND_ICON: Record<FlowTrendEventKind, (size: number) => ReactNode> = {
  repo: (s) => <WorkspaceIcon size={s} />,
  bot: (s) => <BotIcon size={s} />,
  contributor: (s) => <PersonIcon size={s} />,
  setting: (s) => <GearIcon size={s} />,
  shift: (s) => <ChartIcon size={s} />,
};

const VERDICT_FILL: Record<'good' | 'ok' | 'slow', string> = {
  good: 'fill-emerald-500 dark:fill-emerald-500',
  ok: 'fill-amber-400 dark:fill-amber-500',
  slow: 'fill-rose-500 dark:fill-rose-500',
};
const VERDICT_SWATCH: Record<'good' | 'ok' | 'slow', string> = {
  good: 'bg-emerald-500',
  ok: 'bg-amber-400 dark:bg-amber-500',
  slow: 'bg-rose-500',
};

const LENS_LABEL: Record<FlowTrendLensRow['measure'], string> = {
  firstLook: FLOW_BUDGET_LABEL.firstLook,
  reply: FLOW_BUDGET_LABEL.reply,
  land: FLOW_BUDGET_LABEL.land,
  lead: FLOW_BUDGET_LABEL.lead,
  reviewerShare: 'Share waiting for a reviewer',
  authorShare: 'Share waiting for the author',
  landingShare: 'Share approved, waiting to merge',
};

const LENS_SIGNIFICANT: Record<'better' | 'worse', { word: string; bar: string; ink: string }> = {
  better: { word: 'Real improvement', bar: 'bg-emerald-500', ink: 'text-emerald-700 dark:text-emerald-400' },
  worse: { word: 'Real slowdown', bar: 'bg-rose-500', ink: 'text-rose-700 dark:text-rose-400' },
};

interface Geometry {
  width: number;
  n: number;
  band: number;
  cx: (i: number) => number;
  left: (i: number) => number;
}

function geometryFor(width: number, n: number): Geometry {
  const inner = Math.max(width - PAD_L - PAD_R, 1);
  const band = inner / Math.max(n, 1);
  return {
    width,
    n,
    band,
    cx: (i) => PAD_L + band * (i + 0.5),
    left: (i) => PAD_L + band * i,
  };
}

/** The display line for one event. A bot is named by its product where we know it. */
function eventLine(e: FlowTrendEvent): string {
  if (e.kind === 'bot' && e.vendorKind) {
    const meta = (BOT_VENDOR_META as Record<string, { label: string } | undefined>)[e.vendorKind];
    if (meta) return `${meta.label} (@${e.login}) first seen`;
  }
  return e.label;
}

function markersFor(
  clusters: EventCluster[],
  geo: Geometry,
  weeks: FlowTrendWeek[],
  selected: number | null,
  onSelect: (week: number) => void,
): ChartEventMarker[] {
  return clusters.map((c) => {
    const w = weeks[c.week];
    const when = w ? `Week of ${weekLabel(w.weekStart)}` : '';
    const all = c.events.map(eventLine);
    // A busy week (a public repository's first-time contributors) can carry dozens; the hover box
    // lists the first few and counts the rest. The lens lists them all.
    const lines =
      all.length > HOVER_LINES ? [...all.slice(0, HOVER_LINES), `and ${all.length - HOVER_LINES} more`] : all;
    return {
      key: `w${c.week}`,
      x: geo.cx(c.week),
      dashed: c.shiftsOnly,
      selected: selected === c.week,
      icon: KIND_ICON[c.lead](11),
      count: c.events.length,
      label: `${when}: ${all.length === 1 ? all[0] : `${all.length} events`}. Compare before and after.`,
      lines: [when, ...lines],
      onSelect: () => onSelect(c.week),
    };
  });
}

/** x-axis labels: every fourth week, and the last. */
function XLabels({ geo, weeks, y }: { geo: Geometry; weeks: FlowTrendWeek[]; y: number }): JSX.Element {
  return (
    <g aria-hidden="true">
      {weeks.map((w, i) =>
        (i % 4 === 0 && i < weeks.length - 2) || i === weeks.length - 1 ? (
          <text key={i} x={geo.cx(i)} y={y} textAnchor="middle" className={AXIS_TEXT}>
            {i === weeks.length - 1 ? 'This week' : weekLabel(w.weekStart)}
          </text>
        ) : null,
      )}
    </g>
  );
}

/** A faint veil over the weeks the maths leaves out: thin, or the unfinished current week. */
function Veils({ geo, weeks, top, bottom }: { geo: Geometry; weeks: FlowTrendWeek[]; top: number; bottom: number }): JSX.Element {
  return (
    <g aria-hidden="true">
      {weeks.map((w, i) =>
        w.measuredPrs > 0 && (w.thin || w.partial) ? (
          <rect
            key={i}
            x={geo.left(i)}
            y={top}
            width={geo.band}
            height={bottom - top}
            className={VEIL}
            opacity={w.thin ? 0.65 : 0.4}
          />
        ) : null,
      )}
    </g>
  );
}

function weekHead(w: FlowTrendWeek): string {
  return `Week of ${weekLabel(w.weekStart)}${w.partial ? ' (so far)' : ''}`;
}

function coverageLine(w: FlowTrendWeek): string {
  return `${w.reposWithData} of ${w.reposInWorkspace} ${w.reposInWorkspace === 1 ? 'repository' : 'repositories'} had merges`;
}

function prsLine(w: FlowTrendWeek): string {
  const n = w.measuredPrs;
  const base = `${n} pull ${n === 1 ? 'request' : 'requests'} measured`;
  return w.thin && n > 0 ? `${base}: too few to compare` : base;
}

// ── (a) Where the working hours went, week by week ───────────────────────────────────────────

function BallRiver({
  data,
  geo,
  markers,
}: {
  data: FlowTrendResponse;
  geo: Geometry;
  markers: ChartEventMarker[];
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const weeks = data.weeks;
  const H = 150;
  const top = 6;
  const bottom = H - 20;
  const y = (v: number): number => top + (bottom - top) * (1 - v);
  const share = (w: FlowTrendWeek, c: PrCourt): number => w.courtsWork.find((s) => s.court === c)?.share ?? 0;

  // Runs of consecutive weeks with data; a gap is a week nothing merged.
  const runs: number[][] = [];
  weeks.forEach((w, i) => {
    if (w.measuredPrs === 0) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  });

  const bandPath = (run: number[], k: number): string => {
    const below = (w: FlowTrendWeek): number =>
      COURT_ORDER.slice(0, k).reduce((s, c) => s + share(w, c), 0);
    const above = (w: FlowTrendWeek): number => below(w) + share(w, COURT_ORDER[k] as PrCourt);
    const first = run[0] as number;
    const last = run[run.length - 1] as number;
    const xs = [geo.left(first), ...run.map((i) => geo.cx(i)), geo.left(last) + geo.band];
    const ws = [first, ...run, last].map((i) => weeks[i] as FlowTrendWeek);
    const topPts = xs.map((x, j) => `${x},${y(above(ws[j] as FlowTrendWeek))}`);
    const botPts = xs.map((x, j) => `${x},${y(below(ws[j] as FlowTrendWeek))}`).reverse();
    return `M ${topPts.join(' L ')} L ${botPts.join(' L ')} Z`;
  };

  const hw = hover == null ? null : weeks[hover];
  return (
    <div className="relative">
      <svg width={geo.width} height={H} role="img" aria-label="Share of working hours in each wait, week by week">
        <g aria-hidden="true">
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={geo.width - PAD_R} y1={y(v)} y2={y(v)} className="stroke-gray-200 dark:stroke-gray-800" />
              <text x={PAD_L - 6} y={y(v) + 4} textAnchor="end" className={AXIS_TEXT}>
                {Math.round(v * 100)}%
              </text>
            </g>
          ))}
          {runs.map((run, r) =>
            COURT_ORDER.map((c, k) => <path key={`${r}-${c}`} d={bandPath(run, k)} className={COURT_FILL[c]} />),
          )}
        </g>
        <Veils geo={geo} weeks={weeks} top={top} bottom={bottom} />
        <EventMarkerLines markers={markers} top={top} bottom={bottom} />
        <XLabels geo={geo} weeks={weeks} y={H - 4} />
        {weeks.map((_, i) => (
          <rect
            key={i}
            x={geo.left(i)}
            y={top}
            width={geo.band}
            height={bottom - top}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          />
        ))}
      </svg>
      {hw != null && hover != null && (
        <FloatingTip x={geo.cx(hover)} y={top + 10} width={geo.width}>
          <div className="font-medium">{weekHead(hw)}</div>
          <div>{prsLine(hw)}</div>
          {hw.measuredPrs > 0 &&
            COURT_ORDER.map((c) => (
              <div key={c}>
                {COURT_LABEL[c]}: {Math.round(share(hw, c) * 100)}%
              </div>
            ))}
          <div>{coverageLine(hw)}</div>
        </FloatingTip>
      )}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {COURT_ORDER.map((c) => (
          <span key={c} className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
            <span className={`inline-block h-2 w-2 rounded-[2px] ${COURT_SWATCH[c]}`} />
            {COURT_LABEL[c]}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── (b) Each wait against today's budgets, one cell per week ─────────────────────────────────

function BudgetWeather({
  data,
  geo,
  markers,
}: {
  data: FlowTrendResponse;
  geo: Geometry;
  markers: ChartEventMarker[];
}): JSX.Element {
  const [hover, setHover] = useState<{ week: number; row: number } | null>(null);
  const weeks = data.weeks;
  const ROW = 18;
  const GAP = 4;
  const top = 2;
  const bottom = top + FLOW_BUDGET_MEASURES.length * (ROW + GAP);
  const H = bottom + 18;
  const cell = hover == null ? null : weeks[hover.week]?.budgets[hover.row];
  const hw = hover == null ? null : weeks[hover.week];
  return (
    <div className="relative">
      <svg width={geo.width} height={H} role="img" aria-label="Each wait against today's budgets, week by week. The table below lists the same figures.">
        {FLOW_BUDGET_MEASURES.map((m, r) => {
          const yy = top + r * (ROW + GAP);
          return (
            <g key={m}>
              <text x={PAD_L - 6} y={yy + ROW / 2 + 4} textAnchor="end" className={AXIS_TEXT} aria-hidden="true">
                {FLOW_BUDGET_LABEL[m]}
              </text>
              {weeks.map((w, i) => {
                const b = w.budgets.find((x) => x.measure === m);
                const x = geo.left(i) + 1;
                const width = Math.max(geo.band - 2, 1);
                const faint = w.thin || w.partial;
                const cls =
                  b == null || b.prs === 0
                    ? 'fill-none stroke-gray-200 dark:stroke-gray-800'
                    : b.verdict == null
                      ? 'decorative-mark fill-gray-300 dark:fill-gray-600'
                      : VERDICT_FILL[b.verdict];
                return (
                  <rect
                    key={i}
                    x={x}
                    y={yy}
                    width={width}
                    height={ROW}
                    rx={2}
                    className={cls}
                    opacity={faint && b != null && b.prs > 0 ? 0.35 : 1}
                    onMouseEnter={() => setHover({ week: i, row: r })}
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
            </g>
          );
        })}
        <EventMarkerLines markers={markers} top={top} bottom={bottom} />
        <XLabels geo={geo} weeks={weeks} y={H - 4} />
      </svg>
      {hover != null && hw != null && cell != null && (
        <FloatingTip x={geo.cx(hover.week)} y={top + hover.row * (ROW + GAP)} width={geo.width}>
          <div className="font-medium">
            {weekHead(hw)} · {FLOW_BUDGET_LABEL[cell.measure]}
          </div>
          {cell.prs === 0 || cell.p75 == null ? (
            <div>Nothing to measure</div>
          ) : (
            <>
              <div>
                Three in four within {hoursShort(cell.p75)}; half within {hoursShort(cell.p50 ?? 0)} (working hours)
              </div>
              <div>
                {cell.verdict == null ? 'Too few to judge' : VERDICT_LABEL[cell.verdict]} · {cell.prs} pull{' '}
                {cell.prs === 1 ? 'request' : 'requests'}
              </div>
            </>
          )}
          {hw.thin && hw.measuredPrs > 0 && <div>Too few pull requests to compare this week</div>}
        </FloatingTip>
      )}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {(['good', 'ok', 'slow'] as const).map((v) => (
          <span key={v} className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
            <span className={`inline-block h-2 w-2 rounded-[2px] ${VERDICT_SWATCH[v]}`} />
            {VERDICT_LABEL[v]}
          </span>
        ))}
        <span className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
          <span className="inline-block h-2 w-2 rounded-[2px] bg-gray-300 dark:bg-gray-600" />
          Too few to judge
        </span>
      </div>
      <p className={`mt-1 ${NOTE}`}>
        Coloured against today’s budgets: {FLOW_BUDGET_MEASURES.map((m) => `${FLOW_BUDGET_LABEL[m].toLowerCase()} ${data.budgets[m].good} h, limit ${data.budgets[m].ok} h`).join('; ')}.
      </p>
      <table className="sr-only">
        <caption>Three in four within, working hours, by week</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            {FLOW_BUDGET_MEASURES.map((m) => (
              <th key={m} scope="col">
                {FLOW_BUDGET_LABEL[m]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.weekStart}>
              <th scope="row">{weekHead(w)}</th>
              {w.budgets.map((b) => (
                <td key={b.measure}>
                  {b.p75 == null ? 'none' : `${hoursShort(b.p75)}, ${b.verdict == null ? 'too few to judge' : VERDICT_LABEL[b.verdict]}`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── (d) Working hours saved against a baseline ───────────────────────────────────────────────

function GainLine({
  data,
  geo,
  markers,
  from,
  onPickBaseline,
}: {
  data: FlowTrendResponse;
  geo: Geometry;
  markers: ChartEventMarker[];
  from: number | null;
  onPickBaseline: (week: number | null) => void;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const weeks = data.weeks;
  const gain = useMemo(() => runningGain(weeks, from), [weeks, from]);
  const H = 150;
  const top = 8;
  const bottom = H - 20;
  if (gain == null) {
    return (
      <p className={NOTE}>
        {from == null
          ? `Not enough weeks yet to set a baseline: it needs ${FLOW_TREND.baselineWeeks} weeks with at least ${FLOW_TREND.thinWeekPrs} pull requests each.`
          : 'Too few usable weeks before that week to set a baseline there.'}
        {from != null && (
          <button type="button" className="ml-2 font-medium text-sky-700 hover:underline dark:text-sky-400" onClick={() => onPickBaseline(null)}>
            Use the default baseline
          </button>
        )}
      </p>
    );
  }
  const vals = gain.cumulative.filter((v): v is number => v != null);
  const maxV = Math.max(0, ...vals);
  const minV = Math.min(0, ...vals);
  const yMax = maxV > 0 ? niceMax(maxV) : minV < 0 ? 0 : 1;
  const yMin = minV < 0 ? -niceMax(-minV) : 0;
  const y = (v: number): number => top + (bottom - top) * (1 - (v - yMin) / Math.max(yMax - yMin, 1));
  const pts = gain.cumulative
    .map((v, i) => (v == null ? null : ([geo.cx(i), y(v)] as const)))
    .filter((p): p is readonly [number, number] => p != null);
  const last = vals[vals.length - 1] ?? 0;
  const startWeek = weeks[gain.start];
  const bFirst = gain.baselineWeeks[0] as number;
  const bLast = gain.baselineWeeks[gain.baselineWeeks.length - 1] as number;
  const hw = hover == null ? null : weeks[hover];
  return (
    <div className="relative">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div>
          <span className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-50">{signedHours(last)}</span>{' '}
          <span className="text-xs text-gray-600 dark:text-gray-300">
            working hours {last >= 0 ? 'saved' : 'lost'} since{' '}
            {startWeek ? `the week of ${weekLabel(startWeek.weekStart)}` : 'the baseline'}
          </span>
        </div>
        <span className={NOTE}>
          Baseline: half merged within {hoursShort(gain.baseline)} ({gain.baselineWeeks.length} weeks)
        </span>
        {from != null && (
          <button type="button" className="text-xs font-medium text-sky-700 hover:underline dark:text-sky-400" onClick={() => onPickBaseline(null)}>
            Use the default baseline
          </button>
        )}
      </div>
      <svg width={geo.width} height={H} role="img" aria-label={`Working hours saved against the baseline: ${signedHours(last)} so far`}>
        <g aria-hidden="true">
          <rect
            x={geo.left(bFirst)}
            y={top}
            width={geo.left(bLast) + geo.band - geo.left(bFirst)}
            height={bottom - top}
            className="fill-sky-100 dark:fill-sky-950"
          />
          <text x={geo.left(bFirst) + 4} y={top + 12} className={AXIS_TEXT}>
            Baseline
          </text>
          {[yMax, 0, yMin].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
            <g key={v}>
              <line
                x1={PAD_L}
                x2={geo.width - PAD_R}
                y1={y(v)}
                y2={y(v)}
                className={v === 0 ? 'stroke-gray-400 dark:stroke-gray-500' : 'stroke-gray-200 dark:stroke-gray-800'}
              />
              <text x={PAD_L - 6} y={y(v) + 4} textAnchor="end" className={AXIS_TEXT}>
                {signedHours(v)}
              </text>
            </g>
          ))}
          {pts.length > 1 && (
            <polyline
              points={pts.map(([px, py]) => `${px},${py}`).join(' ')}
              fill="none"
              className="stroke-sky-600 dark:stroke-sky-400"
              strokeWidth={2}
            />
          )}
          {gain.cumulative.map((v, i) =>
            v == null ? null : (
              <circle
                key={i}
                cx={geo.cx(i)}
                cy={y(v)}
                r={3}
                className={
                  gain.weekly[i] != null
                    ? 'fill-sky-600 dark:fill-sky-400'
                    : 'fill-white stroke-sky-600 dark:fill-gray-950 dark:stroke-sky-400'
                }
              />
            ),
          )}
        </g>
        <EventMarkerLines markers={markers} top={top} bottom={bottom} />
        <XLabels geo={geo} weeks={weeks} y={H - 4} />
        {weeks.map((_, i) => (
          <rect
            key={i}
            x={geo.left(i)}
            y={top}
            width={geo.band}
            height={bottom - top}
            fill="transparent"
            className="cursor-pointer"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            onClick={() => onPickBaseline(i)}
          />
        ))}
      </svg>
      {hw != null && hover != null && (
        <FloatingTip x={geo.cx(hover)} y={top + 10} width={geo.width}>
          <div className="font-medium">{weekHead(hw)}</div>
          {gain.weekly[hover] != null ? (
            <>
              <div>
                Half merged within {hoursShort(hw.medianLeadWorkHours ?? 0)}, against {hoursShort(gain.baseline)}
              </div>
              <div>
                {signedHours(gain.weekly[hover] as number)} over {hw.measuredPrs} pull requests
              </div>
            </>
          ) : (
            <div>{hover < gain.start ? 'Before the baseline' : 'Not counted: too few pull requests'}</div>
          )}
          {gain.cumulative[hover] != null && <div>Running total {signedHours(gain.cumulative[hover] as number)}</div>}
          <div>Click to measure from this week</div>
        </FloatingTip>
      )}
      <p className={`mt-1 ${NOTE}`}>
        Each week adds (baseline − that week’s half-merged-within time) × the pull requests merged
        that week, in working hours. A rising line means pull requests are merging faster than at
        the baseline. Click any week to measure from there.
      </p>
    </div>
  );
}

// ── (c) Before and after a marked week ───────────────────────────────────────────────────────

function BeforeAfterLens({
  data,
  week,
  onClose,
  onUseAsBaseline,
}: {
  data: FlowTrendResponse;
  week: number;
  onClose: () => void;
  onUseAsBaseline: () => void;
}): JSX.Element | null {
  const lens = data.lenses.find((l) => l.week === week);
  const w = data.weeks[week];
  if (lens == null || w == null) return null;
  const events = data.events.filter((e) => e.week === week);
  return (
    <section
      aria-label={`Before and after the week of ${weekLabel(w.weekStart)}`}
      className="rounded-lg border border-sky-200 bg-sky-50/40 p-3 dark:border-sky-900 dark:bg-sky-950/30"
      data-testid="chronology-trend-lens"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h5 className="text-xs font-semibold text-gray-800 dark:text-gray-100">
            Before and after the week of {weekLabel(w.weekStart)}
          </h5>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-200">
                <span className="text-gray-500 dark:text-gray-400">{KIND_ICON[e.kind](12)}</span>
                {eventLine(e)}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-2">
          <InfoButton title="Before and after">
            <p>
              Each row has two bars: the median of up to {FLOW_TREND.lensWeeks} weeks before this week
              (grey, top) and of up to {FLOW_TREND.lensWeeks} weeks from it on (bottom). Here that is{' '}
              {Math.max(...lens.rows.map((r) => r.beforeWeeks))} weeks before and{' '}
              {Math.max(...lens.rows.map((r) => r.afterWeeks))} weeks after. Weeks with fewer than{' '}
              {FLOW_TREND.thinWeekPrs} pull requests, and the current week, are left out. Both bars in a
              row share one scale.
            </p>
            <p className="mt-2">
              The four waits are in working hours, and each is the time by which three in four pull
              requests had finished that wait. The three shares are the part of all working hours
              spent in that wait. Lower is better for every row.
            </p>
            <p className="mt-2">
              A green or red after bar is a real change: the step is at least three times the usual
              week-to-week spread (a robust z-score of 3 or more, using medians, so one odd week
              cannot cause it), with at least four weeks on each side. Green is faster or less
              waiting, red is slower or more. A grey after bar is not a real change. A change can
              line up with an event without being caused by it.
            </p>
          </InfoButton>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close before and after"
            className="rounded p-0.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>
      <ul className="mt-3 space-y-3">
        {lens.rows.map((r) => {
          const sig = lensSignificance(r);
          const meta = sig == null ? null : LENS_SIGNIFICANT[sig];
          const isShare = r.measure.endsWith('Share');
          const max = isShare ? 1 : Math.max(r.before ?? 0, r.after ?? 0, 1e-9);
          const pct = (v: number | null): string => `${v == null ? 0 : Math.max((v / max) * 100, v > 0 ? 1.5 : 0)}%`;
          return (
            <li key={r.measure}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-gray-700 dark:text-gray-200">{LENS_LABEL[r.measure]}</span>
                {meta != null && (
                  <span className={`shrink-0 font-medium tabular-nums ${meta.ink}`}>
                    {meta.word} · {lensChange(r.measure, r.before, r.after)}
                  </span>
                )}
              </div>
              <div
                className="mt-1 grid grid-cols-[3.25rem_1fr_3.5rem] items-center gap-x-2 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400"
                role="img"
                aria-label={`${LENS_LABEL[r.measure]}: before ${lensValue(r.measure, r.before)}, after ${lensValue(r.measure, r.after)}${meta != null ? `, ${meta.word.toLowerCase()}` : ''}`}
              >
                <span>Before</span>
                <span className="h-2.5 rounded-sm bg-gray-100 dark:bg-gray-800">
                  <span className="block h-full rounded-sm bg-gray-300 dark:bg-gray-600" style={{ width: pct(r.before) }} />
                </span>
                <span className="text-right tabular-nums text-gray-700 dark:text-gray-200">{lensValue(r.measure, r.before)}</span>
                <span>After</span>
                <span className="h-2.5 rounded-sm bg-gray-100 dark:bg-gray-800">
                  <span
                    className={`block h-full rounded-sm ${meta?.bar ?? 'bg-gray-500 dark:bg-gray-400'}`}
                    style={{ width: pct(r.after) }}
                  />
                </span>
                <span className={`text-right tabular-nums ${meta?.ink ?? 'text-gray-700 dark:text-gray-200'}`}>
                  {lensValue(r.measure, r.after)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={onUseAsBaseline}
        className="mt-2 text-xs font-medium text-sky-700 hover:underline dark:text-sky-400"
      >
        Measure hours saved from this week
      </button>
    </section>
  );
}

// ── The section ──────────────────────────────────────────────────────────────────────────────

function TrendInfo({ data }: { data: FlowTrendResponse }): JSX.Element {
  return (
    <div className="space-y-2">
      <p>
        The last {FLOW_TREND.weeks} weeks, one point per week. A pull request counts in the week it
        merged, in this workspace’s time zone ({data.timeZone}). The figures are the same ones
        Chronology shows above, worked out week by week.
      </p>
      <p>
        Weeks with fewer than {FLOW_TREND.thinWeekPrs} pull requests are drawn faint and left out of
        every comparison, as is the current week until it ends. Hover a week to see how many
        repositories had merges: a new repository can move a chart without anything changing in how
        people work, so every repository that joined is marked.
      </p>
      <p>
        Markers: a repository joining, a bot or a person seen for the first time, a setting change,
        and a shift the numbers show on their own (dashed). A marker only says something first
        happened that week. Someone active since before our records began is not marked as new.
      </p>
      <p>Click a marker to compare the weeks before and after it.</p>
    </div>
  );
}

/** Keyed by workspace: a picked lens week or baseline belongs to ONE workspace's chart. */
export function ChronologyTrend({ workspaceId }: { workspaceId: number | null }): JSX.Element {
  return <ChronologyTrendFor key={workspaceId ?? 'none'} workspaceId={workspaceId} />;
}

function ChronologyTrendFor({ workspaceId }: { workspaceId: number | null }): JSX.Element {
  const q = useFlowTrend(workspaceId);
  const [ref, width] = useChartWidth();
  const [shown, setShown] = useState<Set<FlowTrendEventKind>>(() => new Set(EVENT_KIND_ORDER));
  // A body without `weeks` (an older server, or a stubbed route answering `{}`) is treated as no
  // data — never dereferenced, since a render-time throw blanks the whole SPA.
  const data = q.data != null && Array.isArray(q.data.weeks) ? q.data : undefined;
  // ⚠ The picked weeks are held by `weekStart`, never by index: when the week rolls over the
  // refetch shifts every index by one, and an index would silently move the pick to its neighbour.
  // A week that has scrolled out of the span resolves to nothing.
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [baselineWeek, setBaselineWeek] = useState<string | null>(null);
  const indexOf = (ws: string | null): number | null => {
    if (ws == null || data == null) return null;
    const i = data.weeks.findIndex((w) => w.weekStart === ws);
    return i < 0 ? null : i;
  };
  const weekAt = (i: number | null): string | null => (i == null ? null : (data?.weeks[i]?.weekStart ?? null));
  const selected = indexOf(selectedWeek);
  const baselineFrom = indexOf(baselineWeek);
  const setSelected = (next: number | null | ((s: number | null) => number | null)): void =>
    setSelectedWeek(weekAt(typeof next === 'function' ? next(selected) : next));
  const setBaselineFrom = (i: number | null): void => setBaselineWeek(weekAt(i));
  const geo = geometryFor(width, data?.weeks.length ?? FLOW_TREND.weeks);
  const clusters = useMemo(() => clusterEvents(data?.events ?? [], shown), [data?.events, shown]);
  const markers = data == null ? [] : markersFor(clusters, geo, data.weeks, selected, (w) => setSelected((s) => (s === w ? null : w)));
  const counts = eventCounts(data?.events ?? []);
  const usable = data?.weeks.filter(usableWeek).length ?? 0;

  return (
    <section
      data-testid="chronology-trend"
      className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
    >
      <div className="flex items-center gap-1">
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Over time</h4>
        <span className="text-xs text-gray-500 dark:text-gray-400">· Last {FLOW_TREND.weeks} weeks</span>
        {data != null && (
          <InfoButton title="Chronology over time" width="lg">
            <TrendInfo data={data} />
          </InfoButton>
        )}
      </div>
      <div ref={ref} className="mt-3 w-full">
        {data == null ? (
          <p className={NOTE}>{q.isError ? 'Could not load the last 26 weeks.' : 'Measuring…'}</p>
        ) : width === 0 ? null : (
          <div className="space-y-4">
            <div className="space-y-0.5">
              <p className={NOTE}>
                By the week each pull request merged. Faint weeks had fewer than {FLOW_TREND.thinWeekPrs}{' '}
                pull requests and are left out of every comparison ({usable} of {data.weeks.length} weeks
                count).
              </p>
              <p className={NOTE}>
                {data.settingsHistoryFrom == null
                  ? 'No setting changes recorded yet. Changes are recorded from now on.'
                  : `Setting changes are recorded from ${new Date(data.settingsHistoryFrom).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`}
              </p>
              {data.retentionDays != null && (
                <p className={NOTE}>
                  History older than {data.retentionDays} days is not kept, so the earliest weeks may be thin.
                </p>
              )}
              {data.truncated && (
                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <WarningIcon size={12} className="mt-0.5 shrink-0" />
                  <span>Some weeks hit a scan limit, so not every pull request is counted.</span>
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show markers">
              {EVENT_KIND_ORDER.map((k) => {
                const on = shown.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setShown((s) => {
                        const next = new Set(s);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      })
                    }
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                      on
                        ? 'border-gray-400 bg-gray-100 text-gray-800 dark:border-gray-500 dark:bg-gray-800 dark:text-gray-100'
                        : 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400'
                    } ${k === 'shift' ? 'border-dashed' : ''}`}
                  >
                    {KIND_ICON[k](11)}
                    {EVENT_KIND_LABEL[k]}
                    <span className="tabular-nums">{counts[k]}</span>
                  </button>
                );
              })}
            </div>

            <div>
              <h5 className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-200">Where the working hours went</h5>
              <EventMarkerRail markers={markers} width={width} />
              <BallRiver data={data} geo={geo} markers={markers} />
            </div>

            {selected != null && (
              <BeforeAfterLens
                data={data}
                week={selected}
                onClose={() => setSelected(null)}
                onUseAsBaseline={() => setBaselineFrom(selected)}
              />
            )}

            <div>
              <h5 className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-200">Each wait against its budget</h5>
              <EventMarkerRail markers={markers} width={width} interactive={false} />
              <BudgetWeather data={data} geo={geo} markers={markers} />
            </div>

            <div>
              <h5 className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-200">
                Working hours saved, opened to merged
              </h5>
              <EventMarkerRail markers={markers} width={width} interactive={false} />
              <GainLine
                data={data}
                geo={geo}
                markers={markers}
                from={baselineFrom}
                onPickBaseline={setBaselineFrom}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
