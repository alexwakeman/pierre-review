import { useMemo } from 'react';
import type {
  AutomatedReviewerKind,
  BotInflationWeekPoint,
  BotVendorInflation,
} from '@pierre-review/shared';
import { ArrowIcon } from '../Icons.js';
import { LineChart } from '../charts/LineChart.js';
import { ChartCard, ChartEmpty, PALETTE, type Series } from '../charts/common.js';

// ── Severity inflation over time — the ENLARGED twin of the ROI table's Inflation sparkline ────
//
// The Inflation cell carries the numbers (two counts, click-through to the flagging drill-down)
// and a 52×14px sparkline beside them that is explicitly decorative: no axis, no key, no hover,
// `aria-hidden`. This card is that sparkline at a size where it can be read — same data, same two
// directions, same two hues, plus the three things the sparkline had no room for: a KEY saying
// which hue is which direction, an AXIS, and a hover that names the week and both counts.
//
// ⚠ IT PLOTS COUNTS, NEVER A RATE. `BotInflationWeekPoint` carries `overCall`/`underCall` and
// nothing else — there is no weekly `badged`/`agree` anywhere on the wire (the server buckets
// only DISAGREEMENTS: `db/ml-labels.ts`'s `dir !== 'agree'` increment), so a weekly share is not
// computable here. Anything on this card that reads as a share would be an invented denominator.
//
// ⚠ IT LIVES IN `BotRoiPanel`'s CHART ROW, NOT IN `WorkspaceBotCharts`. That is a data fact, not
// a layout preference: the weekly history rides `/api/bot-analytics`'s vendor rows, which this
// panel already has in hand, while the "Workspace charts" section fetches
// `/api/pro/bot-behaviour`, whose weekly points carry severity and category only. Hosting it there
// would mean a wider server fold, a `packages/shared` wire change, a plugin passthrough and a
// submodule gitlink move — for a chart that is already thirty lines below the sparkline it
// enlarges, on the surface that owns the counts, the colours and the drill-down.
//
// ⚠ ENTITLEMENT IS INHERITED, NOT RE-STATED. The whole inflation index is PAID (`botDepth`) and
// `weekly` additionally carries its own absent/present flag because it is an extra scan WIDTH
// (`inflationHistory` in `getBotAnalytics`). An unentitled account receives `vendors: []` from the
// route (`api/routes/bot-triage.ts`'s narrowed shape), so there are no rows to fold and this card
// renders NOTHING — it never has an empty-chart state to design for a locked reader.
//
// ⚠ THE MARKS ARE NOT CLICKABLE, ON PURPOSE. The Inflation cell's counts open the flagging
// drill-down, and the identity that makes that safe is "the number clicked IS the list's
// `filteredTotal`". `/api/bot-analytics/flagging`'s `refine` has exactly three members (`cell`,
// `disagree`, `authorUserIds`) — there is NO week narrowing — so a click on a weekly point could
// only open the whole 84-day list under a caption naming one week, i.e. a total that contradicts
// the mark that opened it. Hover is the whole interaction; the counts stay the click target.

/** Fixed span of the server's weekly buckets (`SPAN_WEEKS` in `db/ml-labels.ts`). */
const SPAN_WEEKS = 12;

/** The two directions, in the two hues the Inflation cell already spends on them. Amber = the bot
 *  graded a finding worse than our model did (inflation); violet = our model graded it worse than
 *  the bot's own badge. This pair is on the FRONTEND.md palette keep-list precisely because the
 *  cell, this chart and the drill-down matrix must key on the same hues — it is NOT a stray
 *  violet awaiting the `--ai-*` migration. */
const OVER_COLOR = PALETTE.amber;
const UNDER_COLOR = PALETTE.violet;

/** The minimum a row must carry to be folded. `BotVendorAnalytics` satisfies it structurally; the
 *  fold takes this narrower shape so its test can state a fixture in four fields. */
export interface InflationHistoryRow {
  key: string;
  label: string;
  mlInflation?: BotVendorInflation;
}

/** One bot's enlarged sparkline: the two direction series over the shared weekly axis. */
export interface InflationHistoryPanel {
  key: string;
  label: string;
  /** Aligned 1:1 with `labels`; null where this bot has no bucket for that week (a GAP, not a 0). */
  over: (number | null)[];
  under: (number | null)[];
  /** Σ over the bot's own buckets — the CHART's span (84d), never the table's window. */
  overTotal: number;
  underTotal: number;
}

export interface InflationHistory {
  /** ISO week-starts, oldest→newest, at most 12. */
  labels: string[];
  /** Charted bots, busiest disagreement history first. */
  panels: InflationHistoryPanel[];
  /**
   * Bots that scored findings in the window but declared NOT ONE badge — omitted from the chart
   * and NAMED, never drawn as a flat zero line.
   *
   * ⚠ A ZERO LINE WOULD BE A LIE, and it is the same rule the cell's dash enforces. A bot that
   * badges nothing has no over-calls for the arithmetic reason that it makes no calls; a flat zero
   * reads "never inflates", which is the opposite of "we cannot tell". No badge is silence, not
   * agreement. (`lib/botMlSeries.ts`'s `inflationSummary.unbadged` is the same exclusion one grain
   * over, and carries the long-form argument.)
   */
  unbadged: string[];
  /**
   * Bots that DID badge findings and disagreed with us in none of the 12 weeks — the server drops
   * the whole `weekly` key when every bucket is zero, so there is no array to draw. Named rather
   * than charted, but named as a MEASUREMENT: within a badged bot a zero is real ("it made calls
   * and we agreed with every one"), which is exactly what separates this list from `unbadged`.
   */
  quiet: string[];
}

const isoWeek = (p: BotInflationWeekPoint): string => new Date(p.weekStartMs).toISOString();

/**
 * Fold the ROI rows into one weekly axis plus one panel per chartable bot.
 *
 * The axis is the UNION of every bot's bucket starts (the `VendorTrendChart` idiom), even though
 * the server anchors every bot's buckets on the same `trendFrom`: a union costs nothing and cannot
 * silently mis-align if that ever stops being true, whereas taking one bot's array as the axis can.
 */
export function inflationHistory(rows: InflationHistoryRow[]): InflationHistory {
  const weekSet = new Set<string>();
  for (const r of rows) for (const p of r.mlInflation?.weekly ?? []) weekSet.add(isoWeek(p));
  const labels = Array.from(weekSet).sort().slice(-SPAN_WEEKS);

  const panels: InflationHistoryPanel[] = [];
  const unbadged: string[] = [];
  const quiet: string[] = [];
  for (const r of rows) {
    const inf = r.mlInflation;
    // No `mlInflation` at all means the bot had no in-window labels — it is absent from this
    // block's story rather than silent within it, so it is not named either (the same line
    // `inflationSummary` draws with its `findings > 0` guard).
    if (inf == null) continue;
    if (inf.badged === 0) {
      unbadged.push(r.label);
      continue;
    }
    // `weekly` absent on a badged bot means twelve zero buckets (the server drops an all-zero
    // series). It is ALSO the shape an unentitled fold would produce — unreachable here, because
    // an unentitled account receives no vendor rows at all, so the two cannot be confused on this
    // surface.
    const weekly = inf.weekly;
    if (weekly == null || weekly.length === 0) {
      quiet.push(r.label);
      continue;
    }
    const byWeek = new Map(weekly.map((p) => [isoWeek(p), p]));
    panels.push({
      key: r.key,
      label: r.label,
      over: labels.map((w) => byWeek.get(w)?.overCall ?? null),
      under: labels.map((w) => byWeek.get(w)?.underCall ?? null),
      overTotal: weekly.reduce((n, p) => n + p.overCall, 0),
      underTotal: weekly.reduce((n, p) => n + p.underCall, 0),
    });
  }
  // Busiest disagreement history first (the reader's question is "who argues with us most"), ties
  // by label so panel order is stable across a refetch.
  panels.sort(
    (a, b) =>
      b.overTotal + b.underTotal - (a.overTotal + a.underTotal) || a.label.localeCompare(b.label),
  );
  return { labels, panels, unbadged, quiet };
}

// The key. Hand-rolled rather than the toolkit `Legend` because it has to match the CELL, not the
// chart: the Inflation counts are an `ArrowIcon` up/down in these two hues, and a reader moving
// between the table and this card must see the same mark mean the same thing. A square swatch here
// would quietly make them two encodings of one fact.
function DirectionKey(): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
      <span className="flex items-center gap-1" style={{ color: OVER_COLOR }}>
        <ArrowIcon dir="up" size={10} />
        Bot graded it worse (inflation)
      </span>
      <span className="flex items-center gap-1" style={{ color: UNDER_COLOR }}>
        <ArrowIcon dir="down" size={10} />
        We graded it worse
      </span>
    </div>
  );
}

function InflationPanelChart({
  panel,
  labels,
  color,
}: {
  panel: InflationHistoryPanel;
  labels: string[];
  /** The bot's own identity hue, used on the NAME DOT only — never on a line. Lines carry
   *  direction, and one channel cannot hold two dimensions. */
  color: string;
}): JSX.Element {
  const series: Series[] = [
    { key: 'over', label: 'Bot worse', color: OVER_COLOR, values: panel.over },
    { key: 'under', label: 'We worse', color: UNDER_COLOR, values: panel.under },
  ];
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-gray-700 dark:text-gray-200">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: color }}
          />
          <span className="truncate">{panel.label}</span>
        </span>
        {/* Both 12-week totals, so the panel's own span is stated as a number and not only as a
            shape. These are 84-day figures and deliberately do NOT match the table's Inflation
            counts, which are the selected window — the caption above says so. */}
        <span className="shrink-0 tabular-nums text-[10px] text-gray-400">
          <span style={{ color: OVER_COLOR }}>{panel.overTotal}</span>
          {' · '}
          <span style={{ color: UNDER_COLOR }}>{panel.underTotal}</span>
        </span>
      </div>
      {/* `hideLegend` — the key is shared above, once, rather than repeated under every panel.
          `centerTip` keeps the hover box off the neighbouring panel at the far edges. */}
      <LineChart
        labels={labels}
        series={series}
        height={110}
        curved
        hideLegend
        centerTip
      />
    </div>
  );
}

/**
 * The card. One small panel per chartable bot — the sparkline's own shape (two direction lines per
 * BOT), enlarged, rather than one chart holding every bot's two lines: direction already owns the
 * colour channel, so 2N lines in two hues would leave vendor identity with nothing to ride on.
 *
 * ⚠ EACH PANEL KEEPS ITS OWN Y-SCALE, exactly as each row's sparkline did (`max` was per-row
 * there). That is deliberate — a shared scale would flatten a quiet bot into the axis beside a
 * loud one — but the enlargement makes it READABLE rather than hidden, so the caption states it.
 * Heights compare within a bot, never across bots.
 */
export function InflationHistoryChart({
  vendors,
  botColor,
  windowLabel,
}: {
  vendors: (InflationHistoryRow & { login?: string | null; kind: AutomatedReviewerKind })[];
  botColor: (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;
  /** The label of the window the TABLE's counts were measured over ("7d", "30d", …) — quoted in
   *  the caption so the two grains on this panel are named apart rather than left to be inferred. */
  windowLabel: string;
}): JSX.Element | null {
  const { labels, panels, unbadged, quiet } = useMemo(() => inflationHistory(vendors), [vendors]);
  const colorOf = useMemo(() => {
    const byKey = new Map(vendors.map((v) => [v.key, botColor({ login: v.login, kind: v.kind })]));
    return (key: string): string => byKey.get(key) ?? PALETTE.slate;
  }, [vendors, botColor]);

  // Nothing measured, nothing withheld — no card at all rather than empty chrome.
  if (panels.length === 0 && unbadged.length === 0 && quiet.length === 0) return null;

  return (
    <ChartCard title="Severity inflation" note="weekly counts · last 12 weeks" className="lg:col-span-3">
      <DirectionKey />
      {/* ⚠ THE TWO GRAINS ON THIS PANEL, SAID OUT LOUD. The weekly series is anchored at
          `min(window start, now − 84d)`, so it is a FIXED twelve weeks whatever the picker says,
          while the Inflation counts in the table above follow the selected window. One surface
          quoting two spans without naming them is the defect this codebase has shipped three
          times; the sparkline could hide it only because it had no axis. */}
      <div className="mt-1 text-[10px] leading-snug text-gray-400">
        A fixed 12 weeks (84 days), whatever window is selected above — the table's Inflation counts
        are the {windowLabel} window, so the two are different spans and are never subtracted. Each
        bot has its own y-scale, as its sparkline did: read a line's height against itself, never
        against another bot's.
      </div>
      {panels.length === 0 ? (
        <div className="mt-2">
          <ChartEmpty label="No badge disagreements in the last 12 weeks" />
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
          {panels.map((p) => (
            <InflationPanelChart key={p.key} panel={p} labels={labels} color={colorOf(p.key)} />
          ))}
        </div>
      )}
      {(unbadged.length > 0 || quiet.length > 0) && (
        <div className="mt-2 space-y-0.5 text-[10px] leading-snug text-gray-400">
          {unbadged.length > 0 && (
            <div>
              Not charted: {unbadged.join(', ')} — {unbadged.length === 1 ? 'it badges' : 'they badge'}{' '}
              nothing, and no badge is silence, not agreement. A flat zero would read “never
              inflates”, which is the opposite of what we know.
            </div>
          )}
          {quiet.length > 0 && (
            <div>
              No disagreement in these 12 weeks: {quiet.join(', ')} —{' '}
              {quiet.length === 1 ? 'it badged' : 'they badged'} findings and our model agreed with
              every one.
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}
