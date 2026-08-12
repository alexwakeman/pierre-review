import { useState } from 'react';
import { useChartWidth, FloatingTip, PALETTE, ANOMALY_RING } from './common.js';

// A single-row coverage strip: one cell per day over the trend span (oldest→newest), cell
// opacity ∝ that day's activity. Silent RUNS (a normally-regular bot going quiet) are underlined
// in the anomaly colour — the "gaps in reviews" made visible. Hover a cell for its date + count.
// `startDate` is the ISO date of daily[0]; `silentRuns` are {startDay index, run length}.
// `opened` (optional, same length + alignment) overlays a second line = human-authored,
// non-draft PRs opened per day, drawn in a thin band ABOVE the cells so days a bot went dark
// while PRs kept coming read at a glance.
const OPENED_HUE = '#64748b'; // slate-500 — neutral, legible in both themes, distinct from bot hue

export function DayStrip({
  daily,
  startDate,
  silentRuns,
  color,
  height,
  opened,
  noun = 'action',
  openedVerb = 'opened',
  dailyGood,
  goodColor,
  goodNoun = 'passing commit',
}: {
  daily: number[];
  startDate: string;
  silentRuns: { startDay: number; days: number }[];
  color?: string;
  height?: number;
  opened?: number[];
  // What a cell's count counts, for the hover tooltip ("3 actions" / "3 failing commits").
  // Pluralized by appending 's'.
  noun?: string;
  // What the overlay line's PRs did, for the tooltip ("2 PRs opened" / "2 PRs merged").
  openedVerb?: string;
  // Optional SECOND per-day series (same length/alignment as `daily`) rendered as the LOWER
  // segment of a split cell — `daily` (the "bad" series, in `color`) stacks on top of it, each
  // segment's height proportional to its share of the day's total, the whole cell's opacity ∝
  // that total. A day where both are zero stays the neutral empty cell. Used by the trunk
  // strip: red failing commits over green passing ones.
  dailyGood?: number[];
  goodColor?: string;
  goodNoun?: string;
}): JSX.Element {
  const hue = color ?? PALETTE.blue;
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const hasOpened = opened != null && opened.length > 0;
  const lineBandH = hasOpened ? 14 : 0; // top band for the PR-opened sparkline
  const PAD_T = 2;
  const cellH = 16;
  const gapY = 5; // room under the cells for the silent-run underline
  const cellsY = PAD_T + lineBandH;
  const H = height ?? cellsY + cellH + gapY + 12;
  const n = Math.max(1, daily.length);
  const gridW = Math.max(w - 2, 1);
  const cellW = gridW / n;
  const hasGood = dailyGood != null && dailyGood.length > 0;
  const goodHue = goodColor ?? PALETTE.green;
  // In split mode a cell's intensity tracks the day's TOTAL (bad + good); single-series mode
  // keeps the original bad-only normalization.
  const totals = hasGood ? daily.map((v, i) => v + (dailyGood[i] ?? 0)) : daily;
  const max = Math.max(1, ...totals);
  const openedMax = hasOpened ? Math.max(1, ...opened) : 1;
  const startMs = Date.parse(startDate);
  const DAY = 86_400_000;

  const dateAt = (i: number): string => {
    const d = new Date(startMs + i * DAY);
    return d.toISOString().slice(0, 10);
  };

  // PR-opened sparkline points, mapped into the top band (higher count → higher up).
  const openedPoints = hasOpened
    ? opened
        .map((v, i) => {
          const y = PAD_T + (lineBandH - 2) * (1 - v / openedMax);
          return `${i * cellW + cellW / 2},${y.toFixed(1)}`;
        })
        .join(' ')
    : '';

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const i = Math.floor(e.nativeEvent.offsetX / cellW);
    setHover(i < 0 || i >= n ? null : i);
  };

  return (
    <div>
      <div ref={ref} className="relative" style={{ height: H }}>
        {w > 0 && (
          <svg width={w} height={H} className="block">
            {daily.map((c, i) => {
              const isHover = hover === i;
              const total = totals[i] ?? 0;
              const wRect = Math.max(cellW - 1, 1);
              if (!hasGood || total === 0) {
                // Single-series cell, or a split-mode day with nothing at all — the original
                // rendering (neutral gray when empty).
                const on = hasGood ? total > 0 : c > 0;
                return (
                  <rect
                    key={i}
                    x={i * cellW}
                    y={cellsY}
                    width={wRect}
                    height={cellH}
                    rx={1.5}
                    fill={on ? hue : 'currentColor'}
                    className={on ? '' : 'text-gray-100 dark:text-gray-800'}
                    fillOpacity={on ? 0.2 + 0.8 * (c / max) : 1}
                    stroke={isHover ? hue : 'none'}
                    strokeWidth={isHover ? 1.5 : 0}
                  />
                );
              }
              // Split cell: bad (`daily`, hue) on top, good below, heights ∝ each share of the
              // day's total; the whole cell's opacity ∝ total volume.
              const badH = Math.round(cellH * (c / total));
              const alpha = 0.25 + 0.75 * (total / max);
              return (
                <g key={i}>
                  {badH > 0 && (
                    <rect
                      x={i * cellW}
                      y={cellsY}
                      width={wRect}
                      height={badH}
                      rx={1.5}
                      fill={hue}
                      fillOpacity={alpha}
                    />
                  )}
                  {cellH - badH > 0 && (
                    <rect
                      x={i * cellW}
                      y={cellsY + badH}
                      width={wRect}
                      height={cellH - badH}
                      rx={1.5}
                      fill={goodHue}
                      fillOpacity={alpha}
                    />
                  )}
                  {isHover && (
                    <rect
                      x={i * cellW}
                      y={cellsY}
                      width={wRect}
                      height={cellH}
                      rx={1.5}
                      fill="none"
                      stroke={c > 0 ? hue : goodHue}
                      strokeWidth={1.5}
                    />
                  )}
                </g>
              );
            })}
            {/* PR-opened overlay line (top band) — real PR inflow, to read against silent runs. */}
            {hasOpened && (
              <polyline
                points={openedPoints}
                fill="none"
                stroke={OPENED_HUE}
                strokeWidth={1.25}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.9}
              />
            )}
            {/* Silent-run underline — the anomalous gaps. */}
            {silentRuns.map((run) => (
              <rect
                key={`gap-${run.startDay}`}
                x={run.startDay * cellW}
                y={cellsY + cellH + 1}
                width={Math.max(run.days * cellW - 1, 1)}
                height={2.5}
                rx={1}
                fill={ANOMALY_RING}
              />
            ))}
            {/* x ticks: first + last date */}
            <text x={0} y={H - 2} className="fill-gray-400 text-[8px]">
              {dateAt(0)}
            </text>
            <text x={w} y={H - 2} textAnchor="end" className="fill-gray-400 text-[8px]">
              {dateAt(n - 1)}
            </text>
            <rect
              x={0}
              y={0}
              width={w}
              height={H}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hover != null && w > 0 && (
          <FloatingTip x={hover * cellW + cellW / 2} y={PAD_T} width={w}>
            {dateAt(hover)} · {daily[hover] ?? 0} {noun}
            {daily[hover] === 1 ? '' : 's'}
            {hasGood
              ? ` · ${dailyGood[hover] ?? 0} ${goodNoun}${dailyGood[hover] === 1 ? '' : 's'}`
              : ''}
            {hasOpened
              ? ` · ${opened[hover] ?? 0} PR${opened[hover] === 1 ? '' : 's'} ${openedVerb}`
              : ''}
          </FloatingTip>
        )}
      </div>
    </div>
  );
}
