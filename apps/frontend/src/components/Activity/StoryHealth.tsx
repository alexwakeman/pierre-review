import { useMemo, useState, type ReactNode } from 'react';
import {
  STORY_HEALTH_ROLLING_WEEKS,
  STORY_HEALTH_SERIES_BY_ID,
  STORY_HEALTH_SPAN_LABEL,
  STORY_HEALTH_THIN_N,
  STORY_LABEL_MODEL,
  STORY_LABEL_NOISE,
  CHANGEPOINT_Z,
  STORY_SHIFT_MIN_HOURS,
  STORY_SHIFT_MIN_POINTS,
  STORY_SHIFT_MIN_PRS,
  STORY_SHIFT_MIN_STORIES,
  STORY_SHIFT_Z,
  STORY_LABEL_RUN_CAP,
  STORY_RUBRIC_VERSION,
  STORY_SIZE_BANDS,
  type StoryHealthPanel,
  type StoryHealthPoint,
  type StoryHealthResponse,
  type StoryHealthSeriesId,
  type StoryHealthSeriesMeta,
  type StoryHealthShift,
  type StoryHealthUnit,
  type StoryHealthWeek,
  type StoryLabelRunStatus,
} from '@pierre-review/shared';
import {
  useCancelStoryLabelRun,
  useStartStoryLabelRun,
  useStoryHealth,
  useStoryLabelRun,
  useStoryLabelsOn,
  useStoryLabelStarting,
} from '../../hooks/useStoryHealth.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { AiRunGate } from '../AiSetup.js';
import { EventMarkerLines, EventMarkerRail, type ChartEventMarker } from '../charts/EventMarkers.js';
import { FloatingTip, useChartWidth } from '../charts/common.js';
import { ChartIcon, CloseIcon, SparkleIcon, WarningIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { weekLabel } from './chronologyTrendModel.js';
import { RegenProgressBar } from './RegenProgressBar.js';
import {
  axisTop,
  clusterShifts,
  coverageLine,
  createdLine,
  DELIVERY_STRIPS,
  drawnValues,
  formatStoryChange,
  formatStoryValue,
  headlineVerdict,
  labelPressCount,
  mergedLine,
  panelSeries,
  pointLine,
  rollingHeadline,
  shiftLine,
  shiftUnits,
  shiftVerdictWord,
  smallMultipleColumns,
  STORY_SERIES_COLOR,
  storyWeekHead,
  weekIndex,
  type ShiftCluster,
} from './storyHealthModel.js';

// Reports → Stories → STORY HEALTH — how stories are written and how they land, week by week over a
// FIXED, LABELLED span ("Last 90 days"), on ONE fetch (`GET /api/story-health`). docs/FRONTEND.md
// § Story health.
//
//   • REFINEMENT — each story in the week its ticket was created, as SMALL MULTIPLES: one small chart
//     per measure (its latest rolling value large, the change since the first one small), the
//     model-labelled ones grouped apart from the code-counted ones. 2 columns from 560px, else 1.
//   • DELIVERY — each story in the week of its last merge, as three strips (one per unit, so no two
//     scales share an axis): working time by size band, pull requests per story, criteria met.
//
// ⚠ THE DELIVERY STRIPS SHARE ONE X-AXIS (`geometryFor`); each small chart has its own, same 13 weeks.
// ⚠ A LINE IS THE SERVER'S ROLLING 4-WEEK VALUE; the faint dots are the weekly values. Thin weeks are
// hollow and faint and the server already left them out of the line and the shifts.
// ⚠ GREEN/RED ONLY ON A DETECTED SHIFT, FROM `shift.verdict` — never from a client direction.
// ⚠ WITHOUT AGENTIC AI (cloud, `LIMN_AI_DISABLED`) the server omits every label series and the page
// offers no button: code measures only. A missing runtime/credential swaps the button via `AiRunGate`.
// ⚠ EVERY EXPLANATION SITS BEHIND AN ⓘ (Product voice).

const MUTED = 'text-gray-500 dark:text-gray-400';
const BODY = 'text-gray-700 dark:text-gray-200';
const AXIS_TEXT = 'fill-gray-500 dark:fill-gray-400 text-[11px]';
const PAD_L = 48;
const PAD_R = 12;

interface Geometry {
  width: number;
  band: number;
  cx: (i: number) => number;
  left: (i: number) => number;
}

function geometryFor(width: number, n: number): Geometry {
  const inner = Math.max(width - PAD_L - PAD_R, 1);
  const band = inner / Math.max(n, 1);
  return { width, band, cx: (i) => PAD_L + band * (i + 0.5), left: (i) => PAD_L + band * i };
}

function modelName(model: string): string {
  return model === STORY_LABEL_MODEL ? 'Haiku 5.5' : model;
}

// ── One chart strip ──────────────────────────────────────────────────────────────────────────

interface StripItem {
  meta: StoryHealthSeriesMeta;
  points: StoryHealthPoint[];
}

function XLabels({ geo, weeks, y }: { geo: Geometry; weeks: StoryHealthWeek[]; y: number }): JSX.Element {
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

function SeriesStrip({
  weeks,
  geo,
  unit,
  items,
  markers,
  height,
  ariaLabel,
  tip,
}: {
  weeks: StoryHealthWeek[];
  geo: Geometry;
  unit: StoryHealthUnit;
  items: StripItem[];
  markers: ChartEventMarker[];
  height: number;
  ariaLabel: string;
  tip: (week: number) => ReactNode;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const top = 8;
  const bottom = height - 20;
  const yTop = axisTop(unit, items.flatMap((it) => drawnValues(it.points)));
  const y = (v: number): number => top + (bottom - top) * (1 - Math.min(Math.max(v, 0), yTop) / yTop);

  const linePath = (pts: StoryHealthPoint[]): string => {
    let d = '';
    let pen = false;
    pts.forEach((p, i) => {
      if (p.rolling == null) {
        pen = false;
        return;
      }
      d += `${pen ? ' L' : ' M'} ${geo.cx(i)} ${y(p.rolling)}`;
      pen = true;
    });
    return d;
  };

  return (
    <div className="relative">
      <svg width={geo.width} height={height} role="img" aria-label={ariaLabel}>
        <g aria-hidden="true">
          {[0, yTop / 2, yTop].map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={geo.width - PAD_R} y1={y(v)} y2={y(v)} className="decorative-mark stroke-gray-200 dark:stroke-gray-800" />
              <text x={PAD_L - 6} y={y(v) + 4} textAnchor="end" className={AXIS_TEXT}>
                {formatStoryValue(unit, v)}
              </text>
            </g>
          ))}
          {hover != null && (
            <line
              x1={geo.cx(hover)}
              x2={geo.cx(hover)}
              y1={top}
              y2={bottom}
              className="decorative-mark stroke-gray-300 dark:stroke-gray-600"
            />
          )}
          {items.map((it) => (
            <g key={it.meta.id}>
              {it.points.map((p, i) =>
                p.value == null ? null : (
                  <circle
                    key={i}
                    cx={geo.cx(i)}
                    cy={y(p.value)}
                    r={p.thin ? 2.5 : 2.25}
                    fill={p.thin ? 'none' : STORY_SERIES_COLOR[it.meta.id]}
                    stroke={STORY_SERIES_COLOR[it.meta.id]}
                    strokeWidth={p.thin ? 1 : 0}
                    opacity={p.thin ? 0.35 : 0.45}
                  />
                ),
              )}
              <path
                d={linePath(it.points)}
                fill="none"
                stroke={STORY_SERIES_COLOR[it.meta.id]}
                strokeWidth={2}
                strokeDasharray={it.meta.dotted ? '2 4' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}
        </g>
        <EventMarkerLines markers={markers} top={top} bottom={bottom} />
        <XLabels geo={geo} weeks={weeks} y={height - 4} />
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
      {hover != null && (
        <FloatingTip x={geo.cx(hover)} y={top} width={geo.width} centered>
          {tip(hover)}
        </FloatingTip>
      )}
    </div>
  );
}

function SeriesTipLines({ items, week }: { items: StripItem[]; week: number }): JSX.Element {
  return (
    <>
      {items.map((it) => {
        const p = it.points[week];
        if (p == null) return null;
        return (
          <div key={it.meta.id} className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-[1px]" style={{ background: STORY_SERIES_COLOR[it.meta.id] }} />
            {it.meta.label}: {pointLine(it.meta, p)}
          </div>
        );
      })}
    </>
  );
}

// ── One small chart (the refinement panel) ─────────────────────────────────────────────────

const SM_PAD_L = 36;
const SM_PAD_R = 8;
const SM_TOP = 10;
const SM_PLOT = 72;
const SM_HEIGHT = SM_TOP + SM_PLOT + 18;

const HEADLINE_INK: Record<'better' | 'worse', string> = {
  better: 'text-emerald-700 dark:text-emerald-400',
  worse: 'text-rose-700 dark:text-rose-400',
};

function SmallMultiple({
  meta,
  points,
  weeks,
  shift,
  width,
  labels,
}: {
  meta: StoryHealthSeriesMeta;
  points: StoryHealthPoint[];
  weeks: StoryHealthWeek[];
  shift: StoryHealthShift | undefined;
  width: number;
  labels: boolean;
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const n = weeks.length;
  const band = Math.max(width - SM_PAD_L - SM_PAD_R, 1) / Math.max(n, 1);
  const cx = (i: number): number => SM_PAD_L + band * (i + 0.5);
  const bottom = SM_TOP + SM_PLOT;
  const y = (v: number): number => SM_TOP + SM_PLOT * (1 - Math.min(Math.max(v, 0), 100) / 100);
  const color = STORY_SERIES_COLOR[meta.id];
  const head = rollingHeadline(points);
  const verdict = head == null ? null : headlineVerdict(shift, head.first, head.current);
  const firstWeek = head == null ? null : weeks[head.firstWeek];

  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.rolling == null) {
      pen = false;
      return;
    }
    d += `${pen ? ' L' : ' M'} ${cx(i)} ${y(p.rolling)}`;
    pen = true;
  });

  const mid = Math.floor((n - 1) / 2);
  const xLabels: { i: number; text: string; anchor: 'start' | 'middle' | 'end' }[] =
    n === 0
      ? []
      : [
          { i: 0, text: weekLabel(weeks[0]!.weekStart), anchor: 'start' },
          { i: mid, text: weekLabel(weeks[mid]!.weekStart), anchor: 'middle' },
          { i: n - 1, text: 'This week', anchor: 'end' },
        ];
  const marker: ChartEventMarker[] =
    shift == null
      ? []
      : [{ key: 'shift', x: cx(shift.week), dashed: true, icon: null, count: 1, label: shiftLine(shift), lines: [] }];
  const shiftStyle = shift?.verdict == null ? null : HEADLINE_INK[shift.verdict];
  const isLabel = meta.source === 'label';

  return (
    <div data-testid={`story-health-sm-${meta.id}`} className="min-w-0">
      <div className={`text-xs ${BODY}`}>{meta.label}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-50">
          {head == null ? '—' : formatStoryValue(meta.unit, head.current)}
        </span>
        {head != null && firstWeek != null && (
          <span className={`text-[11px] tabular-nums ${verdict == null ? MUTED : HEADLINE_INK[verdict]}`}>
            {formatStoryChange(meta.unit, head.first, head.current)} since {weekLabel(firstWeek.weekStart)}
          </span>
        )}
        {head == null && <span className={`text-[11px] ${MUTED}`}>Too few stories yet</span>}
      </div>
      <div className="relative">
        <svg width={width} height={SM_HEIGHT} role="img" aria-label={`${meta.label}, week by week`}>
          <g aria-hidden="true">
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line x1={SM_PAD_L} x2={width - SM_PAD_R} y1={y(v)} y2={y(v)} className="decorative-mark stroke-gray-200 dark:stroke-gray-800" />
                {v !== 50 && (
                  <text x={SM_PAD_L - 5} y={y(v) + 4} textAnchor="end" className={AXIS_TEXT}>
                    {v}%
                  </text>
                )}
              </g>
            ))}
            {hover != null && (
              <line x1={cx(hover)} x2={cx(hover)} y1={SM_TOP} y2={bottom} className="decorative-mark stroke-gray-300 dark:stroke-gray-600" />
            )}
            {points.map((p, i) =>
              p.value == null ? null : (
                <circle
                  key={i}
                  cx={cx(i)}
                  cy={y(p.value)}
                  r={p.thin ? 2.25 : 2}
                  fill={p.thin ? 'none' : color}
                  stroke={color}
                  strokeWidth={p.thin ? 1 : 0}
                  opacity={p.thin ? 0.3 : 0.4}
                />
              ),
            )}
            <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            {xLabels.map((l) => (
              <text
                key={l.i}
                x={l.anchor === 'start' ? SM_PAD_L : l.anchor === 'end' ? width - SM_PAD_R : cx(l.i)}
                y={SM_HEIGHT - 3}
                textAnchor={l.anchor}
                className={AXIS_TEXT}
              >
                {l.text}
              </text>
            ))}
          </g>
          <EventMarkerLines markers={marker} top={SM_TOP} bottom={bottom} />
          {weeks.map((_, i) => (
            <rect
              key={i}
              x={SM_PAD_L + band * i}
              y={SM_TOP}
              width={band}
              height={SM_PLOT}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            />
          ))}
        </svg>
        {hover != null && weeks[hover] != null && points[hover] != null && (
          <FloatingTip x={cx(hover)} y={SM_TOP} width={width} centered>
            <div className="font-medium">{storyWeekHead(weeks[hover]!)}</div>
            <div>{pointLine(meta, points[hover]!)}</div>
            {isLabel && labels && <div>{coverageLine(weeks[hover]!)}</div>}
            {shift != null && shift.week === hover && <div>{shiftLine(shift)}</div>}
          </FloatingTip>
        )}
      </div>
      {shift != null && weeks[shift.week] != null && (
        <div
          className={`text-[11px] tabular-nums ${shiftStyle ?? BODY}`}
          aria-label={`Shift from the week of ${weekLabel(weeks[shift.week]!.weekStart)}: ${formatStoryValue(meta.unit, shift.before)} over ${shiftUnits(shift.beforeN, shift.nOf)}, then ${formatStoryValue(meta.unit, shift.after)} over ${shiftUnits(shift.afterN, shift.nOf)}`}
        >
          From {weekLabel(weeks[shift.week]!.weekStart)}: {formatStoryValue(meta.unit, shift.before)} →{' '}
          {formatStoryValue(meta.unit, shift.after)}
          {shift.verdict != null && <span> · {shift.verdict === 'better' ? 'better' : 'worse'}</span>}
        </div>
      )}
    </div>
  );
}

function SmallMultipleGroup({
  title,
  icon,
  items,
  weeks,
  shifts,
  width,
  labels,
}: {
  title: string;
  icon?: ReactNode;
  items: { meta: StoryHealthSeriesMeta; points: StoryHealthPoint[] }[];
  weeks: StoryHealthWeek[];
  shifts: StoryHealthShift[];
  width: number;
  labels: boolean;
}): JSX.Element | null {
  if (items.length === 0) return null;
  const cols = smallMultipleColumns(width);
  const gap = 24;
  const cell = Math.max(Math.floor((width - gap * (cols - 1)) / cols), 1);
  return (
    <div role="group" aria-label={title} className="space-y-2">
      <div className={`flex items-center gap-1 text-[11px] font-medium ${BODY}`}>
        {icon}
        {title}
      </div>
      <div className="grid gap-x-6 gap-y-4" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {items.map((it) => (
          <SmallMultiple
            key={it.meta.id}
            meta={it.meta}
            points={it.points}
            weeks={weeks}
            shift={shifts.find((sh) => sh.series === it.meta.id)}
            width={cell}
            labels={labels}
          />
        ))}
      </div>
    </div>
  );
}

// ── Legend ───────────────────────────────────────────────────────────────────────────────────

function LegendToggle({
  meta,
  on,
  onToggle,
}: {
  meta: StoryHealthSeriesMeta;
  on: boolean;
  onToggle: () => void;
}): JSX.Element {
  const color = STORY_SERIES_COLOR[meta.id];
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${
        on
          ? 'border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-200'
          : 'border-gray-200 text-gray-500 line-through dark:border-gray-800 dark:text-gray-400'
      }`}
    >
      <svg width={14} height={6} aria-hidden="true" className="shrink-0" opacity={on ? 1 : 0.4}>
        <line x1={1} x2={13} y1={3} y2={3} stroke={color} strokeWidth={2} strokeLinecap="round" strokeDasharray={meta.dotted ? '1 3' : undefined} />
      </svg>
      {meta.label}
    </button>
  );
}

// ── Shift markers + the before/after lens ────────────────────────────────────────────────────

function markersFor(
  clusters: ShiftCluster[],
  geo: Geometry,
  weeks: StoryHealthWeek[],
  selected: number | null,
  onSelect: (week: number) => void,
): ChartEventMarker[] {
  return clusters.map((c) => {
    const w = weeks[c.week];
    const when = w != null ? `Week of ${weekLabel(w.weekStart)}` : '';
    const lines = c.shifts.map(shiftLine);
    return {
      key: `w${c.week}`,
      x: geo.cx(c.week),
      dashed: true,
      selected: selected === c.week,
      icon: <ChartIcon size={11} />,
      count: c.shifts.length,
      label: `${when}: ${c.shifts.length === 1 ? 'a shift' : `${c.shifts.length} shifts`}. Compare before and after.`,
      lines: [w != null ? `Shift from the week of ${weekLabel(w.weekStart)}` : 'Shift', ...lines],
      onSelect: () => onSelect(c.week),
    };
  });
}

const VERDICT_STYLE: Record<'better' | 'worse', { bar: string; ink: string }> = {
  better: { bar: 'bg-emerald-500', ink: 'text-emerald-700 dark:text-emerald-400' },
  worse: { bar: 'bg-rose-500', ink: 'text-rose-700 dark:text-rose-400' },
};

function ShiftLens({
  week,
  shifts,
  onClose,
}: {
  week: StoryHealthWeek;
  shifts: StoryHealthShift[];
  onClose: () => void;
}): JSX.Element {
  return (
    <section
      data-testid="story-health-lens"
      aria-label={`Before and after the week of ${weekLabel(week.weekStart)}`}
      className="rounded-lg border border-sky-200 bg-sky-50/40 p-3 dark:border-sky-900 dark:bg-sky-950/30"
    >
      <div className="flex items-start justify-between gap-2">
        <h5 className="text-xs font-semibold text-gray-800 dark:text-gray-100">
          Before and after the week of {weekLabel(week.weekStart)}
        </h5>
        <div className="flex items-center gap-2">
          <InfoButton title="Before and after">
            <ShiftRuleInfo />
            <p className="mt-2">Both bars in a row share one scale.</p>
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
        {shifts.map((s) => {
          const meta = STORY_HEALTH_SERIES_BY_ID[s.series];
          const style = s.verdict == null ? null : VERDICT_STYLE[s.verdict];
          const word = shiftVerdictWord(s);
          const max = meta.unit === 'pct' ? 100 : Math.max(s.before, s.after, 1e-9);
          const pct = (v: number): string => `${Math.max((Math.max(v, 0) / max) * 100, v > 0 ? 1.5 : 0)}%`;
          const change = formatStoryChange(meta.unit, s.before, s.after);
          return (
            <li key={s.series}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className={BODY}>{meta.label}</span>
                <span className={`shrink-0 font-medium tabular-nums ${style?.ink ?? BODY}`}>
                  {word != null ? `${word} · ${change}` : change}
                </span>
              </div>
              <div
                className={`mt-1 grid grid-cols-[3.25rem_1fr_3.5rem] items-center gap-x-2 gap-y-1 text-[11px] ${MUTED}`}
                role="img"
                aria-label={`${meta.label}: before ${formatStoryValue(meta.unit, s.before)} over ${shiftUnits(s.beforeN, s.nOf)}, after ${formatStoryValue(meta.unit, s.after)} over ${shiftUnits(s.afterN, s.nOf)}${word != null ? `, ${word.toLowerCase()}` : ''}`}
              >
                <span>Before</span>
                <span className="h-2.5 rounded-sm bg-gray-100 dark:bg-gray-800">
                  <span className="block h-full rounded-sm bg-gray-300 dark:bg-gray-600" style={{ width: pct(s.before) }} />
                </span>
                <span className={`text-right tabular-nums ${BODY}`}>{formatStoryValue(meta.unit, s.before)}</span>
                <span>After</span>
                <span className="h-2.5 rounded-sm bg-gray-100 dark:bg-gray-800">
                  <span className={`block h-full rounded-sm ${style?.bar ?? 'bg-gray-500 dark:bg-gray-400'}`} style={{ width: pct(s.after) }} />
                </span>
                <span className={`text-right tabular-nums ${style?.ink ?? BODY}`}>{formatStoryValue(meta.unit, s.after)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── The label run ────────────────────────────────────────────────────────────────────────────

function runOutcome(run: StoryLabelRunStatus): string | null {
  const of = `${run.labelled} of ${run.total}`;
  switch (run.stoppedBy) {
    case 'budget':
      return `Stopped at the US$${run.budgetUsd.toFixed(2)} limit: ${of} labelled.`;
    case 'cancelled':
      return `Cancelled: ${of} labelled.`;
    case 'auth':
    case 'runtime':
      return `Could not reach Claude: ${of} labelled.`;
    case 'failed':
      return `The run failed: ${of} labelled.`;
    default:
      break;
  }
  if (run.state === 'failed') return `The run failed: ${of} labelled.`;
  if (run.failed > 0) return `${run.failed} ${run.failed === 1 ? 'story' : 'stories'} could not be labelled. Press again to retry.`;
  return null;
}

function LabelAction({ data, workspaceId }: { data: StoryHealthResponse; workspaceId: number | null }): JSX.Element | null {
  const on = useStoryLabelsOn() && data.labels;
  const hint = data.labelRun?.state === 'running';
  const runQ = useStoryLabelRun(on && hint);
  const starting = useStoryLabelStarting(workspaceId);
  const start = useStartStoryLabelRun(workspaceId);
  const cancel = useCancelStoryLabelRun();
  if (!on) return null;

  const run = runQ.data !== undefined ? runQ.data.run : data.labelRun;
  const running = run?.state === 'running';
  const here = run != null && run.workspaceId === data.workspaceId;
  const n = labelPressCount(data.unlabelled, STORY_LABEL_RUN_CAP);

  let action: ReactNode = null;
  if (running && here) {
    const value = run.total > 0 ? (run.done / run.total) * 100 : 0;
    action = (
      <div className="flex w-full items-center gap-2 sm:w-72">
        <div className="flex-1">
          <RegenProgressBar
            active
            value={value}
            label="Labelling stories"
            sub={`${run.done} of ${run.total} · US$${run.costUsd.toFixed(2)}`}
          />
        </div>
        <button
          type="button"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
          className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"
        >
          Cancel
        </button>
      </div>
    );
  } else if (running) {
    action = <span className={`text-xs ${BODY}`}>Labelling stories in another workspace.</span>;
  } else if (starting) {
    action = (
      <div className="w-full sm:w-72">
        <RegenProgressBar active label="Starting" timeConstantSec={3} sub="Starting…" />
      </div>
    );
  } else if (n > 0) {
    action = (
      <AiRunGate>
        <button
          type="button"
          onClick={() => start.mutate()}
          className="inline-flex items-center gap-1 rounded border border-ai-border px-2 py-1 text-xs font-medium text-ai-ink hover:bg-ai-surface-2"
        >
          <SparkleIcon size={12} className="text-ai-signal" />
          Label {n} {n === 1 ? 'story' : 'stories'}
        </button>
      </AiRunGate>
    );
  }

  const outcome = run != null && here && !running ? runOutcome(run) : null;
  return (
    <div className="flex flex-col items-end gap-1">
      {action}
      {start.isError && !starting && (
        <p className="text-xs text-rose-700 dark:text-rose-400">{start.error.message || 'Could not start labelling.'}</p>
      )}
      {cancel.isError && <p className="text-xs text-rose-700 dark:text-rose-400">Could not cancel the run.</p>}
      {outcome != null && <p className={`text-xs ${BODY}`}>{outcome}</p>}
    </div>
  );
}

// ── ⓘ texts ──────────────────────────────────────────────────────────────────────────────────

function SectionInfo({ data }: { data: StoryHealthResponse }): JSX.Element {
  return (
    <div className="space-y-2">
      <p>
        The last {data.span.weeks} weeks, one point per week, in this workspace&rsquo;s time zone (
        {data.timeZone}). Each line is the last {STORY_HEALTH_ROLLING_WEEKS} weeks taken together; the
        faint dots are single weeks.
      </p>
      <p>
        <strong>Written</strong> puts each story in the week its ticket was created. A ticket with no
        created date uses the week its first pull request was opened. <strong>Delivered</strong> puts
        each story in the week its last pull request merged.
      </p>
      <p>
        A week with fewer than {STORY_HEALTH_THIN_N} stories behind a measure is drawn hollow and left
        out of the lines. A dashed line marks a shift: a change too large to be chance. Each panel&rsquo;s
        info button says how it is tested.
      </p>
      {data.labels && (
        <p>
          Measures marked <strong>Labelled by Claude</strong> come from Claude ({modelName(STORY_LABEL_MODEL)})
          reading each ticket against a fixed set of questions (version {STORY_RUBRIC_VERSION}). Run twice on
          the same tickets, a week&rsquo;s figure moved by about {STORY_LABEL_NOISE.typicalPoints} points
          typically and up to {STORY_LABEL_NOISE.p90Points} at worst. A week&rsquo;s figure covers only its
          labelled stories; hover a week to see how many. A ticket whose text changes is labelled again.
          Labelling runs on your own Claude Code login or Anthropic API key.
        </p>
      )}
    </div>
  );
}

/** The shift rule, read from the shared constants the server tests against. */
function ShiftRuleInfo({ only }: { only?: 'rate' | 'time' }): JSX.Element {
  return (
    <div className="space-y-2">
      {only !== 'time' && (
        <p>
          For a percentage, every week before a split is added up and compared with every week from it on:
          stories, or criteria for the criteria measures. A shift needs at least {STORY_SHIFT_MIN_STORIES}{' '}
          stories on each side, a gap of at least {STORY_SHIFT_MIN_POINTS} points, and a difference that
          chance would give less than 1 time in 100 (z of {STORY_SHIFT_Z} or more). The before and after
          figures are those totals.
        </p>
      )}
      {only !== 'rate' && (
        <p>
          For working time and pull requests per story, the shift is found on the {STORY_HEALTH_ROLLING_WEEKS}-week
          line: a step at least {CHANGEPOINT_Z} times its usual spread, and at least{' '}
          {STORY_SHIFT_MIN_HOURS} working hours (or {STORY_SHIFT_MIN_PRS} pull request) between the medians
          before and after. Weeks with fewer than {STORY_HEALTH_THIN_N} stories are left out.
        </p>
      )}
      <p>
        Each measure shows at most one shift. Green is a change for the better, red for the worse; grey
        means the measure has no better direction.
      </p>
    </div>
  );
}

function RefinementInfo({ labels }: { labels: boolean }): JSX.Element {
  return (
    <div className="space-y-2">
      <p>
        One chart per measure. The large figure is the latest {STORY_HEALTH_ROLLING_WEEKS}-week value; beside
        it, the change since the first one in the chart. That change is coloured only when the measure
        shows a shift, marked by a dashed line. Each chart runs from 0 to 100%.
      </p>
      {labels && (
        <p>
          The three criteria measures count every acceptance criterion of the week&rsquo;s labelled
          stories. The story measures count labelled stories. Hover a week to see how many were labelled.
        </p>
      )}
      <p>
        <strong>Stories with criteria in the criteria field</strong> and <strong>Stories saying who
        benefits and why</strong> are counted by code over every story written that week with a pull
        request, open or merged. A story whose ticket we could not read is left out. Who benefits
        means an &ldquo;As a &hellip; I want &hellip; so that&rdquo; line, or a &ldquo;so that&rdquo;
        clause naming who gains.
      </p>
      <ShiftRuleInfo only="rate" />
    </div>
  );
}

function DeliveryInfo(): JSX.Element {
  return (
    <div className="space-y-2">
      <p>
        Working time runs from the first pull request opened to the last one merged, in working hours,
        and is the median within each size. Size is lines changed across the story&rsquo;s merged pull
        requests: small under {STORY_SIZE_BANDS.mediumFrom}, medium {STORY_SIZE_BANDS.mediumFrom} to{' '}
        {STORY_SIZE_BANDS.largeFrom - 1}, large {STORY_SIZE_BANDS.largeFrom} or more. A story of unknown
        size is left out of these lines and counted.
      </p>
      <p>Pull requests per story is the median count. Criteria met covers only stories with a ticket review.</p>
      <ShiftRuleInfo />
    </div>
  );
}

// ── The section ──────────────────────────────────────────────────────────────────────────────

/** Keyed by workspace: hidden lines and a picked shift belong to ONE workspace's chart. */
export function StoryHealth({ workspaceId }: { workspaceId: number | null }): JSX.Element | null {
  return <StoryHealthFor key={workspaceId ?? 'none'} workspaceId={workspaceId} />;
}

function StoryHealthFor({ workspaceId }: { workspaceId: number | null }): JSX.Element | null {
  const { periodReports } = useProCapabilities();
  const q = useStoryHealth(workspaceId);
  const [ref, width] = useChartWidth();
  const [hidden, setHidden] = useState<Set<StoryHealthSeriesId>>(() => new Set());
  // ⚠ The picked shift is held by `weekStart`, never by index: a week roll-over shifts every index.
  const [picked, setPicked] = useState<{ panel: StoryHealthPanel; weekStart: string } | null>(null);
  // A body without `weeks` (an older server, a stubbed route answering `{}`) is no data, never
  // dereferenced — a render-time throw blanks the whole SPA.
  const data = q.data != null && Array.isArray(q.data.weeks) && Array.isArray(q.data.series) ? q.data : undefined;

  const toggle = (id: StoryHealthSeriesId): void =>
    setHidden((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refinement = useMemo(() => (data == null ? [] : panelSeries(data, 'refinement')), [data]);
  const delivery = useMemo(() => (data == null ? [] : panelSeries(data, 'delivery')), [data]);

  if (!periodReports) return null;
  if (data != null && !data.trackerOn) return null;

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="flex items-center gap-1 text-sm font-semibold text-gray-800 dark:text-gray-100">
        Story health
        <span className={`text-xs font-normal ${MUTED}`}>· {STORY_HEALTH_SPAN_LABEL}</span>
        {data != null && (
          <InfoButton title="Story health" width="lg">
            <SectionInfo data={data} />
          </InfoButton>
        )}
      </h3>
      <div className="ml-auto">{data != null && <LabelAction data={data} workspaceId={workspaceId} />}</div>
    </div>
  );

  if (data == null) {
    return (
      <section data-testid="story-health" className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
        {header}
        <p className={`text-sm ${q.isError ? 'text-rose-700 dark:text-rose-400' : MUTED}`}>
          {q.isError ? 'Could not load story health.' : 'Loading…'}
        </p>
      </section>
    );
  }

  const weeks = data.weeks;
  const geo = geometryFor(width, weeks.length);
  const written = weeks.reduce((s, w) => s + w.storiesCreated, 0);
  const merged = weeks.reduce((s, w) => s + w.storiesMerged, 0);
  const facts = [
    `${written} ${written === 1 ? 'story' : 'stories'} written`,
    `${merged} delivered`,
    ...(data.createdFallbackTotal > 0 ? [`${data.createdFallbackTotal} dated by first pull request`] : []),
    ...(data.unsizedTotal > 0 ? [`${data.unsizedTotal} of unknown size`] : []),
  ];

  const visible = new Set<StoryHealthSeriesId>(delivery.map((x) => x.meta.id).filter((id) => !hidden.has(id)));
  const shiftsIn = (panel: StoryHealthPanel): StoryHealthShift[] =>
    data.shifts.filter((s) => STORY_HEALTH_SERIES_BY_ID[s.series]?.panel === panel);
  const delClusters = clusterShifts(shiftsIn('delivery'), visible);
  const pickedIdx = picked == null ? null : weekIndex(weeks, picked.weekStart);
  const select = (panel: StoryHealthPanel) => (week: number) => {
    const ws = weeks[week]?.weekStart ?? null;
    setPicked((p) => (ws == null || (p?.panel === panel && p.weekStart === ws) ? null : { panel, weekStart: ws }));
  };
  const delMarkers = markersFor(delClusters, geo, weeks, picked?.panel === 'delivery' ? pickedIdx : null, select('delivery'));
  const lensCluster =
    picked == null || pickedIdx == null
      ? null
      : delClusters.find((c) => c.week === pickedIdx) ?? null;
  const lensWeek = lensCluster == null ? null : weeks[lensCluster.week];
  const lens =
    lensCluster != null && lensWeek != null ? (
      <ShiftLens week={lensWeek} shifts={lensCluster.shifts} onClose={() => setPicked(null)} />
    ) : null;

  const refShifts = shiftsIn('refinement');
  const labelItems = refinement.filter((x) => x.meta.source === 'label').map((x) => ({ meta: x.meta, points: x.series.points }));
  const codeItems = refinement.filter((x) => x.meta.source === 'code').map((x) => ({ meta: x.meta, points: x.series.points }));

  return (
    <section data-testid="story-health" className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      {header}
      <p className={`text-xs ${MUTED}`}>{facts.join(' · ')}</p>
      {data.truncated && (
        <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300">
          <WarningIcon size={12} className="mt-0.5 shrink-0" />
          <span>The oldest stories are not counted: the scan hit its limit.</span>
        </p>
      )}

      <div ref={ref} className="w-full">
        {width === 0 ? null : (
          <div className="space-y-5">
            <div data-testid="story-health-refinement" className="space-y-2">
              <h4 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
                How stories are written
                <span className={`font-normal ${MUTED}`}>· by the week the ticket was created</span>
                <InfoButton title="How stories are written">
                  <RefinementInfo labels={data.labels} />
                </InfoButton>
              </h4>
              <div className="space-y-4">
                <SmallMultipleGroup
                  title="Labelled by Claude"
                  icon={<SparkleIcon size={11} className="text-ai-signal" />}
                  items={labelItems}
                  weeks={weeks}
                  shifts={refShifts}
                  width={width}
                  labels={data.labels}
                />
                <SmallMultipleGroup
                  title="Counted by code"
                  items={codeItems}
                  weeks={weeks}
                  shifts={refShifts}
                  width={width}
                  labels={data.labels}
                />
              </div>
            </div>

            <div data-testid="story-health-delivery" className="space-y-2">
              <h4 className="flex items-center gap-1 text-xs font-semibold text-gray-700 dark:text-gray-200">
                How stories are delivered
                <span className={`font-normal ${MUTED}`}>· by the week of the last merge</span>
                <InfoButton title="How stories are delivered">
                  <DeliveryInfo />
                </InfoButton>
              </h4>
              <div className="flex flex-wrap items-center gap-1.5">
                {delivery.map((x) => (
                  <LegendToggle key={x.meta.id} meta={x.meta} on={!hidden.has(x.meta.id)} onToggle={() => toggle(x.meta.id)} />
                ))}
              </div>
              <EventMarkerRail markers={delMarkers} width={width} />
              {DELIVERY_STRIPS.map((strip) => {
                const items: StripItem[] = delivery
                  .filter((x) => strip.ids.includes(x.meta.id) && !hidden.has(x.meta.id))
                  .map((x) => ({ meta: x.meta, points: x.series.points }));
                if (items.length === 0) return null;
                const unit = (items[0] as StripItem).meta.unit;
                return (
                  <div key={strip.key}>
                    <div className={`text-[11px] ${BODY}`}>{strip.title}</div>
                    <SeriesStrip
                      weeks={weeks}
                      geo={geo}
                      unit={unit}
                      items={items}
                      markers={delMarkers}
                      height={strip.key === 'time' ? 150 : 110}
                      ariaLabel={`${strip.title}, week by week`}
                      tip={(i) => {
                        const w = weeks[i];
                        if (w == null) return null;
                        return (
                          <>
                            <div className="font-medium">{storyWeekHead(w)}</div>
                            <div>{mergedLine(w)}</div>
                            <SeriesTipLines items={items} week={i} />
                          </>
                        );
                      }}
                    />
                  </div>
                );
              })}
              {picked?.panel === 'delivery' && lens}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
