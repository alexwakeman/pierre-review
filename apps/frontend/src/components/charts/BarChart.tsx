import { useState } from 'react';
import {
  useChartWidth,
  fmtDate,
  fmtNum,
  niceMax,
  Legend,
  FloatingTip,
  type Series,
} from './common.js';

// Bar chart over categorical x. Labels that look like ISO dates render as weekly
// ticks (first/last only when crowded); short bin labels render under each bar.
// `mode` is 'grouped' (side-by-side) or 'stacked'. Series values are plain numbers.
export function BarChart({
  labels,
  series,
  mode = 'grouped',
  formatY = fmtNum,
  formatValue = formatY,
  height = 132,
  rotateLabels = false,
  maxBarWidth,
  onSelectBar,
  barAriaLabel,
}: {
  labels: string[];
  series: Series[];
  mode?: 'grouped' | 'stacked';
  formatY?: (n: number) => string;
  formatValue?: (n: number) => string;
  height?: number;
  // Render the x-axis labels diagonally (−35°) instead of horizontal — for crowded
  // categorical labels (e.g. CI stage names) that would overlap. The chart's overall
  // footprint (`height`) is UNCHANGED: a larger bottom band is reserved for the labels,
  // so the plot area shrinks slightly rather than the card growing.
  rotateLabels?: boolean;
  // Cap on a single bar's drawn width, in px. Absent (every pre-existing consumer): a bar is a
  // fixed 70% of its band, which is right for the bin distributions this chart was built for —
  // they always have enough bins to keep a band narrow. It is wrong for a CATEGORICAL chart whose
  // category count is the reader's data: a workspace holding one repository renders that repository
  // as a ~390px slab, which reads as a filled rectangle rather than a bar. Capping the width and
  // CENTRING the bar in its band keeps a one-category chart legible as a chart. The band itself is
  // unchanged, so the hover highlight and any hit target stay full-width.
  maxBarWidth?: number;
  // ── OPTIONAL interactivity ────────────────────────────────────────────────────────────────
  // Absent (the default, and every pre-existing consumer): this chart is a picture. No pointer
  // cursor, no hit targets, nothing in the tab order, no accessible name — adding any of those
  // to a decorative chart puts N unlabelled stops in every keyboard user's path for nothing.
  //
  // Present: each x BAND becomes a real <button>. The band, not the bar: the hover highlight
  // already IS the band, a stacked segment or a grouped sub-bar is routinely 2px wide (and a
  // zero-valued bar has no area at all), and a target you cannot hit is not a target. So the
  // callback answers "which band", and `seriesKey` is the series' key ONLY when the chart draws
  // exactly one — a multi-series band has no single answer, and inventing one (the first series,
  // the tallest) is how a click comes to mean something the reader did not point at.
  onSelectBar?: (seriesKey: string | null, index: number) => void;
  // The accessible name for band `i`'s button. Default: the x label plus every series' value —
  // fine for a bin distribution, but a caller that knows what a click DOES ("open the 243
  // comments behind this") should say so; it is the only text a screen reader gets.
  barAriaLabel?: (index: number) => string;
}): JSX.Element {
  const [ref, w] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);

  const PAD_L = 30;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = rotateLabels ? 40 : 16;
  const n = labels.length;
  const innerW = Math.max(w - PAD_L - PAD_R, 1);
  const innerH = height - PAD_T - PAD_B;
  const isDate = /^\d{4}-\d{2}-\d{2}T/.test(labels[0] ?? '');

  const colTotal = (i: number): number => series.reduce((s, ser) => s + (ser.values[i] ?? 0), 0);
  const maxV = niceMax(
    mode === 'stacked'
      ? Math.max(1, ...labels.map((_, i) => colTotal(i)))
      : Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))),
  );
  const bandW = innerW / Math.max(n, 1);
  const barAreaW = Math.min(bandW * 0.7, maxBarWidth ?? Number.POSITIVE_INFINITY);
  const barAreaX = (i: number): number => PAD_L + i * bandW + (bandW - barAreaW) / 2;
  const y = (v: number): number => PAD_T + innerH * (1 - v / maxV);
  const baseY = PAD_T + innerH;

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const i = Math.floor((e.nativeEvent.offsetX - PAD_L) / bandW);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const labelFor = (i: number): string => {
    const l = labels[i] ?? '';
    return isDate ? fmtDate(l) : l;
  };
  const showEveryLabel = !isDate || n <= 8;

  // Unambiguous only for a single-series chart — see `onSelectBar`.
  const seriesKeyOf = (): string | null => (series.length === 1 ? (series[0]?.key ?? null) : null);
  const ariaFor = (i: number): string =>
    barAriaLabel
      ? barAriaLabel(i)
      : `${labelFor(i)}: ${series.map((s) => `${s.label} ${formatValue(s.values[i] ?? 0)}`).join(', ')}`;

  return (
    <div>
      <div ref={ref} className="relative" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} className="block">
            {[0, maxV].map((v) => (
              <g key={v}>
                <line
                  x1={PAD_L}
                  y1={y(v)}
                  x2={w - PAD_R}
                  y2={y(v)}
                  className="decorative-mark text-gray-200 dark:text-gray-700"
                  stroke="currentColor"
                  strokeWidth={1}
                />
                <text x={PAD_L - 4} y={y(v) + 3} textAnchor="end" className="fill-gray-400 text-[8px]">
                  {formatY(v)}
                </text>
              </g>
            ))}
            {hover != null && (
              <rect
                x={PAD_L + hover * bandW}
                y={PAD_T}
                width={bandW}
                height={innerH}
                className="text-gray-400/10 dark:text-gray-300/10"
                fill="currentColor"
              />
            )}
            {labels.map((_, i) => {
              if (mode === 'stacked') {
                let acc = 0;
                return series.map((s) => {
                  const v = s.values[i] ?? 0;
                  if (v <= 0) return null;
                  const yTop = y(acc + v);
                  const h = y(acc) - yTop;
                  acc += v;
                  return (
                    <rect
                      key={`${i}-${s.key}`}
                      x={barAreaX(i)}
                      y={yTop}
                      width={barAreaW}
                      height={Math.max(h, 0)}
                      fill={s.colors?.[i] ?? s.color}
                    />
                  );
                });
              }
              const each = barAreaW / Math.max(series.length, 1);
              return series.map((s, si) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                return (
                  <rect
                    key={`${i}-${s.key}`}
                    x={barAreaX(i) + si * each}
                    y={y(v)}
                    width={Math.max(each - 0.5, 0.5)}
                    height={baseY - y(v)}
                    fill={s.colors?.[i] ?? s.color}
                  />
                );
              });
            })}
            {labels.map((_, i) => {
              if (!(showEveryLabel || i === 0 || i === n - 1)) return null;
              const cx = PAD_L + i * bandW + bandW / 2;
              if (rotateLabels) {
                // Anchor the label's END just below the axis at the bar centre, then
                // rotate −35° so it reads diagonally up-left without overlapping neighbours.
                const ly = baseY + 9;
                return (
                  <text
                    key={`lbl-${i}`}
                    x={cx}
                    y={ly}
                    textAnchor="end"
                    transform={`rotate(-35 ${cx} ${ly})`}
                    className="fill-gray-400 text-[8px]"
                  >
                    {labelFor(i)}
                  </text>
                );
              }
              return (
                <text
                  key={`lbl-${i}`}
                  x={cx}
                  y={height - 4}
                  textAnchor="middle"
                  className="fill-gray-400 text-[8px]"
                >
                  {labelFor(i)}
                </text>
              );
            })}
            <rect
              x={0}
              y={0}
              width={w}
              height={height}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
        )}
        {/* The hit targets, only when this chart was given a click handler. Real <button>s in the
            DOM rather than SVG rects with role="button": they are keyboard-reachable, Enter and
            Space activate them for free (a div/rect needs both spelled out, and Space then also
            scrolls the page), and they carry a focus ring the browser draws. They sit ABOVE the
            svg's mousemove overlay, which is why each one re-states the hover itself — and the
            wrapper is pointer-events-none so only the bands intercept, never the whole card.
            BEFORE the FloatingTip in source order, so the tip — rendered after, z-20 and
            pointer-events-none — still paints over them and is never covered by a target. */}
        {onSelectBar && w > 0 && (
          <div className="pointer-events-none absolute inset-0">
            {labels.map((_, i) => (
              <button
                key={`hit-${i}`}
                type="button"
                className="pointer-events-auto absolute cursor-pointer rounded-sm bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                style={{ left: PAD_L + i * bandW, top: PAD_T, width: bandW, height: innerH }}
                onMouseEnter={() => setHover(i)}
                // ⚠ EACH BAND MUST CLEAR ITS OWN HOVER. The svg's full-size transparent overlay
                // owns `onMouseLeave` for the mouse-only path, but these buttons are a SEPARATE
                // DOM subtree stacked on top of it: while the pointer is over a band the overlay
                // is not the event target, so React never fires the overlay's mouseleave when the
                // pointer jumps straight from a band to somewhere outside the card. Without this
                // the highlight band and the FloatingTip stayed painted after the pointer left.
                // Band → band is safe: React dispatches the leave before the next enter.
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => onSelectBar(seriesKeyOf(), i)}
                aria-label={ariaFor(i)}
              />
            ))}
          </div>
        )}
        {hover != null && w > 0 && (
          <FloatingTip x={PAD_L + hover * bandW + bandW / 2} y={PAD_T} width={w}>
            <div className="font-medium">{labelFor(hover)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-[1px]"
                  style={{ background: s.colors?.[hover] ?? s.color }}
                />
                {s.label}: {formatValue(s.values[hover] ?? 0)}
              </div>
            ))}
            {mode === 'stacked' && series.length > 1 && (
              <div className="mt-0.5 border-t border-gray-200 pt-0.5 dark:border-gray-700">
                total: {formatValue(colTotal(hover))}
              </div>
            )}
          </FloatingTip>
        )}
      </div>
      {series.length > 1 && <Legend series={series} />}
    </div>
  );
}
