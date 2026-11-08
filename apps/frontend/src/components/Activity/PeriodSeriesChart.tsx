import type { ReactNode } from 'react';
import { ChartPopover } from '../charts/ChartPopover.js';
import { useChartWidth } from '../charts/common.js';

// THE PERIOD CHART (Reports → Period reports; docs/FRONTEND.md § Period reports). One shaded BAND
// per period, so each period reads as its own section; one point per period per line at the band's
// centre; a gap where a period has no figure (never a 0). A projection, when there is one, is a
// dashed segment into a hatched "next" band with its range as a bar. Every band is a ChartPopover
// trigger — hover or focus shows that period's figures, a click pins it AND selects the period
// (Effort vs automation below follows the selection).

export interface PeriodChartLine {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
  projection: { point: number; low: number; high: number } | null;
}

export interface PeriodChartProps {
  /** One label per period, oldest first. */
  bands: { key: string; label: string; short: string }[];
  /** The projected period's label, or null for no projection band. */
  next: { label: string; short: string } | null;
  lines: PeriodChartLine[];
  domain: { min: number; max: number };
  ticks: number[];
  formatTick: (v: number) => string;
  /** Draw a heavier rule at 0 (the CHANGE reading). */
  zeroRule?: boolean;
  selected: number | null;
  onSelect: (i: number) => void;
  /** A band's popover: its figures. */
  popover: (i: number) => ReactNode;
  /** A band's accessible name: the figures in words. */
  bandLabel: (i: number) => string;
  height?: number;
  testId?: string;
}

const PAD_L = 58;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 34;

export function PeriodSeriesChart(props: PeriodChartProps): JSX.Element {
  const { bands, next, lines, domain, ticks, formatTick, zeroRule = false, selected, onSelect, popover, bandLabel, height = 232, testId } = props;
  const [ref, w] = useChartWidth();
  const slots = bands.length + (next != null ? 1 : 0);
  const innerW = Math.max(0, w - PAD_L - PAD_R);
  const bandW = slots > 0 ? innerW / slots : 0;
  const innerH = height - PAD_T - PAD_B;
  const span = domain.max - domain.min || 1;
  const y = (v: number): number => PAD_T + innerH - ((Math.min(domain.max, Math.max(domain.min, v)) - domain.min) / span) * innerH;
  const cx = (i: number): number => PAD_L + bandW * (i + 0.5);
  // The full date range under each band when every one fits (≈ 6.5px a character at 11px), else the
  // start date alone.
  const longest = Math.max(0, ...bands.map((b) => b.label.length), next?.label.length ?? 0);
  const useShort = longest * 6.5 > bandW - 8;
  const hatchId = `${testId ?? 'period-chart'}-hatch`;

  return (
    <div ref={ref} className="relative" style={{ height }} data-testid={testId}>
      {w > 0 && (
        <svg width={w} height={height} aria-hidden className="block overflow-visible">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="stroke-current text-ui-line" strokeWidth="2" />
            </pattern>
          </defs>
          {/* The bands: alternate shading, so each period is its own section. */}
          {bands.map((b, i) => (
            <rect
              key={b.key}
              x={PAD_L + bandW * i}
              y={PAD_T}
              width={bandW}
              height={innerH}
              className={`fill-current ${i === selected ? 'text-ui-sel' : i % 2 === 0 ? 'text-ui-surface' : 'text-ui-raise'}`}
            />
          ))}
          {next != null && <rect x={PAD_L + bandW * bands.length} y={PAD_T} width={bandW} height={innerH} fill={`url(#${hatchId})`} opacity={0.5} />}
          {/* Gridlines and their labels. */}
          {ticks.map((t) => (
            <g key={t} className="text-ui-faint">
              <line x1={PAD_L} x2={w - PAD_R} y1={y(t)} y2={y(t)} className="stroke-current" strokeOpacity={zeroRule && t === 0 ? 0.9 : 0.35} strokeWidth={zeroRule && t === 0 ? 1.25 : 1} />
              <text x={PAD_L - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-current text-meta tabular-nums">
                {formatTick(t)}
              </text>
            </g>
          ))}
          {/* The x labels: the period under its band. */}
          {[...bands, ...(next != null ? [{ key: 'next', label: next.label, short: next.short }] : [])].map((b, i) => (
            <text key={b.key} x={cx(i)} y={height - 18} textAnchor="middle" className={`fill-current text-meta ${i === selected ? 'text-ui-ink' : 'text-ui-mute'}`}>
              {useShort ? b.short : b.label}
            </text>
          ))}
          {next != null && (
            <text x={cx(bands.length)} y={height - 4} textAnchor="middle" className="fill-current text-meta text-ui-mute">
              projected
            </text>
          )}
          {/* The lines: a gap where there is no figure. */}
          {lines.map((l) => {
            const segs: string[] = [];
            let cur = '';
            l.values.forEach((v, i) => {
              if (v == null) {
                if (cur !== '') segs.push(cur);
                cur = '';
                return;
              }
              cur += `${cur === '' ? 'M' : 'L'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
            });
            if (cur !== '') segs.push(cur);
            const lastIdx = l.values.reduce<number>((acc, v, i) => (v != null ? i : acc), -1);
            const p = l.projection;
            return (
              <g key={l.key}>
                {segs.map((d, i) => (
                  <path key={i} d={d} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {l.values.map((v, i) => (v == null ? null : <circle key={i} cx={cx(i)} cy={y(v)} r={3} fill={l.color} />))}
                {p != null && next != null && lastIdx >= 0 && (
                  <>
                    <line x1={cx(bands.length)} x2={cx(bands.length)} y1={y(p.low)} y2={y(p.high)} stroke={l.color} strokeOpacity={0.45} strokeWidth={6} strokeLinecap="round" />
                    <path d={`M${cx(lastIdx)},${y(l.values[lastIdx]!)}L${cx(bands.length)},${y(p.point)}`} fill="none" stroke={l.color} strokeWidth={2} strokeDasharray="4 4" />
                    <circle cx={cx(bands.length)} cy={y(p.point)} r={3.5} fill="none" stroke={l.color} strokeWidth={1.5} className="text-ui-bg" />
                  </>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {/* The hit areas: one popover trigger per band (and the projection's). */}
      {w > 0 &&
        Array.from({ length: slots }, (_, i) => (
          <div
            key={i}
            className="absolute"
            style={{ left: PAD_L + bandW * i, top: PAD_T, width: bandW, height: innerH }}
            onClickCapture={() => {
              if (i < bands.length) onSelect(i);
            }}
          >
            <ChartPopover label={bandLabel(i)} content={popover(i)} testId={`${testId ?? 'period-chart'}-band`}>
              <span className="block" style={{ height: innerH }} />
            </ChartPopover>
          </div>
        ))}
    </div>
  );
}
