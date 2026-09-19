import { useMemo, useState } from 'react';
import type { CourtShare, FlowBudgetRow, FlowPrRow, PrCourt } from '@pierre-review/shared';
import { FLOW_BUDGET_LABEL } from '@pierre-review/shared';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { useChartWidth } from '../charts/common.js';
import { CheckCircleIcon, TimerIcon, WarningIcon } from '../Icons.js';
import { metaFor } from './AttentionCards.js';
import { COURT_ORDER, COURT_SHORT } from './bottlenecksModel.js';
import {
  BUDGET_SUB,
  budgetScale,
  dotRadius,
  formatCount,
  formatWorkHours,
  scatterTicks,
  scatterYRange,
  SCATTER_FLOOR_HOURS,
  trianglePoint,
  VERDICT_LABEL,
} from './chronologyModel.js';

// Chronology's working-hours charts: each wait against its budget (the headline), every pull
// request as one dot, and where each sits between the three courts (context only).
//
// ⚠ COURT COLOURS ARE THE VALIDATED SET, NOT THE APP'S OLD DARK SHADES. amber-500 / teal-600 /
// indigo-500 on light and amber-600 / teal-600 / indigo-500 on dark were run through the palette
// validator (lightness band, CVD separation, contrast) against both grounds; the -400 shades the
// panel used in dark mode failed the lightness band. Identity is never colour alone: every chart
// here has a legend with words, and the scatter has a table beside it.
//
// ⚠ TEXT IS 11PX OR LARGER and wears grey text tokens, never a series colour.

export const COURT_FILL: Record<PrCourt, string> = {
  reviewer: 'fill-amber-500 dark:fill-amber-600',
  author: 'fill-teal-600 dark:fill-teal-600',
  landing: 'fill-indigo-500 dark:fill-indigo-500',
};
export const COURT_SWATCH: Record<PrCourt, string> = {
  reviewer: 'bg-amber-500 dark:bg-amber-600',
  author: 'bg-teal-600 dark:bg-teal-600',
  landing: 'bg-indigo-500 dark:bg-indigo-500',
};

const AXIS_TEXT = 'fill-gray-500 dark:fill-gray-400 text-[11px]';

/** The evidence rows carry no author identity, so the lookup is always empty by construction. */
const NO_AUTHOR_LOOKUP = new Map<number, never>() as never;

/** Opens a pull request the way every other Activity card does — same tab, same Back arming. */
export function useOpenFlowPr(): (pr: {
  prId: number;
  prNumber: number;
  prTitle: string;
  repoFullName: string;
}) => void {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  return (pr) =>
    openPrDetailTab(
      metaFor(
        { prId: pr.prId, prNumber: pr.prNumber, prTitle: pr.prTitle, repoFullName: pr.repoFullName },
        NO_AUTHOR_LOOKUP,
      ),
      { fromActivity: true },
    );
}

export function CourtLegend({ prefix = '' }: { prefix?: string }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {COURT_ORDER.map((court) => (
        <span
          key={court}
          className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"
        >
          <span className={`h-2.5 w-2.5 rounded-full ${COURT_SWATCH[court]}`} />
          {prefix}
          {COURT_SHORT[court].toLowerCase()}
        </span>
      ))}
    </div>
  );
}

// ── Each wait against its budget ─────────────────────────────────────────────────────────────

const VERDICT_CHIP: Record<NonNullable<FlowBudgetRow['verdict']>, string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  ok: 'text-amber-700 dark:text-amber-400',
  slow: 'text-rose-700 dark:text-rose-400',
};

function VerdictChip({ verdict }: { verdict: FlowBudgetRow['verdict'] }): JSX.Element | null {
  if (verdict == null) return null;
  const Icon = verdict === 'good' ? CheckCircleIcon : verdict === 'ok' ? TimerIcon : WarningIcon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${VERDICT_CHIP[verdict]}`}>
      <Icon size={12} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function BudgetBullet({
  row,
  max,
  ticks,
}: {
  row: FlowBudgetRow;
  max: number;
  ticks: number[];
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const H = 46;
  const x0 = 6;
  const x1 = Math.max(x0 + 1, w - 10);
  const X = (h: number): number => x0 + (Math.min(Math.max(h, 0), max) / max) * (x1 - x0);
  const over = (h: number): boolean => h > max;
  const label =
    `${FLOW_BUDGET_LABEL[row.measure]}: median ${formatWorkHours(row.p50)}, three in four within ` +
    `${formatWorkHours(row.p75)}, slowest tenth ${formatWorkHours(row.p90)}; budget ` +
    `${formatWorkHours(row.good)}, acceptable up to ${formatWorkHours(row.ok)}.`;
  return (
    <div ref={ref} className="h-[46px] w-full">
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={label} className="block">
          <rect x={X(0)} y={4} width={X(row.good) - X(0)} height={22} className="fill-emerald-500/15 dark:fill-emerald-400/15" />
          <rect x={X(row.good)} y={4} width={Math.max(0, X(row.ok) - X(row.good))} height={22} className="fill-amber-400/20 dark:fill-amber-400/15" />
          <rect x={X(row.ok)} y={4} width={Math.max(0, X(max) - X(row.ok))} height={22} className="fill-rose-500/10 dark:fill-rose-400/10" />
          {row.prs > 0 && (
            <>
              {/* Whisker: three-in-four to the slowest tenth. */}
              <line x1={X(row.p75)} x2={X(row.p90)} y1={15} y2={15} className="stroke-gray-500 dark:stroke-gray-400" strokeWidth={1.5} />
              {over(row.p90) && (
                <path d={`M ${X(max) - 6} 11 L ${X(max)} 15 L ${X(max) - 6} 19`} fill="none" className="stroke-gray-500 dark:stroke-gray-400" strokeWidth={1.5} />
              )}
              {/* Bar: where three in four had finished. */}
              <rect x={X(0)} y={10} width={Math.max(2, X(row.p75) - X(0))} height={10} rx={2} className="fill-gray-800 dark:fill-gray-100" />
              {/* Dot: the median. */}
              <circle cx={X(row.p50)} cy={15} r={5} className="fill-white stroke-gray-800 dark:fill-gray-950 dark:stroke-gray-100" strokeWidth={2} />
            </>
          )}
          {/* The budget. */}
          <line x1={X(row.good)} x2={X(row.good)} y1={0} y2={30} className="stroke-gray-800 dark:stroke-gray-100" strokeWidth={1.5} strokeDasharray="4 3" />
          {ticks.map((t, i) => (
            <text
              key={t}
              x={X(t)}
              y={43}
              textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
              className={AXIS_TEXT}
            >
              {i === ticks.length - 1 ? `${t}h+` : `${t}h`}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

export function BudgetChart({
  rows,
  dayHours,
}: {
  rows: FlowBudgetRow[];
  dayHours: number;
}): JSX.Element {
  const { max, ticks } = budgetScale(rows, dayHours);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-emerald-500/25 dark:bg-emerald-400/25" />
          within budget
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-amber-400/30 dark:bg-amber-400/25" />
          acceptable
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-sm bg-rose-500/15 dark:bg-rose-400/20" />
          slow
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-[1.5px] border-dashed border-gray-800 dark:border-gray-100" />
          budget
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-gray-800 dark:bg-gray-100" />
          three in four
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-gray-800 dark:border-gray-100" />
          median
        </span>
      </div>
      {rows.map((row) => (
        <div key={row.measure} data-testid={`budget-${row.measure}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="text-sm font-medium text-gray-800 dark:text-gray-100">
              {FLOW_BUDGET_LABEL[row.measure]}
            </span>
            <VerdictChip verdict={row.verdict} />
          </div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">
            {BUDGET_SUB[row.measure]}
            {row.prs > 0 && (
              <>
                {' · '}
                {formatCount(row.prs)} {row.prs === 1 ? 'pull request' : 'pull requests'} · median{' '}
                {formatWorkHours(row.p50)}, slowest tenth {formatWorkHours(row.p90)} or more · budget{' '}
                {formatWorkHours(row.good)}, acceptable to {formatWorkHours(row.ok)}
              </>
            )}
          </div>
          <div className="mt-1">
            <BudgetBullet row={row} max={max} ticks={ticks} />
          </div>
          <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{row.sentence}</p>
        </div>
      ))}
    </div>
  );
}

// ── Hover: the nearest point, within reach ───────────────────────────────────────────────────

interface Placed {
  pr: FlowPrRow;
  x: number;
  y: number;
}

function nearest(points: Placed[], mx: number, my: number, reach = 14): Placed | null {
  let best: Placed | null = null;
  let bestD = reach * reach;
  for (const p of points) {
    const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function PrTip({ p, width }: { p: Placed; width: number }): JSX.Element {
  const pr = p.pr;
  const total = pr.workHours.reviewer + pr.workHours.author + pr.workHours.landing;
  const left = Math.max(8, Math.min(p.x + 14, width - 268));
  return (
    <div
      className="pointer-events-none absolute z-20 w-64 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
      style={{ left, top: Math.max(0, p.y - 20) }}
    >
      <div className="font-medium text-gray-900 dark:text-gray-50">{pr.prTitle}</div>
      <div className="text-gray-500 dark:text-gray-400">
        {pr.repoFullName} #{pr.prNumber}
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-sm bg-gray-200 dark:bg-gray-800">
        {total > 0 &&
          COURT_ORDER.map((c) => (
            <div key={c} className={COURT_SWATCH[c]} style={{ width: `${(pr.workHours[c] / total) * 100}%` }} />
          ))}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 tabular-nums">
        <span>
          <span className="font-semibold">{formatWorkHours(pr.leadWorkHours)}</span> working
        </span>
        <span className="text-gray-500 dark:text-gray-400">{formatWorkHours(pr.leadHours)} on the clock</span>
        {COURT_ORDER.map((c) => (
          <span key={c}>
            {COURT_SHORT[c]} {formatWorkHours(pr.workHours[c])}
          </span>
        ))}
        <span>First look {pr.firstLookWorkHours == null ? '—' : formatWorkHours(pr.firstLookWorkHours)}</span>
        <span>
          {pr.rounds} {pr.rounds === 1 ? 'round' : 'rounds'} back
        </span>
        <span>{pr.lines == null ? 'Size unknown' : `${formatCount(pr.lines)} lines`}</span>
        {pr.ciRedHours > 0 && <span>Checks red {formatWorkHours(pr.ciRedHours)} (clock)</span>}
      </div>
      {pr.reachAreas.length > 0 && (
        <div className="mt-1 text-gray-500 dark:text-gray-400">Touches {pr.reachAreas.join(', ').replace(/_/g, ' ')}</div>
      )}
      <div className="mt-1 text-gray-500 dark:text-gray-400">Click to open</div>
    </div>
  );
}

// ── Every pull request, one dot ──────────────────────────────────────────────────────────────

function dateTicks(t0: number, t1: number): number[] {
  const span = t1 - t0;
  const DAY = 86_400_000;
  const stepDays = span <= 35 * DAY ? 7 : span <= 70 * DAY ? 14 : 21;
  const out: number[] = [];
  const start = new Date(t0);
  start.setUTCHours(0, 0, 0, 0);
  // Mondays, so the ticks are week boundaries a reader recognises.
  const toMonday = (start.getUTCDay() + 6) % 7;
  let t = start.getTime() + (7 - toMonday) * DAY;
  if (t - 7 * DAY >= t0) t -= 7 * DAY;
  for (; t <= t1; t += stepDays * DAY) out.push(t);
  return out;
}

export function LeadScatter({
  prs,
  budgetHours,
  p75Hours,
}: {
  prs: FlowPrRow[];
  budgetHours: number;
  p75Hours: number;
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<Placed | null>(null);
  const open = useOpenFlowPr();
  const H = 300;
  const L = 44;
  const R = 12;
  const T = 12;
  const B = 28;

  const geometry = useMemo(() => {
    if (w <= 0 || prs.length === 0) return null;
    const times = prs.map((p) => Date.parse(p.mergedAt));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    const { min, max } = scatterYRange(prs);
    const lmin = Math.log10(min);
    const lmax = Math.log10(max);
    const X = (t: number): number => (t1 > t0 ? L + ((t - t0) / (t1 - t0)) * (w - L - R) : (L + w - R) / 2);
    const Y = (h: number): number =>
      T + (1 - (Math.log10(Math.max(SCATTER_FLOOR_HOURS, h)) - lmin) / (lmax - lmin)) * (H - T - B);
    // Largest first, so small dots draw on top and stay reachable.
    const placed: Placed[] = [...prs]
      .sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
      .map((pr) => ({ pr, x: X(Date.parse(pr.mergedAt)), y: Y(pr.leadWorkHours) }));
    return { X, Y, placed, yTicks: scatterTicks(max), xTicks: dateTicks(t0, t1) };
  }, [prs, w]);
  const placed = geometry?.placed ?? [];

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        <CourtLegend prefix="mostly " />
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="h-0 w-4 border-t-[1.5px] border-dashed border-gray-800 dark:border-gray-100" />
          whole-PR budget
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="h-0 w-4 border-t border-dotted border-gray-500 dark:border-gray-400" />
          three in four
        </span>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">size = lines changed</span>
      </div>
      <div ref={ref} className="relative" style={{ height: H }}>
        {geometry != null && (
          <svg
            width={w}
            height={H}
            className="block"
            role="img"
            aria-label={`Every merged pull request by the day it merged and its working-hour lead time, on a log scale. ${prs.length} pull requests; the table below lists the slowest.`}
          >
            {geometry.yTicks.map((t) => (
              <g key={t.hours}>
                <line x1={L} x2={w - R} y1={geometry.Y(t.hours)} y2={geometry.Y(t.hours)} className="decorative-mark stroke-gray-200 dark:stroke-gray-800" strokeWidth={1} />
                <text x={L - 6} y={geometry.Y(t.hours) + 4} textAnchor="end" className={AXIS_TEXT}>
                  {t.label}
                </text>
              </g>
            ))}
            {geometry.xTicks.map((t) => (
              <text key={t} x={geometry.X(t)} y={H - 8} textAnchor="middle" className={AXIS_TEXT}>
                {new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}
              </text>
            ))}
            <line x1={L} x2={w - R} y1={geometry.Y(p75Hours)} y2={geometry.Y(p75Hours)} className="stroke-gray-500 dark:stroke-gray-400" strokeWidth={1} strokeDasharray="2 3" />
            <line x1={L} x2={w - R} y1={geometry.Y(budgetHours)} y2={geometry.Y(budgetHours)} className="stroke-gray-800 dark:stroke-gray-100" strokeWidth={1.5} strokeDasharray="4 3" />
            {placed.map((p) => (
              <circle
                key={p.pr.prId}
                cx={p.x}
                cy={p.y}
                r={dotRadius(p.pr.lines)}
                className={`${COURT_FILL[p.pr.dominant]} stroke-white dark:stroke-gray-950`}
                strokeWidth={1.5}
                fillOpacity={hover == null || hover.pr.prId === p.pr.prId ? 0.85 : 0.35}
              />
            ))}
            {hover != null && (
              <circle cx={hover.x} cy={hover.y} r={dotRadius(hover.pr.lines) + 2.5} fill="none" className="stroke-gray-900 dark:stroke-gray-50" strokeWidth={1.5} />
            )}
            <rect
              x={0}
              y={0}
              width={w}
              height={H}
              fill="transparent"
              style={{ cursor: hover ? 'pointer' : 'default' }}
              onMouseMove={(e) => setHover(nearest(placed, e.nativeEvent.offsetX, e.nativeEvent.offsetY))}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                if (hover) open(hover.pr);
              }}
            />
          </svg>
        )}
        {hover != null && w > 0 && <PrTip p={hover} width={w} />}
      </div>
      <div className="text-[11px] text-gray-500 dark:text-gray-400">
        Lead time in working hours, log scale · by the day it merged
      </div>
    </div>
  );
}

// ── Where each pull request sits between the three courts ─────────────────────────────────────

export function CourtTriangle({
  prs,
  overall,
}: {
  prs: FlowPrRow[];
  overall: CourtShare[];
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<Placed | null>(null);
  const open = useOpenFlowPr();
  const H = 300;
  const side = Math.min(w - 40, (H - 60) / 0.866);
  const cx = w / 2;
  const A = { x: cx, y: 24 }; // reviewer, top
  const Bv = { x: cx - side / 2, y: 24 + side * 0.866 }; // author, bottom-left
  const C = { x: cx + side / 2, y: 24 + side * 0.866 }; // landing, bottom-right
  const P = (rv: number, au: number, la: number): { x: number; y: number } => {
    const t = rv + au + la || 1;
    return {
      x: (rv * A.x + au * Bv.x + la * C.x) / t,
      y: (rv * A.y + au * Bv.y + la * C.y) / t,
    };
  };

  const placed = useMemo((): Placed[] => {
    if (w <= 0) return [];
    const out: Placed[] = [];
    for (const pr of prs) {
      const tp = trianglePoint(pr.workHours);
      if (tp == null) continue;
      // A small, deterministic nudge so a stack of identical shares reads as a stack.
      const jx = ((pr.prId * 37) % 11) - 5;
      const jy = ((pr.prId * 53) % 9) - 4;
      const p = P(tp.reviewer, tp.author, tp.landing);
      out.push({ pr, x: p.x + jx * 0.8, y: p.y + jy * 0.8 });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prs, w]);

  const by = new Map(overall.map((c) => [c.court, c.share]));
  const agg = P(by.get('reviewer') ?? 0, by.get('author') ?? 0, by.get('landing') ?? 0);
  const centre = P(1, 1, 1);
  const grid = [0.25, 0.5, 0.75];

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        <CourtLegend prefix="mostly " />
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="h-3 w-3 rounded-full border-2 border-gray-800 bg-white dark:border-gray-100 dark:bg-gray-950" />
          the workspace as a whole
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <span className="h-3 w-3 rounded-full border-[1.5px] border-dashed border-gray-500 dark:border-gray-400" />
          equal thirds
        </span>
      </div>
      <div ref={ref} className="relative" style={{ height: H }}>
        {w > 0 && side > 40 && (
          <svg
            width={w}
            height={H}
            className="block"
            role="img"
            aria-label="Each pull request placed by its share of working time waiting for a reviewer (top), for its author (bottom left) and to land (bottom right)."
          >
            {grid.map((f) => {
              const lines = [
                [P(f, 1 - f, 0), P(f, 0, 1 - f)],
                [P(0, f, 1 - f), P(1 - f, f, 0)],
                [P(0, 1 - f, f), P(1 - f, 0, f)],
              ];
              return lines.map(([a, b], i) => (
                <line key={`${f}-${i}`} x1={a!.x} y1={a!.y} x2={b!.x} y2={b!.y} className="decorative-mark stroke-gray-200 dark:stroke-gray-800" strokeWidth={1} />
              ));
            })}
            <path d={`M${A.x},${A.y} L${Bv.x},${Bv.y} L${C.x},${C.y} Z`} fill="none" className="stroke-gray-300 dark:stroke-gray-700" strokeWidth={1.2} />
            <text x={A.x} y={A.y - 10} textAnchor="middle" className={AXIS_TEXT}>
              All waiting for a reviewer
            </text>
            <text x={Bv.x} y={Bv.y + 18} textAnchor="start" className={AXIS_TEXT}>
              All with the author
            </text>
            <text x={C.x} y={C.y + 18} textAnchor="end" className={AXIS_TEXT}>
              All waiting to land
            </text>
            {placed.map((p) => (
              <circle
                key={p.pr.prId}
                cx={p.x}
                cy={p.y}
                r={3.5}
                className={`${COURT_FILL[p.pr.dominant]} stroke-white dark:stroke-gray-950`}
                strokeWidth={1}
                fillOpacity={hover == null || hover.pr.prId === p.pr.prId ? 0.8 : 0.3}
              />
            ))}
            <circle cx={centre.x} cy={centre.y} r={12} fill="none" className="stroke-gray-500 dark:stroke-gray-400" strokeWidth={1.5} strokeDasharray="3 3" />
            <circle cx={agg.x} cy={agg.y} r={7} className="fill-white stroke-gray-800 dark:fill-gray-950 dark:stroke-gray-100" strokeWidth={2.2} />
            <rect
              x={0}
              y={0}
              width={w}
              height={H}
              fill="transparent"
              style={{ cursor: hover ? 'pointer' : 'default' }}
              onMouseMove={(e) => setHover(nearest(placed, e.nativeEvent.offsetX, e.nativeEvent.offsetY, 10))}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                if (hover) open(hover.pr);
              }}
            />
          </svg>
        )}
        {hover != null && w > 0 && <PrTip p={hover} width={w} />}
      </div>
    </div>
  );
}
