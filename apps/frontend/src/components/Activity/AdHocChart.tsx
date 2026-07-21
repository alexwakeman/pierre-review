import type { SprintChatChartSpec } from '@pierre-review/shared';
import { BarChart } from '../charts/BarChart.js';
import { LineChart } from '../charts/LineChart.js';
import { ChartCard, SERIES_COLORS, fmtDuration, fmtNum, type Series } from '../charts/common.js';

// Renders an LLM-emitted ad-hoc chart spec (validated server-side) with the zero-dep toolkit.
// The spec is already shape-checked; here we adapt it: fill the required Series key + color, pick
// the axis formatter from `unit`, and choose the component — LineChart for a genuine time series
// (ISO-date labels, which is all Line/StackedArea can axis-format), BarChart for any categorical
// x (people / repos / states), which is what the toolkit renders verbatim.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function formatterFor(unit: SprintChatChartSpec['unit']): (n: number) => string {
  if (unit === 'percent') return (n) => `${Math.round(n * 10) / 10}%`;
  if (unit === 'hours') return fmtDuration;
  return fmtNum;
}

export function AdHocChart({ spec }: { spec: SprintChatChartSpec }): JSX.Element | null {
  if (spec.series.length === 0 || spec.labels.length === 0) return null;
  const series: Series[] = spec.series.map((s, i) => ({
    key: `s${i}`,
    label: s.label || `Series ${i + 1}`,
    color: SERIES_COLORS[i % SERIES_COLORS.length]!,
    values: s.values,
  }));
  const formatY = formatterFor(spec.unit);
  // Line/area only make sense (and only axis-format) with REAL ISO-date labels; otherwise bars.
  // Require both the ISO shape AND a valid parse — a date-shaped-but-invalid label (e.g.
  // '2026-13-40') would otherwise render literal 'Invalid Date' on the LineChart axis.
  const isDateAxis = spec.labels.every(
    (l) => ISO_DATE_RE.test(l) && !Number.isNaN(Date.parse(l)),
  );
  const asLine = (spec.type === 'line' || spec.type === 'area') && isDateAxis;
  return (
    <ChartCard title={spec.title || 'Chart'}>
      {asLine ? (
        <LineChart
          labels={spec.labels}
          series={series}
          area={spec.type === 'area'}
          curved
          formatY={formatY}
        />
      ) : (
        <BarChart
          labels={spec.labels}
          series={series}
          formatY={formatY}
          rotateLabels={spec.labels.length > 6}
        />
      )}
    </ChartCard>
  );
}
