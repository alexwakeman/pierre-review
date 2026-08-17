import { useMemo, type ReactNode } from 'react';
import type {
  AutomatedReviewerKind,
  BotAnalyticsMlTotals,
  BotFlaggingSelector,
  BotTuningSuggestion,
  BotVendorAnalytics,
  BotVendorTrendPoint,
  BotVerdict,
  BotWindowKind,
  MlSeverity,
} from '@pierre-review/shared';
import { ML_SEVERITIES } from '@pierre-review/shared';

// ASCENDING (nit → critical), deliberately NOT the shared `ML_SEVERITIES` (worst-first, which is
// the right order for a badge legend): the four "not addressed by severity" columns read
// left-to-right as a scale, and flipping them would silently transpose every cell's meaning.
const SEVERITY_COLUMNS: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];
import {
  useBotAnalytics,
  useResolvableBotThreads,
} from '../../hooks/useBotTriage.js';
import { useMlSeverityEnabled } from '../../hooks/useMlLabels.js';
import { useProCapabilities } from '../../hooks/useTriage.js';
import { useProSettings, useHasProSettings } from '../../hooks/useProSettings.js';
import { useFilters } from '../../store/filters.js';
import {
  automatedReviewerMeta,
  ML_CATEGORY_LABEL,
  ML_SEVERITY_META,
  relativeTime,
} from '../../lib/ui.js';
import { formatCostInput, resolveVendorCost } from '../../lib/botCost.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { SeverityBar } from '../MlSeverityBadge.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { ChartCard, ChartEmpty, PALETTE, type Series } from '../charts/common.js';

// Bot ROI / utilisation panel — CORE/FREE (rendered in the Bots rail console). The analytics
// route is CORE + deterministic (no AI): a per-bot signal-to-noise table + a 12-week
// thread-volume trend + keep/tune/noisy verdicts, plus deterministic, ADVISORY tuning suggestions
// (which bot × path is noisy — no action attached; tune the bot on its own platform).
//
// SCOPE IS ONE WORKSPACE (+ an optional repo narrowing on the DATA). A bot is a per-WORKSPACE
// object, so a vendor running in six of the workspace's repos is ONE row here, merged by GitHub
// handle.
//
// COST IS SERVER-RESOLVED on each analytics row (`costMonthlyUsd` / `costPerActedOnUsd`), read
// from the CORE `workspace_reviewers.monthly_cents` — so it is free/OSS too. The old client-side
// overlay from pro_settings `bots.cost` is gone: a per-LOGIN map could not be edited or cleared
// from the surface that displayed it. All that remains of it is `legacyOnlyUsd` — a POINTER at a
// price plugin migration 0019 could not move onto a row, shown in the cell's tooltip and never
// applied (see `resolveVendorCost`: filling a null from that blob silently resurrected prices the
// user had deliberately CLEARED, with no write path left to remove them). Its fetch stays gated on
// plugin presence so the pure OSS path never calls /api/pro/settings.
//
// ⚠ PRICE IS PER WORKSPACE, AND MUST NEVER BE SUMMED ACROSS WORKSPACES. Inside this response there
// is exactly ONE row per actor, so a total over the visible rows is a plain, correct sum (that is
// what `monthlyCostTotal` in lib/botReviewers.ts computes, and its dedupe-by-userId is now a
// trivially-satisfied standing guard). ACROSS workspaces it is meaningless: six workspaces each
// listing a $120 CodeRabbit is either six subscriptions or one seen six ways, and the app must not
// assert which — so no screen here adds them up.

const WINDOWS: { key: BotWindowKind; label: string }[] = [
  { key: 'rolling_7', label: '7d' },
  { key: 'rolling_14', label: '14d' },
  { key: 'rolling_30', label: '30d' },
  { key: 'sprint', label: 'Sprint' },
];

const VERDICT_META: Record<BotVerdict, { label: string; className: string; title: string }> = {
  keep: {
    label: 'Keep',
    className:
      'bg-green-500/10 text-green-700 dark:text-green-300 border border-green-500/30',
    title: 'Healthy signal-to-noise — worth keeping on.',
  },
  tune: {
    label: 'Tune',
    className:
      'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30',
    // Two routes reach this chip and the copy has to cover both: a lot of threads going
    // unaddressed, OR a bot whose scored findings are overwhelmingly nits (the same gates as the
    // nit tuning suggestion, so the reason is spelled out in the list below the table).
    title:
      'Either a lot of comments go unaddressed, or nearly everything it flags scores as a nit — consider tuning the noisy paths/severities on the bot.',
  },
  noisy: {
    label: 'Noisy',
    className: 'bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30',
    title:
      'High volume, low acted-on, and many threads left unaddressed past your normal response window — probably not paying for itself.',
  },
};

// The per-bot colour resolver for the ACTIVE WORKSPACE (brand-aware hybrid — see useBotColors):
// the same colour for a given bot across the ROI charts, table, feed pills, and the per-repo Bots
// tab. Identity (and therefore colour) is a per-workspace fact now, so the resolver is too.
type BotColor = (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

// Chart y-axis / value formatter (BarChart never passes null).
const pctAxis = (n: number): string => `${Math.round(n)}%`;

// Per-week metric extractor for the thread-volume trend. Module-level so its identity is
// stable (keeps VendorTrendChart's useMemo from recomputing every render).
const threadsVal = (p: BotVendorTrendPoint): number | null => p.threads;

// Keep/tune/noisy → the traffic-light hue that tints each effectiveness bar.
const VERDICT_COLOR: Record<BotVerdict, string> = {
  keep: PALETTE.green,
  tune: PALETTE.amber,
  noisy: PALETTE.red,
};

function usd(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toFixed(2)}`;
}

// Compact human duration for response times: "45m" / "6h" / "1.8d". Null → em-dash.
function dur(ms: number | null): string {
  if (ms == null) return '—';
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h`;
  const days = hrs / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

// An analytics row plus its resolved cost. The server's answer is FINAL — this only attaches
// `legacyOnlyUsd`, an un-applied pointer at a price still stranded in the deprecated per-login
// blob, so the table can offer to migrate it. See `resolveVendorCost` for why filling a null from
// that blob was wrong (a deliberately CLEARED price is also null).
//
// ⚠ THE PRICE ON THESE ROWS BELONGS TO THIS WORKSPACE. One actor = one row here (a bot is a
// per-workspace object), so the column is safe to read and safe to total WITHIN this response.
// The same vendor's row in another workspace may legitimately hold a different number, or none,
// and nothing reconciles them — so never carry a figure from this table into a cross-workspace
// total.
type CostedVendor = BotVendorAnalytics & { legacyOnlyUsd: number | null };

function withResolvedCost(
  vendors: BotVendorAnalytics[],
  legacyCostByLogin: Map<string, number>,
): CostedVendor[] {
  return vendors.map((v) => ({ ...v, ...resolveVendorCost(v, legacyCostByLogin) }));
}

// One multi-series weekly line chart across vendors, over a unified weekly x-axis (the union
// of every vendor's trend weekStarts, oldest→newest, last 12). `value` pulls the metric from
// each weekly point; a vendor with no data that week reads as a gap (null), mirroring the
// toolkit's semantics. Drives thread volume, noise ratio, acted-on rate, and untouched backlog.
function VendorTrendChart({
  vendors,
  value,
  botColor,
  formatY,
  height = 140,
}: {
  vendors: BotVendorAnalytics[];
  value: (p: BotVendorTrendPoint) => number | null;
  botColor: BotColor;
  formatY?: (n: number) => string;
  height?: number;
}): JSX.Element {
  const { labels, series } = useMemo(() => {
    const weekSet = new Set<string>();
    for (const v of vendors) for (const p of v.trend) weekSet.add(p.weekStart);
    const labels = Array.from(weekSet).sort().slice(-12);
    const series: Series[] = vendors
      .filter((v) => v.trend.length > 0)
      .map((v) => {
        const byWeek = new Map(v.trend.map((p) => [p.weekStart, value(p)]));
        return {
          key: v.key,
          label: v.label,
          color: botColor({ login: v.login, kind: v.kind }),
          values: labels.map((w) => byWeek.get(w) ?? null),
        };
      });
    return { labels, series };
  }, [vendors, value, botColor]);

  if (labels.length < 2 || series.length === 0) {
    return <ChartEmpty label="Not enough weekly history yet" />;
  }
  return <LineChart labels={labels} series={series} height={height} curved formatY={formatY} />;
}

// A per-bot acted-on-vs-untouched snapshot over the selected window (stacked bar per bot):
// the deterministic effectiveness split — how much of each bot's volume drove action vs sat
// untouched. Labels rotate so bot names don't collide.
function ActedVsUntouchedChart({ vendors }: { vendors: BotVendorAnalytics[] }): JSX.Element {
  const labels = vendors.map((v) => v.label);
  const series: Series[] = [
    { key: 'acted', label: 'Acted on', color: PALETTE.green, values: vendors.map((v) => v.actedOn) },
    { key: 'untouched', label: 'Untouched', color: PALETTE.amber, values: vendors.map((v) => v.untouched) },
  ];
  if (labels.length === 0 || vendors.every((v) => v.actedOn + v.untouched === 0)) {
    return <ChartEmpty />;
  }
  return <BarChart labels={labels} series={series} mode="stacked" rotateLabels height={160} />;
}

// Volume-INDEPENDENT effectiveness: each bot's acted-on % over the window, the bar tinted by
// its keep/tune/noisy verdict. Surfaces low-volume-but-ineffective bots the count charts bury
// (a 24-thread bot at 25% acted-on reads as clearly "noisy" here, where its stacked bar is a
// sliver). A small verdict legend sits under it so the traffic-light colours are legible.
function EffectivenessChart({ vendors }: { vendors: BotVendorAnalytics[] }): JSX.Element {
  const rated = vendors.filter((v) => v.actedOnPct != null);
  if (rated.length === 0) return <ChartEmpty label="No acted-on data yet" />;
  const series: Series[] = [
    {
      key: 'acted',
      label: 'Acted-on %',
      color: PALETTE.slate,
      values: rated.map((v) => v.actedOnPct ?? 0),
      colors: rated.map((v) => VERDICT_COLOR[v.verdict]),
    },
  ];
  return (
    <div>
      <BarChart
        labels={rated.map((v) => v.label)}
        series={series}
        formatY={pctAxis}
        formatValue={pctAxis}
        rotateLabels
        height={160}
      />
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {(['keep', 'tune', 'noisy'] as BotVerdict[]).map((v) => (
          <span
            key={v}
            className="flex items-center gap-1 text-[10px] capitalize text-gray-500 dark:text-gray-400"
          >
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ background: VERDICT_COLOR[v] }}
            />
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

// Deterministic, ADVISORY tuning hints — which vendor × path is mostly noise. No action is
// attached (mute rules were removed): the fix is to tune the bot on its own platform, or use
// the confirm-gated "resolve addressed threads" flow. Purely informational.
function TuningSuggestions({
  suggestions,
}: {
  suggestions: BotTuningSuggestion[];
}): JSX.Element | null {
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-950/20">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        Tuning suggestions
      </div>
      <ul className="space-y-1.5">
        {suggestions.map((s, i) => {
          const meta = automatedReviewerMeta(s.vendorKind);
          return (
            <li
              key={`${s.vendorKind}:${s.pathGlob ?? '*'}:${s.severity ?? '*'}:${i}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
            >
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium"
                style={{ color: meta.color, background: `${meta.color}1a` }}
              >
                🤖 {meta.label}
              </span>
              <span className="text-gray-600 dark:text-gray-300">{s.rationale}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The totals-strip tile chrome, byte-identical to the plain card it replaces. Split out so the
// five tiles can become drill-downs without any of them restating the class list.
const TILE_CLASS = 'rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800';
// The interactive affordance, and nothing else: a hover border + a focus ring. `text-left`
// matters — a <button> centres its text, which would silently re-align every tile.
const TILE_INTERACTIVE_CLASS =
  'block w-full text-left transition hover:border-sky-300 focus:outline-none' +
  ' focus-visible:ring-1 focus-visible:ring-sky-400 dark:hover:border-sky-700';

// One tile: a plain <div> card, or a <button> when the parent supplied a handler — the
// WorkspaceMetricsPanel `TileShell` rule (a tile becomes clickable only when someone is there to
// route the click), so a mount with nowhere to navigate keeps exactly the markup it had.
//
// ⚠ `title` is the tile's EXISTING tooltip and is passed through verbatim: several of this
// strip's tooltips carry the advisory/honesty disclaimers (what "same-line overlap" counts, what
// is excluded), so a "click to open" hint must never overwrite one. `openLabel` says what opens,
// and it becomes the tooltip only when the tile had none to preserve.
//
// ⚠ NO `aria-label` ON THE BUTTON, deliberately. It would WIN the accessible-name computation
// over name-from-content, so the tile would announce "Show the major and critical findings behind
// this share" and never "High severity, 5%, 107 major or critical" — the numbers this strip
// exists to state, which stop being reachable the moment the markup becomes one <button> leaf.
// It also breaks voice control ("click High severity" would match nothing) — WCAG 2.5.3. The
// house precedent is WorkspaceMetricsPanel's `TileShell`, which carries `title` only for exactly
// this reason, so `openLabel` reaches the user as a tooltip and the tile keeps its own numbers
// as its name.
function Tile({
  title,
  openLabel,
  onClick,
  children,
}: {
  title?: string;
  openLabel: string;
  onClick?: () => void;
  children: ReactNode;
}): JSX.Element {
  if (!onClick) {
    return (
      <div className={TILE_CLASS} title={title}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? openLabel}
      className={`${TILE_CLASS} ${TILE_INTERACTIVE_CLASS}`}
    >
      {children}
    </button>
  );
}

// ── "What the bots are flagging" — the ML severity totals strip (CORE, free, no AI) ──────────
// The survivor of the retired standalone BotSeverityPanel: its per-bot table merged into the
// VendorTable below (the ML columns), and these totals + top-category chips rehomed here — now
// computed from the SAME response and therefore the SAME WINDOW as every other number on the
// screen (the old block was corpus-wide while everything around it was windowed, and one row
// mixing two time grains was the whole complaint). Renders NOTHING when the deployment has no
// scoring service (the caller gates on MeResponse.mlSeverity) or when the window has neither
// labels nor pending text — no empty chrome.
function MlTotalsStrip({
  ml,
  overlapClusters,
  onOpen,
}: {
  ml: BotAnalyticsMlTotals;
  // DETERMINISTIC, not model output: it counts line areas from the threads' own line data (the
  // shared ±3-line clustering), and it rides `totals` rather than the `ml` block for that reason.
  // It renders HERE because this strip is where the window's "what did the bots flag" facts are
  // read, and "two bots flagged the same lines" is one of them.
  overlapClusters: number;
  // Opens the drill-down listing the comments behind a tile/chip. null ⇒ every tile stays a
  // plain card (the `TileShell` rule above).
  //
  // ⚠ THE HANDLER MUST CLOSE OVER THE SAME TRIPLE THIS STRIP WAS MEASURED AT — workspaceId, the
  // selected window, and the repo narrowing. A drill-down that measures a different scope than
  // the tile that opened it is exactly the "one row mixing two time grains" complaint this strip
  // was rebuilt to fix, except harder to spot: the list would simply disagree with the number
  // that was clicked, with nothing on screen saying why.
  onOpen: ((s: BotFlaggingSelector) => void) | null;
}): JSX.Element | null {
  if (ml.labelled === 0 && ml.pending === 0) return null;
  // `undefined` (not a no-op handler) when there is no opener, so `Tile` renders the plain card.
  const open = (s: BotFlaggingSelector): (() => void) | undefined =>
    onOpen ? () => onOpen(s) : undefined;
  // The Findings tile carries its own chrome rather than going through `Tile` — see the ⚠ note at
  // its markup. `focus-within` stands in for the focus ring a single <button> would have had.
  const findingsTileClass = onOpen
    ? `${TILE_CLASS} transition hover:border-sky-300 focus-within:border-sky-300 dark:hover:border-sky-700`
    : TILE_CLASS;
  const coverage =
    ml.labelled + ml.pending > 0 ? ml.labelled / (ml.labelled + ml.pending) : 0;
  const highFindings = ml.bySeverity.major + ml.bySeverity.critical;
  const highShare = ml.findings > 0 ? highFindings / ml.findings : 0;
  const nitShare = ml.findings > 0 ? ml.bySeverity.nit / ml.findings : 0;
  // `backend` without `modernbert-onnx` means the marker heuristic answered — materially worse
  // severities, so it is stated, not hidden.
  const fallbackOnly =
    ml.backends.length > 0 && ml.backends.every((b) => !b.includes('modernbert-onnx'));
  const topCategory = ml.byCategory[0];

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">What the bots are flagging</h3>
        <span
          className="text-[11px] text-gray-400"
          title="Severity and category are predicted by a small local model, not an LLM. Advisory — treat major+critical together as 'high' rather than trusting critical alone."
        >
          model-scored · advisory · over the selected window
        </span>
        {ml.pending > 0 && (
          <span className="ml-auto text-[11px] text-gray-400 tabular-nums">
            {ml.labelled.toLocaleString()} of {(ml.labelled + ml.pending).toLocaleString()} bot
            comments in this window scored ({Math.round(coverage * 100)}%) — the rest are still
            being processed
          </span>
        )}
        {/* The honesty channel: without it, pending 0 reads as 100% coverage while badges are
            visibly missing from the lists below. All-time within this scope, NOT windowed —
            the unscorable population is legacy by nature and sits outside rolling windows. */}
        {ml.unscorable > 0 && (
          <span
            className={`text-[11px] text-gray-400 tabular-nums${ml.pending > 0 ? '' : ' ml-auto'}`}
            title="Comments synced during an old lean-storage window whose text GitHub no longer has (deleted-and-reposted bot comments). They can never be scored and are excluded from every coverage figure."
          >
            {ml.unscorable.toLocaleString()} older comment{ml.unscorable === 1 ? '' : 's'} can’t
            be scored
          </span>
        )}
      </div>

      {ml.truncated && (
        <div className="mb-2 rounded border border-gray-300 px-2 py-1 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
          This window has more labelled bot comments than one read covers — the numbers below
          cover the most recent {ml.labelled.toLocaleString()}.
        </div>
      )}

      {fallbackOnly && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          The scoring service is running its heuristic fallback, not the trained model — these
          severities are low quality. See docs/ML-SEVERITY.md.
        </div>
      )}

      {/* Totals strip — every tile is a claim about the SELECTED WINDOW. The first four are
          model-scored findings; the last is deterministic (see the prop's note). */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {/* ⚠ The Findings tile is the ONE tile that cannot be a single <button>: its sub-line
            drills into a DIFFERENT population (walkthroughs/summaries — the server tests
            isSummary before praise, so they are not findings at all), and a <button> inside a
            <button> is invalid HTML that React warns about and browsers dispatch ambiguously.
            So the chrome stays a <div> and carries two buttons; `focus-within` keeps the whole
            tile reading as interactive. */}
        <div className={findingsTileClass}>
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen({ kind: 'findings' })}
              // No aria-label — it would displace "Findings 2,147" as the accessible name. See Tile.
              title="Show the findings behind this number"
              className="block w-full text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400"
            >
              <div className="text-[10px] uppercase tracking-wide text-gray-400">Findings</div>
              <div className="text-lg font-semibold tabular-nums">
                {ml.findings.toLocaleString()}
              </div>
            </button>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wide text-gray-400">Findings</div>
              <div className="text-lg font-semibold tabular-nums">
                {ml.findings.toLocaleString()}
              </div>
            </>
          )}
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen({ kind: 'summaries' })}
              title="Show the walkthroughs and summaries — a separate population, not counted as findings"
              className="block w-full text-left text-[10px] text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 dark:hover:text-gray-200"
            >
              + {ml.summaries.toLocaleString()} walkthrough/summary
            </button>
          ) : (
            <div className="text-[10px] text-gray-400">
              + {ml.summaries.toLocaleString()} walkthrough/summary
            </div>
          )}
        </div>
        <Tile
          openLabel="Show the major and critical findings behind this share"
          onClick={open({ kind: 'severity', severities: ['major', 'critical'] })}
        >
          <div className="text-[10px] uppercase tracking-wide text-gray-400">High severity</div>
          <div
            className="text-lg font-semibold tabular-nums"
            style={{ color: ML_SEVERITY_META.major.color }}
          >
            {Math.round(highShare * 100)}%
          </div>
          <div className="text-[10px] text-gray-400">
            {highFindings.toLocaleString()} major or critical
          </div>
        </Tile>
        <Tile
          openLabel="Show the findings scored as nits"
          onClick={open({ kind: 'severity', severities: ['nit'] })}
        >
          <div className="text-[10px] uppercase tracking-wide text-gray-400">Nits</div>
          <div
            className="text-lg font-semibold tabular-nums"
            style={{ color: ML_SEVERITY_META.nit.color }}
          >
            {Math.round(nitShare * 100)}%
          </div>
          <div className="text-[10px] text-gray-400">
            {ml.bySeverity.nit.toLocaleString()} trivial or optional
          </div>
        </Tile>
        {/* ⚠ Non-interactive when there is no top category — the tile reads "—", and a button
            that opened an empty category drill-down would be a control with nothing behind it. */}
        <Tile
          openLabel="Show the findings in this topic"
          onClick={
            topCategory ? open({ kind: 'category', category: topCategory.category }) : undefined
          }
        >
          <div className="text-[10px] uppercase tracking-wide text-gray-400">Top topic</div>
          <div className="truncate text-lg font-semibold">
            {topCategory ? (ML_CATEGORY_LABEL[topCategory.category] ?? topCategory.category) : '—'}
          </div>
          <div className="text-[10px] text-gray-400">
            {topCategory
              ? `${topCategory.count.toLocaleString()} findings`
              : 'no categorised findings yet'}
          </div>
        </Tile>
        <Tile
          title="Distinct line areas two or more review bots both flagged in this window. Threads within ±3 lines of each other in the same file count as one area (two bots reviewing different revisions of a diff rarely land on the exact same line). Quality checks and outdated/file-level threads are excluded. Measured from the threads' own line data — not model-scored."
          openLabel="Show the line areas more than one bot flagged"
          onClick={open({ kind: 'overlap' })}
        >
          <div className="text-[10px] uppercase tracking-wide text-gray-400">
            Same-line overlap
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {overlapClusters.toLocaleString()}
          </div>
          <div className="text-[10px] text-gray-400">
            line area{overlapClusters === 1 ? '' : 's'} flagged by &gt;1 bot · window
          </div>
        </Tile>
      </div>

      {/* Top-category chips (rehomed from the old per-bot table's column) + the severity legend,
          which doubles as the vocabulary key for the per-bot mix bars below. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-gray-400">
        {/* Chip 1 and the "Top topic" tile deliberately emit the IDENTICAL selector — they are
            the same `ml.byCategory[0]` object, so they open the same tab. That is correct, not a
            duplicate control: the tile names the topic, the chip sits in the ranked row. */}
        {ml.byCategory.slice(0, 5).map((c) =>
          onOpen ? (
            <button
              key={c.category}
              type="button"
              onClick={() => onOpen({ kind: 'category', category: c.category })}
              title={`Show the findings categorised as ${ML_CATEGORY_LABEL[c.category] ?? c.category}`}
              className="rounded bg-gray-100 px-1 py-0.5 font-medium text-gray-500 hover:bg-gray-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
            >
              {ML_CATEGORY_LABEL[c.category] ?? c.category} {c.count}
            </button>
          ) : (
            <span
              key={c.category}
              className="rounded bg-gray-100 px-1 py-0.5 font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            >
              {ML_CATEGORY_LABEL[c.category] ?? c.category} {c.count}
            </span>
          ),
        )}
        <span className="ml-auto inline-flex flex-wrap items-center gap-2">
          {ML_SEVERITIES.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: ML_SEVERITY_META[s].color }}
              />
              {ML_SEVERITY_META[s].label}
            </span>
          ))}
          <span>Summaries and praise are excluded from severity shares.</span>
        </span>
      </div>
    </div>
  );
}

/*
 * (There is no "mixed role" chip any more, and there is nothing left for one to say. `role` used
 * to be a `repo_reviewers` column, so one login could be a review bot in `api` and a quality gate
 * in `infra`; a multi-repo scope then had to put that reviewer's aggregate in ONE of the two
 * lists while it half-belonged in the other, and the chip existed to admit it. `role` is now a
 * column on the single `workspace_reviewers` row, so within a workspace a bot has exactly one
 * role and appears in exactly one of the two tables below. `mixedRoleRowKeys` is deleted with it.)
 */

/**
 * Automated reviewers roled `quality_check` — coverage/quality gates (SonarQube, Codecov,
 * CodeClimate, …) rather than code reviewers.
 *
 * COLLAPSED and VOLUME-ONLY by design. These rows exist so the user can (a) confirm the gate is
 * still running and (b) spot a MIS-role, and for nothing else. Deliberately absent: verdict, noise
 * ratio, $/acted-on and the charts — the whole point of the role is that ROI judgements do not
 * apply, and showing a greyed-out verdict column would invite reading one anyway. The counts are
 * NOT in `totals` either, so the summary line above stays a review-bot number.
 *
 * `<details>` rather than React state: it is a disclosure with no other behaviour, and the browser
 * already gets keyboard + a11y right for free.
 */
function QualityCheckSection({
  rows,
  botColor,
}: {
  rows: BotVendorAnalytics[];
  botColor: (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <details className="rounded-lg border border-gray-200 dark:border-gray-800">
      <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Quality checks ({rows.length}){' '}
        <span className="font-normal normal-case tracking-normal text-gray-400">
          — excluded from ROI
        </span>
      </summary>
      <div className="border-t border-gray-200 px-3 py-2 dark:border-gray-800">
        <div className="mb-2 text-[11px] text-gray-500 dark:text-gray-400">
          Coverage and quality gates, not code reviewers. Their volume and untouched threads are
          left out of the verdicts and totals above — an unread coverage report is the norm, not
          noise. Re-role one in <span className="font-medium">Settings</span> if it belongs in the
          ROI table.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400">
                <th className="py-1 pr-3 font-medium">Check</th>
                <th className="py-1 pr-3 text-right font-medium">Threads</th>
                <th className="py-1 pr-3 text-right font-medium">Comments</th>
                <th className="py-1 text-right font-medium">Last active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.key} className="border-t border-gray-100 dark:border-gray-800/60">
                  <td className="py-1 pr-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: botColor({ login: v.login, kind: v.kind }) }}
                      />
                      <span className="text-gray-700 dark:text-gray-200">{v.label}</span>
                      {/* A dormant gate is the interesting case here: it usually means the
                          integration broke, not that the bot got quieter. */}
                      {v.dormant && (
                        <span className="rounded bg-gray-500/10 px-1 py-px text-[10px] text-gray-500">
                          dormant
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">{v.threads}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{v.comments}</td>
                  <td className="py-1 text-right text-gray-500 dark:text-gray-400">
                    {v.lastActiveAt != null ? relativeTime(v.lastActiveAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

function VendorTable({
  vendors,
  botColor,
  onOpenVendor,
  overdueGraceMs,
  showMl,
  onTune,
  onDrop,
}: {
  vendors: CostedVendor[];
  botColor: BotColor;
  onOpenVendor: (key: string) => void;
  overdueGraceMs: number;
  // The ML severity columns (mix bar / High / Nits / the four "not addressed by severity"
  // columns) — rendered ONLY when the deployment scores (MeResponse.mlSeverity) AND the window
  // has labels. False must render NO ml chrome at all.
  showMl: boolean;
  // The Bot Tuning Advisor entry point (Pro `botAdvisor`): per-row Tune/Drop pills that open
  // the Advisor tab focused on this bot. BOTH null in free mode → the Actions column does not
  // render at all (hidden, not upsold).
  onTune?: ((key: string) => void) | null;
  onDrop?: ((key: string) => void) | null;
}): JSX.Element {
  // ⚠ THE HEADER IS TWO ROWS WHEN `showMl`, ONE WHEN NOT — because the four "not addressed by
  // severity" columns sit under a shared group cell, and a group cell only makes sense with a
  // second row beneath it. Every OTHER header cell therefore has to span both rows, or the four
  // sub-headers shove the ordinary columns out of alignment with their own data. Add a column
  // here and it needs `rowSpan={headSpan}` too.
  const headSpan = showMl ? 2 : 1;
  const showActions = Boolean(onTune ?? onDrop);
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table
        className={`w-full border-collapse text-[11px] ${
          showActions
            ? showMl
              ? 'min-w-[1450px]'
              : 'min-w-[1090px]'
            : showMl
              ? 'min-w-[1330px]'
              : 'min-w-[970px]'
        }`}
      >
        <thead>
          <tr className={`text-left text-gray-500 dark:text-gray-400${showMl ? '' : ' border-b border-gray-200 dark:border-gray-800'}`}>
            <th rowSpan={headSpan} className="px-2 py-1.5 font-medium">Vendor</th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium">Threads</th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium">Comments</th>
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="A later commit likely addressed the thread, it was resolved, or a human replied/resolved after the bot"
            >
              Acted on
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="Threads with no reply and no follow-up commit — the total not-addressed">
              Not addressed
            </th>
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title={`Not-addressed threads older than the ${Math.round(
                overdueGraceMs / 3_600_000,
              )}h grace window — the genuinely-ignored ones that drive the 'noisy' verdict`}
            >
              Overdue
            </th>
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="PRs merged inside the window that still carried at least one not-addressed thread by this bot at merge — the team's final answer was to ship anyway. The threads themselves may be older than the window."
            >
              Merged past
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="This bot's median time from opening a thread to it being addressed — a human reply, a resolve, or an addressing commit">
              Time to address
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="Not-addressed threads' oldest age">
              Oldest
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="Low-value / untouched share — the noise floor">
              Noise
            </th>
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="Share of this bot's threads landing within ±3 lines of another bot's thread in the same file — redundant coverage. Advisory only; hover a cell for the top partner. Outdated/file-level threads (no line) never count."
            >
              Overlap
            </th>
            {showMl && (
              <>
                <th
                  rowSpan={headSpan}
                  className="w-28 px-2 py-1.5 font-medium"
                  title="This bot's scored findings by predicted severity, over the selected window — model-scored, advisory. Summaries and praise are excluded."
                >
                  Severity mix
                </th>
                <th
                  rowSpan={headSpan}
                  className="px-2 py-1.5 text-right font-medium"
                  title="Major + critical as a share of this bot's scored findings in the window."
                >
                  High
                </th>
                <th
                  rowSpan={headSpan}
                  className="px-2 py-1.5 text-right font-medium"
                  title="Nits as a share of this bot's scored findings in the window — a persistently high share suggests raising the bot's severity floor."
                >
                  Nits
                </th>
                {/* The group cell for the four columns below it. Its own count is deliberately
                    NOT shown: these are a split of the LABELLED not-addressed threads, so they
                    need not add up to the "Not addressed" column, and a total here would invite
                    exactly that subtraction. */}
                <th
                  colSpan={4}
                  className="border-l border-gray-200 px-2 pb-0 pt-1.5 text-center font-medium dark:border-gray-800"
                  title="This bot's not-addressed threads, split by the predicted severity of the finding that opened each one. Model-scored and advisory: threads whose opening comment was never scored aren't counted, so these need not add up to the Not addressed column."
                >
                  Not addressed by severity
                </th>
              </>
            )}
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="Monthly cost ÷ acted-on threads. The price is this bot's price FOR THIS WORKSPACE — set it on the bot's card in Bots → Settings. Narrowed to a single repo this divides a whole month's price by part of that bot's work, so read it as a rate, not as spend, and never add it up across workspaces."
            >
              $/acted-on
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-center font-medium">Verdict</th>
            {showActions && (
              <th
                rowSpan={headSpan}
                className="px-2 py-1.5 text-center font-medium"
                title="Open the Bot Tuning Advisor focused on this bot — Tune shows its evidence-backed configuration changes; Drop assembles the case for removing it."
              >
                Actions
              </th>
            )}
          </tr>
          {showMl && (
            <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800 dark:text-gray-400">
              {SEVERITY_COLUMNS.map((s, i) => (
                <th
                  key={s}
                  className={`px-1.5 pb-1.5 text-right text-[10px] font-medium${i === 0 ? ' border-l border-gray-200 dark:border-gray-800' : ''}`}
                  style={{ color: ML_SEVERITY_META[s].color }}
                  title={`Not-addressed threads whose opening finding scored ${ML_SEVERITY_META[s].label.toLowerCase()}`}
                >
                  {s === 'critical' ? 'Crit' : ML_SEVERITY_META[s].label}
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {vendors.map((v) => {
            const color = botColor({ login: v.login, kind: v.kind });
            const verdict = VERDICT_META[v.verdict];
            // A DORMANT row (no window activity — the row survives on its 12-week trend):
            // zeros here would read as "active but useless", so dash the window metrics and
            // explain via a chip + last-active instead.
            const dash = <span className="text-gray-300 dark:text-gray-600">—</span>;
            return (
              <tr
                key={v.key}
                className="border-b border-gray-100 last:border-0 dark:border-gray-800/60"
              >
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => onOpenVendor(v.key)}
                    title="Open the bot drill-down — its comments (default) and the PRs it touched"
                    className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:underline"
                    style={{ color, background: `${color}1a` }}
                  >
                    🤖 {v.label}
                  </button>
                  {v.reviewers > 1 && (
                    <span className="ml-1 text-gray-400">×{v.reviewers}</span>
                  )}
                  {v.dormant && (
                    <span
                      className="ml-1.5 inline-block rounded border border-gray-300 px-1 py-px text-[10px] text-gray-400 dark:border-gray-700 dark:text-gray-500"
                      title="No activity in the selected window — the trend below still shows its earlier threads. Widen the window to see them counted."
                    >
                      dormant
                      {v.lastActiveAt != null && ` · last active ${relativeTime(v.lastActiveAt)}`}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {v.dormant ? dash : v.threads}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.dormant ? dash : v.comments}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {v.dormant ? (
                    dash
                  ) : (
                    <>
                      <span className="text-gray-700 dark:text-gray-200">{v.actedOn}</span>
                      <span className="ml-1 text-gray-400">{pct(v.actedOnPct)}</span>
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {v.dormant ? (
                    dash
                  ) : (
                    <span
                      className={
                        v.untouched > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'
                      }
                    >
                      {v.untouched}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {v.dormant ? (
                    dash
                  ) : (
                    <span
                      className={
                        v.overdueUntouched > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'
                      }
                      title={
                        v.untouched > 0
                          ? `${v.overdueUntouched} of ${v.untouched} not-addressed threads are past the normal response window`
                          : undefined
                      }
                    >
                      {v.overdueUntouched}
                    </span>
                  )}
                </td>
                {/* Merged past — NOT dashed on dormant: it keys on PRs MERGED in the window,
                    whose threads may be arbitrarily old, so a window-quiet bot can still have
                    shipped-past PRs. `?? null` guards a stale cached response predating the
                    field (blank, never NaN — the overlap precedent). */}
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  title={
                    (v.mergedPastPrs ?? 0) > 0
                      ? `${v.mergedPastPrs} PR${v.mergedPastPrs === 1 ? '' : 's'} merged this window still carrying ${v.mergedPastThreads} not-addressed thread${v.mergedPastThreads === 1 ? '' : 's'} by this bot`
                      : 'No PR merged this window carried a not-addressed thread by this bot'
                  }
                >
                  {(v.mergedPastPrs ?? null) == null ? (
                    dash
                  ) : (
                    <span
                      className={
                        v.mergedPastPrs > 0
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-gray-400'
                      }
                    >
                      {v.mergedPastPrs}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.dormant ? dash : dur(v.medianAddressedMs)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.oldestUntouchedDays != null ? `${v.oldestUntouchedDays}d` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.dormant ? dash : pct(v.noiseRatioPct)}
                </td>
                {/* Same-line overlap — advisory. `?? null` guards a stale cached response that
                    predates the field (the column then reads as blank, never NaN). */}
                <td
                  className="px-2 py-1.5 text-right tabular-nums text-gray-500"
                  title={
                    v.topOverlapPartner
                      ? `${v.overlapThreads} thread${v.overlapThreads === 1 ? '' : 's'} land on lines ${v.topOverlapPartner.label} also flagged (${v.topOverlapPartner.clusters} shared spot${v.topOverlapPartner.clusters === 1 ? '' : 's'})`
                      : 'No threads landing on lines another bot also flagged in this window'
                  }
                >
                  {v.dormant ? dash : pct(v.overlapPct ?? null)}
                </td>
                {/* ML severity mix over the SAME window as every other cell. A bot with NO
                    labels in-window ships the fields ABSENT and renders blanks — never zeros,
                    because "not scored" and "zero findings" are different claims. */}
                {showMl && (
                  <>
                    <td
                      className="w-28 px-2 py-1.5"
                      title={
                        v.mlFindings != null
                          ? `${v.mlFindings} scored finding${v.mlFindings === 1 ? '' : 's'} in the window`
                          : 'No scored comments for this bot in the window'
                      }
                    >
                      {v.mlBySeverity && v.mlFindings != null && v.mlFindings > 0 ? (
                        <SeverityBar counts={v.mlBySeverity} total={v.mlFindings} />
                      ) : (
                        dash
                      )}
                    </td>
                    <td
                      className="px-2 py-1.5 text-right font-semibold tabular-nums"
                      style={v.mlHighPct != null ? { color: ML_SEVERITY_META.major.color } : undefined}
                    >
                      {v.mlHighPct != null ? `${v.mlHighPct}%` : dash}
                    </td>
                    <td
                      className="px-2 py-1.5 text-right tabular-nums"
                      style={v.mlNitPct != null ? { color: ML_SEVERITY_META.nit.color } : undefined}
                    >
                      {v.mlNitPct != null ? `${v.mlNitPct}%` : dash}
                    </td>
                    {/* Not-addressed threads by the severity of the finding that opened them. A
                        ZERO renders as a blank, like every other ML cell: the four are a split of
                        the LABELLED not-addressed threads, so a 0 says "none scored that way",
                        which is not a number worth drawing attention to — and printing zeros
                        would invite reading the row as a decomposition of "Not addressed". */}
                    {SEVERITY_COLUMNS.map((s, i) => {
                      const n = v.notAddressedBySeverity?.[s] ?? 0;
                      return (
                        <td
                          key={s}
                          className={`px-1.5 py-1.5 text-right tabular-nums${i === 0 ? ' border-l border-gray-200 dark:border-gray-800' : ''}`}
                          style={n > 0 ? { color: ML_SEVERITY_META[s].color } : undefined}
                          title={
                            n > 0
                              ? `${n} not-addressed thread${n === 1 ? '' : 's'} opened by a ${ML_SEVERITY_META[s].label.toLowerCase()} finding`
                              : undefined
                          }
                        >
                          {n > 0 ? n : dash}
                        </td>
                      );
                    })}
                  </>
                )}
                {/* The $/acted-on figure. The price is a plain column on this bot's WORKSPACE row
                    — one row per actor here, so nothing is inherited, shared or split, and the
                    tooltip names the workspace rather than an account-wide subscription. The
                    predecessor's per-team column needed an "inh" marker to stop three teams
                    inheriting one $120 tool reading as $360; there is no inheritance left to
                    label, only the rule that a figure from THIS workspace is not a figure about
                    another one. */}
                <td
                  className="px-2 py-1.5 text-right tabular-nums text-gray-500"
                  // Money is printed through the same formatter as the cost box in Bots →
                  // Settings, so "45.50" there can't read back as "45.5" here.
                  title={
                    v.costMonthlyUsd == null
                      ? v.legacyOnlyUsd != null
                        ? // An UNAPPLIED pointer, never a price. The old account-wide list still
                          // holds $X for this login, but nothing reads it any more — including
                          // when the user deliberately CLEARED the price, which is indistinguishable
                          // from "never migrated" on this row. So it is offered, not charged.
                          `No price set for this bot in this Workspace. The old account-wide list still has $${formatCostInput(v.legacyOnlyUsd)}/mo for it — re-enter it in Bots → Settings to use it.`
                        : 'No price set for this bot in this Workspace — set one in Bots → Settings.'
                      : // `costMonthlyUsd` arrives EFFECTIVE (the server already multiplied a
                        // per-seat unit by the Workspace's derived seat count on read), so the
                        // per-seat case only ANNOTATES the figure — nothing here multiplies.
                        `$${formatCostInput(v.costMonthlyUsd)}/mo for this bot in this Workspace${
                          v.costModel === 'per_seat' && v.costUnitMonthlyUsd != null
                            ? ` — $${formatCostInput(v.costUnitMonthlyUsd)}/seat at ${v.costSeatCount} seat${v.costSeatCount === 1 ? '' : 's'}`
                            : ''
                        }. Another Workspace may hold a different figure; the two are never added together.`
                  }
                >
                  {v.dormant ? (
                    dash
                  ) : (
                    <>
                      {usd(v.costPerActedOnUsd)}
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {v.dormant ? (
                    dash
                  ) : (
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${verdict.className}`}
                      title={verdict.title}
                    >
                      {verdict.label}
                    </span>
                  )}
                </td>
                {showActions && (
                  <td className="px-2 py-1.5 text-center">
                    <span className="inline-flex gap-1">
                      {onTune && (
                        <button
                          type="button"
                          onClick={() => onTune(v.key)}
                          title="Open the Advisor on this bot's tuning findings — evidence-backed config changes, retro-checked before any PR"
                          className="rounded border border-amber-400 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-600/70 dark:text-amber-300 dark:hover:bg-amber-950/40"
                        >
                          Tune
                        </button>
                      )}
                      {onDrop && (
                        <button
                          type="button"
                          onClick={() => onDrop(v.key)}
                          title="Open the Advisor with the case for dropping this bot — its acted-on rate, overlap and suppression evidence in one brief"
                          className="rounded border border-red-400 px-1.5 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50 dark:border-red-600/70 dark:text-red-300 dark:hover:bg-red-950/40"
                        >
                          Drop
                        </button>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The workspace-wide "clear the stale-bot backlog" caution — rendered in BotsView directly beneath
// the "only a bot reviewed" caution and styled to MATCH it (full-width clickable + a "Show list"
// pill), in sky (its own colour). The whole banner opens the resolvable-bot-threads review-and-
// resolve drill-down TAB (BotThreadsDetail). Renders NOTHING until the eager resolvable query (a
// lean per-PR id-list) shows ≥1 likely-addressed automated-reviewer thread.
//
// `workspaceId` is what decides WHICH logins count as automated here, and it is the same id the
// resolve POSTs — the offer and the resolve cannot disagree. `repoIds` only narrows which repos'
// threads are listed.
export function ResolveBacklogBanner({
  workspaceId,
  repoIds,
}: {
  workspaceId: number | null;
  repoIds: number[] | null;
}): JSX.Element | null {
  const { data } = useResolvableBotThreads(workspaceId, true, repoIds);
  const openBotThreadsDetail = useFilters((s) => s.openBotThreadsDetail);
  const totalThreads = data?.totalThreads ?? 0;

  if (totalThreads === 0) return null;

  return (
    <button
      type="button"
      onClick={() => openBotThreadsDetail(repoIds?.[0] ?? null)}
      data-testid="resolve-backlog-caption"
      title="Review & resolve the likely-addressed bot threads"
      className="flex w-full items-start gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-left text-[11px] text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300 dark:hover:bg-sky-900/40"
    >
      <span className="flex-1">
        🧹 <span className="font-semibold tabular-nums">{totalThreads}</span> likely-addressed bot
        thread{totalThreads === 1 ? '' : 's'} look resolved by later commits — review before
        resolving on GitHub.
      </span>
      <span className="shrink-0 self-center rounded border border-sky-400 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-600/70 dark:text-sky-300">
        Show list →
      </span>
    </button>
  );
}

// Scope = the ACTIVE WORKSPACE. `repoId` additionally narrows the DATA to ONE repo (the per-repo
// Bots tab): the analytics and the vendor drill-down measure that repo alone, and only bots with
// activity in it surface. It does NOT change the judgement — who counts as a bot is the
// workspace's answer either way.
export function BotRoiPanel({ repoId }: { repoId?: number } = {}): JSX.Element | null {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const openBotPrsDetail = useFilters((s) => s.openBotPrsDetail);
  const openBotOnlyDetail = useFilters((s) => s.openBotOnlyDetail);
  // The "what the bots are flagging" tiles/chips → the flagging drill-down tab.
  const openBotFlaggingDetail = useFilters((s) => s.openBotFlaggingDetail);
  // The Tune/Drop pills → the Advisor tab, focused on the clicked bot. Pro-gated
  // (`botAdvisor`), hidden-not-upsold, and cross-repo-rail only: the Advisor tab itself
  // doesn't render in the per-repo console (it is workspace-grain, like Themes), so a pill
  // there would navigate nowhere.
  const focusAdvisor = useFilters((s) => s.focusAdvisor);
  const { botAdvisor } = useProCapabilities();
  const advisorPillsOn = botAdvisor && repoId == null;
  // The workspace decides the VERDICT; `repoIds` only narrows the measured data. Both occupy
  // their own query-key slot, so either change refetches and two workspaces can never share a
  // cache entry.
  const workspaceId = useFilters((s) => s.workspaceId);
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const { data, isLoading, isError } = useBotAnalytics(workspaceId, window, true, repoScope);
  const botColor = useBotColors(workspaceId);
  // The ML severity surface: hidden ENTIRELY (no columns, no strip, no empty chrome) when the
  // deployment has no scoring service — /api/me's mlSeverity is the gate, exactly as the old
  // standalone panel gated. Columns additionally need at least one in-window label, or every
  // cell would be a blank; the strip also shows while a backlog is still being scored so the
  // coverage line can say so.
  const mlEnabled = useMlSeverityEnabled();
  const ml = data?.ml;
  const showMlStrip = mlEnabled && ml != null;
  const showMlColumns = mlEnabled && (ml?.labelled ?? 0) > 0;
  // The DEPRECATED per-login cost blob. Read ONLY to POINT AT a stranded price in the tooltip of
  // a row the server resolved to null — never to fill that null (see `resolveVendorCost`). Still
  // gated on plugin presence so the pure OSS path never hits /api/pro/settings (which 404s without
  // the plugin) — and OSS installs have no legacy blob anyway, since cost only ever lived in the
  // plugin's table before this.
  const { data: settings } = useProSettings(useHasProSettings());

  const legacyCostByLogin = useMemo(
    () => new Map((settings?.bots.cost ?? []).map((c) => [c.login, c.monthlyUsd])),
    [settings?.bots.cost],
  );
  const vendors = useMemo(
    () => (data ? withResolvedCost(data.vendors, legacyCostByLogin) : []),
    [data, legacyCostByLogin],
  );
  // Automated reviewers the user (or the migration's login seed) marked `role: 'quality_check'`.
  // The server computes their numbers identically but keeps them OUT of `vendors`/`totals`/
  // `suggestions`, because a coverage gate's untouched threads would earn it a `noisy` verdict
  // for doing exactly its job.
  //
  // ⚠ THEY MUST STILL BE SHOWN SOMEWHERE. Without this section, marking a bot as a quality check
  // in Bots → Settings makes it silently VANISH from the only screen that lists review bots —
  // indistinguishable from "we stopped detecting it", and there is no way to notice a MIS-role.
  // Volume only: no verdict, no noise ratio, no $/acted-on, because those are the ROI judgements
  // that were deliberately withheld.
  const qualityChecks = data?.qualityChecks ?? [];

  const header = (
    // The "Review-bot ROI" heading was dropped (the rail line already has a header); just the
    // window/date-range picker remains, right-aligned.
    <div className="flex flex-wrap items-center gap-2">
      <div className="ml-auto inline-flex overflow-hidden rounded border border-gray-300 dark:border-gray-700">
        {WINDOWS.map((wOpt) => (
          <button
            key={wOpt.key}
            type="button"
            onClick={() => setWindow(wOpt.key)}
            className={`px-2 py-0.5 text-[11px] font-medium ${
              window === wOpt.key
                ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
                : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
            }`}
          >
            {wOpt.label}
          </button>
        ))}
      </div>
    </div>
  );

  let body: JSX.Element;
  if (isLoading) {
    body = (
      <div className="h-28 animate-pulse rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/40" />
    );
  } else if (isError) {
    body = <div className="text-sm text-red-500">Couldn’t load bot analytics.</div>;
  } else if (!data || vendors.length === 0) {
    // LANDMINE: "no vendors" is NOT the same as "no bots". If every automated reviewer in scope
    // is roled `quality_check`, `vendors` is empty while `qualityChecks` is not — claiming "no
    // activity" there would be a lie, and would hide the only rows that exist. So the
    // quality-check section renders in the empty branch too, and the wording softens to name it.
    body = (
      <div className="space-y-3">
        <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
          No review-bot activity in this window.
          <div className="mt-1 text-[11px]">
            When review bots (CodeRabbit, Copilot, in-house AI…) comment on your PRs, their
            signal-to-noise lands here. A bot that was active earlier may just be quiet — try
            widening the window above.
            {qualityChecks.length > 0 && ' Quality checks are listed separately below.'}
          </div>
        </div>
        <QualityCheckSection rows={qualityChecks} botColor={botColor} />
      </div>
    );
  } else {
    const t = data.totals;
    body = (
      <div className="space-y-3">
        {/* The severity totals strip (the old BotSeverityPanel's survivor) — same response,
            same window as the table below it. Self-hides when the window has nothing scored
            and nothing pending. */}
        {showMlStrip && ml && (
          <MlTotalsStrip
            ml={ml}
            overlapClusters={t.overlapClusters ?? 0}
            // ⚠ The drill-down inherits the SAME triple this panel measured with: the workspace
            // (`workspaceId`, read by the tab from the store), the window (`botAnalyticsWindow`,
            // the shared transient field — which is why the tab must not keep a local one), and
            // the repo narrowing. `repoId ?? null` is that third leg: on the per-repo Bots tab
            // the tile counts ONE repo, so the list must too.
            onOpen={(s) => openBotFlaggingDetail(s, repoId ?? null)}
          />
        )}
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-200">
            {t.threads}
          </span>{' '}
          bot thread{t.threads === 1 ? '' : 's'} · {t.comments} comment
          {t.comments === 1 ? '' : 's'} ·{' '}
          <span className="tabular-nums">{pct(t.actedOnPct)}</span> acted on ·{' '}
          <span className="tabular-nums text-amber-600 dark:text-amber-400">
            {t.untouched}
          </span>{' '}
          not addressed
          {' · '}
          <span
            className="tabular-nums"
            title="Not-addressed threads count as overdue (and feed the 'noisy' verdict) once they're older than this fixed grace window."
          >
            overdue after {Math.round(t.overdueGraceMs / 3_600_000)}h
          </span>
          {' · '}
          <button
            type="button"
            onClick={() => openBotOnlyDetail(repoId ?? null)}
            title="Show the OPEN PRs only a bot reviewed — no human review or comment since they opened"
            className="rounded underline decoration-dotted underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <b className="tabular-nums text-gray-700 dark:text-gray-200">{t.botOnlyPrs}</b>{' '}
            bot-only open PR{t.botOnlyPrs === 1 ? '' : 's'}
          </button>
        </div>
        <VendorTable
          vendors={vendors}
          botColor={botColor}
          onOpenVendor={(key) => openBotPrsDetail(key, repoId ?? null)}
          overdueGraceMs={t.overdueGraceMs}
          showMl={showMlColumns}
          onTune={advisorPillsOn ? (key) => focusAdvisor(key, 'tune') : null}
          onDrop={advisorPillsOn ? (key) => focusAdvisor(key, 'drop') : null}
        />
        {/* Bot-effectiveness charts (per vendor) — all always visible: raw weekly volume, the
            volume-independent effectiveness + verdict, and the acted-on vs untouched split. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ChartCard title="Thread volume" note="weekly · last 12">
            <VendorTrendChart vendors={vendors} value={threadsVal} botColor={botColor} />
          </ChartCard>
          <ChartCard title="Bot effectiveness" note="acted-on % · keep / tune / noisy">
            <EffectivenessChart vendors={vendors} />
          </ChartCard>
          <ChartCard title="Acted-on vs untouched" note="by bot · current window">
            <ActedVsUntouchedChart vendors={vendors} />
          </ChartCard>
        </div>
        <TuningSuggestions suggestions={data.suggestions} />
        <QualityCheckSection rows={qualityChecks} botColor={botColor} />
        <div className="text-[11px] text-gray-400">
          “Acted on” = a later commit likely addressed the thread, it was resolved, or a human
          replied/resolved after the bot (approximate). Noise ratio = the untouched share of a
          bot's threads. Set a bot's monthly price in{' '}
          <span className="font-medium">Bots → Settings</span> to see $/acted-on — the price is per{' '}
          <span className="font-medium">Workspace</span>, so another Workspace may hold a different
          figure for the same bot and the two are never added together.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="bot-roi-panel">
      {header}
      {body}
    </div>
  );
}
