import { useMemo, type ReactNode } from 'react';
import type {
  AutomatedReviewerKind,
  BotAnalyticsMlTotals,
  BotFlaggingSelector,
  BotInflationWeekPoint,
  BotTuningSuggestion,
  BotVendorAnalytics,
  BotVendorTrendPoint,
  BotVerdict,
  BotVolumeBot,
  BotVolumeResponse,
  BotWindowKind,
  MlSeverity,
} from '@pierre-review/shared';
import type { BotFlaggingBotNarrowing } from '../../lib/severityAgreement.js';
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
import { useProSettings } from '../../hooks/useProSettings.js';
import { useFilters } from '../../store/filters.js';
import { usePinnedTabs, type TabBotMeta } from '../../store/pinnedTabs.js';
import {
  automatedReviewerMeta,
  ML_CATEGORY_LABEL,
  ML_SEVERITY_META,
  relativeTime,
  vendorInk,
} from '../../lib/ui.js';
import { formatCostInput, resolveVendorCost } from '../../lib/botCost.js';
import { RARELY_USED_MAX_PCT, RARELY_USED_MIN_THREADS, stopPayingLine } from '../../lib/botSavings.js';
import { formatAvg, volumeByKey } from '../../lib/botVolume.js';
import { useBotVolume } from '../../hooks/useBotVolume.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { ArrowIcon, BotIcon, ResolveIcon, WarningIcon } from '../Icons.js';
import { Callout, Segmented, STICKY_COL, TABLE, TABLE_SCROLL, TR_HOVER } from './reportChrome.js';
import { InfoButton } from '../InfoModal.js';
import { SeverityBar } from '../MlSeverityBadge.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { ChartCard, ChartEmpty, PALETTE, type Series } from '../charts/common.js';
import { InflationHistoryChart } from './InflationHistoryChart.js';

// Bot ROI / utilisation panel, rendered in the Bots rail console. Deterministic and model-free: a
// per-bot signal-to-noise table + a 12-week thread-volume trend + keep/tune/noisy verdicts + the ML
// flagging strip.
//
// `ResolveBacklogBanner` and `TuningSuggestions` are exported from here but MOUNTED in BotsView,
// outside the panel.
//
// SCOPE IS ONE WORKSPACE (+ an optional repo narrowing on the DATA). A bot is a per-WORKSPACE
// object, so a vendor running in six of the workspace's repos is ONE row here, merged by GitHub
// handle.
//
// COST IS SERVER-RESOLVED on each analytics row (`costMonthlyUsd` / `costPerActedOnUsd`), read
// from `workspace_reviewers.monthly_cents`. The old client-side overlay from pro_settings `bots.cost` is gone: a per-LOGIN map could not be
// edited or cleared from the surface that displayed it. All that remains of it is `legacyOnlyUsd` —
// a POINTER at a price plugin migration 0019 could not move onto a row, shown in the cell's tooltip
// and never applied (see `resolveVendorCost`: filling a null from that blob silently resurrected
// prices the user had deliberately CLEARED, with no write path left to remove them).
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
    className: 'text-ui-success',
    title: 'Healthy signal-to-noise — worth keeping on.',
  },
  tune: {
    label: 'Tune',
    className: 'text-ui-warn',
    // Two routes reach this chip and the copy has to cover both: a lot of threads going
    // unaddressed, OR a bot whose scored findings are overwhelmingly nits (the same gates as the
    // nit tuning suggestion, so the reason is spelled out in the list below the table).
    title:
      'Either a lot of comments go unaddressed, or nearly everything it flags scores as a nit — consider tuning which paths and severities the bot comments on.',
  },
  noisy: {
    label: 'Rarely used',
    className: 'text-ui-danger',
    title:
      'High volume, few comments used, and many threads left unanswered past your normal response window — probably not paying for itself.',
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
    { key: 'acted', label: 'Used', color: PALETTE.green, values: vendors.map((v) => v.actedOn) },
    { key: 'untouched', label: 'Not addressed', color: PALETTE.amber, values: vendors.map((v) => v.untouched) },
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
      label: 'Used %',
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
            className="flex items-center gap-1 text-meta capitalize text-ui-mute"
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
//
// ⚠ EXPORTED, AND MOUNTED BY BotsView — NOT BY THE PANEL BELOW, so it renders ABOVE the ROI
// table. Do not mount it twice.
export function TuningSuggestions({
  suggestions,
}: {
  suggestions: BotTuningSuggestion[];
}): JSX.Element | null {
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-ui bg-ui-surface px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-body font-medium text-ui-ink">
        <WarningIcon className="text-ui-warn" />
        Tuning suggestions
      </div>
      <ul className="space-y-1.5">
        {suggestions.map((s, i) => {
          const meta = automatedReviewerMeta(s.vendorKind);
          return (
            <li
              key={`${s.vendorKind}:${s.pathGlob ?? '*'}:${s.severity ?? '*'}:${i}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta"
            >
              <span
                className="inline-flex items-center gap-1 rounded-ui px-1.5 py-0.5 font-medium"
                style={{ ...vendorInk(meta.color), background: `${meta.color}1a` }}
              >
                <BotIcon size={11} />
                {meta.label}
              </span>
              <span className="text-ui-mute">{s.rationale}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The totals-strip tile chrome, byte-identical to the plain card it replaces. Split out so the
// five tiles can become drill-downs without any of them restating the class list.
const TILE_CLASS = 'rounded-ui px-2 py-1.5 bg-ui-surface';
// The interactive affordance, and nothing else: a hover border + a focus ring. `text-left`
// matters — a <button> centres its text, which would silently re-align every tile.
const TILE_INTERACTIVE_CLASS =
  'block w-full text-left transition focus:outline-none' +
  ' focus-visible:ring-1 focus-visible:ring-ui-accent';

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

// ── "What the bots are flagging" — the ML severity totals strip (no AI) ───────────────────────
// ⚠ NOT the same thing as the per-COMMENT ML severity badges, which read a different route
// (`/api/prs/:id/ml-labels`). This is the workspace-grain rollup and lives inside `BotRoiPanel`.
// `MeResponse.mlSeverity` is its gate — it says whether the deployment scores at all.
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
    ? `${TILE_CLASS} transition`
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
    <div className="rounded-ui p-3 bg-ui-surface">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-body font-semibold">What the bots are flagging</h3>
        <InfoButton title="What the bots are flagging">
          <p>
            Each bot comment is given a severity (nit, minor, major, critical) and up to eight
            categories by a small model that runs on our side. It is not an LLM, and it never reads
            the bot’s own severity badge.
          </p>
          <p>
            Treat major and critical together as “high”. The model rarely calls something critical,
            so critical on its own undercounts.
          </p>
          <p>
            Severity shares count findings only. Walkthrough summaries and praise are left out.
          </p>
          <p>Every figure covers the window picked above.</p>
          <p>
            Some older comments can never be scored: their text was not stored when they synced and
            GitHub no longer has it. They are left out of every figure here.
          </p>
        </InfoButton>
        <span className="text-meta text-ui-mute">model-scored</span>
        {ml.pending > 0 && (
          <span className="ml-auto text-meta text-ui-faint tabular-nums">
            {ml.labelled.toLocaleString()} of {(ml.labelled + ml.pending).toLocaleString()} bot
            comments in this window scored ({Math.round(coverage * 100)}%), the rest still
            in progress
          </span>
        )}
        {/* The honesty channel: without it, pending 0 reads as 100% coverage while badges are
            visibly missing from the lists below. All-time within this scope, NOT windowed —
            the unscorable population is legacy by nature and sits outside rolling windows. */}
        {ml.unscorable > 0 && (
          <span
            className={`text-meta text-ui-faint tabular-nums${ml.pending > 0 ? '' : ' ml-auto'}`}
          >
            {ml.unscorable.toLocaleString()} older comment{ml.unscorable === 1 ? '' : 's'} can’t
            be scored
          </span>
        )}
      </div>

      {ml.truncated && (
        <div className="mb-2 rounded-ui px-2 py-1 text-meta text-ui-mute bg-ui-surface">
          This window has more labelled bot comments than one read covers — the numbers below
          cover the most recent {ml.labelled.toLocaleString()}.
        </div>
      )}

      {fallbackOnly && (
        <div className="mb-2 rounded-ui bg-ui-surface px-2 py-1 text-meta text-ui-ink">
          The scoring service is running a simple fallback, not the trained model, so these
          severities are much less reliable.
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
              className="hit block w-full text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
            >
              <div className="text-meta text-ui-faint">Findings</div>
              <div className="text-title font-semibold tabular-nums">
                {ml.findings.toLocaleString()}
              </div>
            </button>
          ) : (
            <>
              <div className="text-meta text-ui-faint">Findings</div>
              <div className="text-title font-semibold tabular-nums">
                {ml.findings.toLocaleString()}
              </div>
            </>
          )}
          {onOpen ? (
            <button
              type="button"
              onClick={() => onOpen({ kind: 'summaries' })}
              title="Show the walkthroughs and summaries — a separate population, not counted as findings"
              className="hit block w-full text-left text-meta text-ui-faint hover:text-ui-mute focus:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
            >
              + {ml.summaries.toLocaleString()} walkthrough/summary
            </button>
          ) : (
            <div className="text-meta text-ui-faint">
              + {ml.summaries.toLocaleString()} walkthrough/summary
            </div>
          )}
        </div>
        <Tile
          openLabel="Show the major and critical findings behind this share"
          onClick={open({ kind: 'severity', severities: ['major', 'critical'] })}
        >
          <div className="text-meta text-ui-faint">High severity</div>
          <div
            className="text-title font-semibold tabular-nums"
            style={{ color: ML_SEVERITY_META.major.color }}
          >
            {Math.round(highShare * 100)}%
          </div>
          <div className="text-meta text-ui-faint">
            {highFindings.toLocaleString()} major or critical
          </div>
        </Tile>
        <Tile
          openLabel="Show the findings scored as nits"
          onClick={open({ kind: 'severity', severities: ['nit'] })}
        >
          <div className="text-meta text-ui-faint">Nits</div>
          <div
            className="text-title font-semibold tabular-nums"
            style={{ color: ML_SEVERITY_META.nit.color }}
          >
            {Math.round(nitShare * 100)}%
          </div>
          <div className="text-meta text-ui-faint">
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
          <div className="text-meta text-ui-faint">Top topic</div>
          <div className="truncate text-title font-semibold">
            {topCategory ? (ML_CATEGORY_LABEL[topCategory.category] ?? topCategory.category) : '—'}
          </div>
          <div className="text-meta text-ui-faint">
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
          <div className="text-meta text-ui-faint">
            Same-line overlap
          </div>
          <div className="text-title font-semibold tabular-nums">
            {overlapClusters.toLocaleString()}
          </div>
          <div className="text-meta text-ui-faint">
            line area{overlapClusters === 1 ? '' : 's'} flagged by &gt;1 bot · window
          </div>
        </Tile>
      </div>

      {/* Top-category chips (rehomed from the old per-bot table's column) + the severity legend,
          which doubles as the vocabulary key for the per-bot mix bars below. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-ui-faint">
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
              className="hit rounded-ui bg-ui-raise px-1 py-0.5 font-medium text-ui-mute hover:bg-ui-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ui-accent"
            >
              {ML_CATEGORY_LABEL[c.category] ?? c.category} {c.count}
            </button>
          ) : (
            <span
              key={c.category}
              className="rounded-ui bg-ui-raise px-1 py-0.5 font-medium text-ui-mute"
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
 * A bot re-roled to `quality_check` drops out of `vendors`; Bots Monitoring → Classification also lists
 * it under "Other automation", so the re-role stays visible from where it was made.
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
    <details className="rounded-ui bg-ui-surface">
      <summary className="cursor-pointer select-none rounded-ui px-3 py-2 text-body text-ui-mute hover:text-ui-ink touch:py-3">
        Quality checks ({rows.length}){' '}
        <span className="font-normal normal-case tracking-normal text-ui-faint">
          — excluded from ROI
        </span>
      </summary>
      <div className="px-3 py-2">
        {/* The InfoButton sits in the BODY, not the <summary>: a button inside a summary toggles
            the disclosure in some browsers as well as opening the modal. */}
        <div className="mb-2 flex items-center gap-1.5 text-meta text-ui-mute">
          <span>
            Belongs in the ROI table? Change its role in{' '}
            <span className="font-medium">Settings</span>.
          </span>
          <InfoButton title="Why quality checks are left out">
            <p>
              Coverage and quality gates (SonarQube, Codecov and similar) post reports, not code
              review. Nobody is expected to answer a coverage report, so an unanswered one is normal.
            </p>
            <p>
              Their threads and comments are left out of the totals, verdicts and charts above. They
              are listed here so you can see they are still running and spot one with the wrong role.
            </p>
          </InfoButton>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] border-collapse text-meta">
            <thead>
              <tr className="text-left text-ui-mute">
                <th className="py-1 pr-3 font-medium">Check</th>
                <th className="py-1 pr-3 text-right font-medium">Threads</th>
                <th className="py-1 pr-3 text-right font-medium">Comments</th>
                <th className="py-1 text-right font-medium">Last active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.key} className="">
                  <td className="py-1 pr-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: botColor({ login: v.login, kind: v.kind }) }}
                      />
                      <span className="text-ui-ink">{v.label}</span>
                      {/* A dormant gate is the interesting case here: it usually means the
                          integration broke, not that the bot got quieter. */}
                      {v.dormant && (
                        <span className="rounded-ui bg-ui-raise px-1 py-px text-meta text-ui-mute">
                          dormant
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">{v.threads}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{v.comments}</td>
                  <td className="py-1 text-right text-ui-mute">
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

// One "Comments/PR" cell — the ROI table's bot-comment VOLUME column.
//
// ⚠ THE FIGURE IS `avgCommentsPerCommentedPr`: comments ÷ the merged PRs THIS BOT COMMENTED ON.
// The sibling `avgCommentsPerScopePr` divides by every merged PR in scope and, on a repo where
// most PRs draw nothing, reads ~6× lower for the same bot. Neither is named `avgCommentsPerPr` on
// the wire precisely because a reader cannot tell them apart from the number — so the header names
// the denominator and this tooltip carries the other figure beside it.
//
// ⚠ THE LOADING STATE IS REAL. `volume` is its own query (a whole-window merged-PR scan on the
// `search` rate tier), so it settles later than the analytics response that drew the row. A "0"
// in the meantime is a claim this bot says nothing, which then silently becomes 12.
//
// ⚠ AND IT COVERS THE *STALE* CASE, NOT JUST THE FIRST LOAD — `loading` is
// `isLoading || isPlaceholderData`, and the guard below is `if (loading)`, NOT `if (loading &&
// !bot)`. `useBotVolume` keeps the previous response through a key change (`placeholderData`),
// so on a window or repo-scope switch this query still holds the OLD scope's numbers while the
// analytics query — which has no placeholder, so the panel skeletons and then repaints — has
// already come back with the NEW ones. A `!bot` guard is satisfied by that stale row, so the
// cell would quietly print the previous window's average beside the new window's thread columns:
// the same failure as the 0-that-becomes-12, only far harder to spot because the wrong number is
// plausible.
function VolumeCell({
  bot,
  loading,
  mergedPrs,
  onOpen,
}: {
  bot: BotVolumeBot | undefined;
  /** True while the figure on hand does not describe the CURRENT (workspace, window, repo)
   *  triple — first load AND the placeholder-carried gap after a scope/window change. */
  loading: boolean;
  /** Merged-in-window PRs in scope — the OTHER denominator, quoted in the tooltip. */
  mergedPrs: number;
  onOpen: ((b: { userId: number; label: string }) => void) | null;
}): JSX.Element {
  if (loading) {
    return (
      <span
        className="inline-block h-3 w-8 animate-pulse rounded-ui bg-ui-raise align-middle"
        title="Counting the bot comments on this window’s merged PRs…"
      />
    );
  }
  if (!bot) {
    return (
      <span
        className="text-ui-mute"
        title="This bot commented on nothing that merged inside the window. (The thread columns can still be non-zero — they count threads OPENED in the window, on PRs that may not have merged yet.)"
      >
        —
      </span>
    );
  }
  const label = formatAvg(bot.avgCommentsPerCommentedPr);
  const detail =
    `${bot.comments.toLocaleString()} comment${bot.comments === 1 ? '' : 's'} across ` +
    `${bot.prsCommentedOn.toLocaleString()} of the ${mergedPrs.toLocaleString()} PRs merged in this window ` +
    `(most on one PR: ${bot.maxCommentsOnOnePr.toLocaleString()}). ` +
    `Averaged over EVERY merged PR in scope instead — counting the ones it ignored — it is ` +
    `${formatAvg(bot.avgCommentsPerScopePr)}.`;
  if (!onOpen) return <span title={detail}>{label}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen({ userId: bot.authorUserId, label: bot.label })}
      // No aria-label — it would displace the number as the accessible name (the `Tile` rule).
      title={`${detail} Click for the PRs behind it.`}
      className="hit rounded-ui px-1 underline decoration-dotted underline-offset-2 hover:bg-ui-hover hover:text-ui-ink"
    >
      {label}
    </button>
  );
}

// The ONE place a vendor row's `u<userId>` key is parsed back to its users.id (the "Depth →"
// pill's target). `BotVendorAnalytics` carries no userId field; its `key` is `u<id>` for real
// reviewer rows and 'pierre' for Limn's own attribution row — the latter (or any future
// non-user key) yields null, and the pill simply doesn't render for it. Kept as a single
// exported-nowhere helper so a second spelling of the format cannot creep in.
function vendorKeyUserId(key: string): number | null {
  const m = /^u(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

// ── The Inflation column (plan P1.2/C2) ───────────────────────────────────────────────────────
// The severity-inflation index, folded into the ROI table: how often this bot's OWN badge
// contradicted our label, over the same window as every other cell. The counts are the verdict;
// the weekly sparkline beside them is the history.
//
// `weekly` keeps its own absent/present flag because it is an extra scan WIDTH in the getter, not
// just a field to drop.
//
// ⚠ THIS IS NO LONGER THE ONLY INFLATION SURFACE, AND THE OLD "it replaced the two workspace-grain
// inflation ChartCards" LINE IS RETIRED WITH THAT CLAIM. Plan P1.2/C2 cut two WORKSPACE-grain
// inflation ChartCards from `WorkspaceBotCharts`, and nothing has returned there — that surface is
// fed by `/api/pro/bot-behaviour`, whose weekly points carry severity and category only. What came
// back is an enlargement of THIS cell's sparkline, in THIS panel's chart row, off THIS response's
// `mlInflation.weekly`: `InflationHistoryChart`. The cell stays the numbers and the click-through;
// the card is the same two series at a size that can carry a key, an axis and a hover. Deleting
// one because the other exists would remove either the drill-down or the readable history.
//
// ⚠ COUNTS, NEVER SHARES — and the counts partition the bot's BADGED findings, never its scored
// ones. A bot that badges nothing renders a DASH with the "no badge is silence, not agreement"
// tooltip, NEVER a zero: it has no over-calls because it makes no calls, and a 0 would read
// "never inflates". (Within a badged bot a 0 IS real — "made calls, never that way".)
//
// ⚠ Each count opens the flagging drill-down seeded with THIS bot + direction — the exact opener
// the removed charts used (`openBotFlaggingDetail({kind:'findings'}, repoId, {bots, disagree})`,
// the `|bot:<id>|` refineQueryKey slot) — so the number clicked IS the list's `filteredTotal`:
// both are the same `vendorAgreementOf` fold of the same windowed scan, server-side.

// The tiny sparkline: the two weekly disagreement series in the two directions' fixed colours
// (amber = the bot called it worse, violet = we did — the removed charts' palette). Decorative
// trend context only, so it is aria-hidden; the counts beside it carry the numbers.
//
// It stays decorative BECAUSE it now has a readable twin: `InflationHistoryChart`, in this panel's
// chart row, draws the same `mlInflation.weekly` for every charted bot with a key, an axis and a
// hover. Anything a reader has to be able to READ off inflation history belongs there — do not
// grow this one a legend or a tooltip, it is 52×14 and lives inside a table cell.
function InflationSparkline({ weekly }: { weekly: BotInflationWeekPoint[] }): JSX.Element | null {
  const W = 52;
  const H = 14;
  if (weekly.length < 2) return null;
  const max = Math.max(1, ...weekly.map((w) => Math.max(w.overCall, w.underCall)));
  const pts = (v: (w: BotInflationWeekPoint) => number): string =>
    weekly
      .map((w, i) => {
        const x = (i / (weekly.length - 1)) * (W - 2) + 1;
        const y = H - 1 - (v(w) / max) * (H - 3);
        return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
      })
      .join(' ');
  return (
    <svg width={W} height={H} className="ml-1 inline-block align-middle" aria-hidden="true">
      <polyline points={pts((w) => w.overCall)} fill="none" stroke={PALETTE.amber} strokeWidth={1.25} />
      <polyline points={pts((w) => w.underCall)} fill="none" stroke={PALETTE.violet} strokeWidth={1.25} />
    </svg>
  );
}

function InflationCell({
  vendor,
  onOpen,
}: {
  vendor: CostedVendor;
  // Opens the flagging drill-down on this bot + direction; null ⇒ the counts stay plain text
  // (the `TileShell` rule: a cell becomes clickable only when someone is there to route the click).
  onOpen: ((direction: 'over' | 'under', bots: BotFlaggingBotNarrowing) => void) | null;
}): JSX.Element {
  const inf = vendor.mlInflation;
  const userId = vendorKeyUserId(vendor.key);
  if (inf == null || inf.badged === 0) {
    // Omitted-and-named, never a zero — no badge is silence, not agreement.
    return (
      <span
        className="text-ui-mute"
        title="badges nothing — no badge is silence, not agreement"
      >
        —
      </span>
    );
  }
  const canOpen = onOpen != null && userId != null;
  const count = (direction: 'over' | 'under'): JSX.Element => {
    const n = direction === 'over' ? inf.overCall : inf.underCall;
    const label = (
      <>
        <ArrowIcon
          dir={direction === 'over' ? 'up' : 'down'}
          size={10}
          className="inline-block align-[-0.1em]"
        />
        {n}
      </>
    );
    const title =
      direction === 'over'
        ? `${n} of ${inf.badged} badged findings the bot graded WORSE than our model did (inflation).${canOpen ? ' Click for the comments behind it.' : ''}`
        : `${n} of ${inf.badged} badged findings our model graded worse than the bot's own badge — what a nit-filter set to the bot's grades would drop.${canOpen ? ' Click for the comments behind it.' : ''}`;
    const color = direction === 'over' ? PALETTE.amber : PALETTE.violet;
    if (!canOpen) {
      return (
        <span title={title} style={n > 0 ? { color } : undefined} className={n > 0 ? '' : 'text-ui-faint'}>
          {label}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => onOpen(direction, { userIds: [userId], label: vendor.label })}
        title={title}
        style={n > 0 ? { color } : undefined}
        className={`rounded-ui px-0.5 underline decoration-dotted underline-offset-2 hover:bg-ui-hover ${n > 0 ? '' : 'text-ui-faint'}`}
      >
        {label}
      </button>
    );
  };
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {count('over')}
      {count('under')}
      {inf.weekly != null && <InflationSparkline weekly={inf.weekly} />}
    </span>
  );
}

function VendorTable({
  vendors,
  botColor,
  onOpenVendor,
  overdueGraceMs,
  showMl,
  showCost,
  volume,
  volumeLoading,
  onOpenVolume,
  onOpenInflation,
  onOpenDepth,
}: {
  vendors: CostedVendor[];
  botColor: BotColor;
  onOpenVendor: (key: string) => void;
  overdueGraceMs: number;
  // The bot-comment VOLUME response backing the "Comments/PR" column — a SEPARATE query from the
  // analytics one, measured at the same (workspace, window, repoIds) triple.
  //
  // ⚠ IT IS A DIFFERENT POPULATION FROM EVERY OTHER COLUMN HERE, and the header says so: these
  // are PRs **MERGED** in the window, whereas the thread columns count threads opened in it. The
  // two are not derivable from each other and must never be captioned with each other's total.
  volume: BotVolumeResponse | undefined;
  // True while the volume query has nothing to show yet. The cell renders a placeholder, NEVER a
  // zero — a "0" that becomes "12" a moment later is a worse answer than an obvious pending state.
  volumeLoading: boolean;
  // Opens the merged-PR drill-down narrowed to this bot. null ⇒ the cell stays plain text (the
  // `TileShell` rule: a cell becomes clickable only when someone is there to route the click).
  onOpenVolume: ((bot: { userId: number; label: string }) => void) | null;
  // Opens the per-bot DEPTH drill-down tab (plan P1.1/C1) — its own small cell/pill, because the
  // row's existing click targets keep their jobs (the vendor chip opens the comments/PRs
  // drill-down; the Comments/PR cell opens the volume list). null renders NO depth chrome at all.
  onOpenDepth:
    | ((bot: { userId: number; label: string; login: string | null; kind: AutomatedReviewerKind }) => void)
    | null;
  // The ML severity columns (mix bar / High / Nits / the four "not addressed by severity"
  // columns, plus Inflation) — rendered ONLY when the deployment scores (MeResponse.mlSeverity)
  // AND the window has labels. False must render NO ml chrome at all.
  showMl: boolean;
  // The Inflation column's click-through: opens the flagging drill-down seeded with the clicked
  // bot + direction (the exact opener the removed workspace inflation charts used). null ⇒ the
  // counts render as plain text.
  onOpenInflation: ((direction: 'over' | 'under', bots: BotFlaggingBotNarrowing) => void) | null;
  // The $/acted-on cost column — false renders NO cost chrome at all (header AND cell).
  //
  // ⚠ THIS IS A GRAIN GATE. The caller passes `repoId == null`: measured over the whole Workspace. The
  // numerator is a monthly WORKSPACE price and the denominator is the acted-on threads in
  // whatever scope this table was measured at, so the two halves only describe one population on
  // the un-narrowed mount — every per-repo Bots tab hits false.
  //
  // Nothing in here may reintroduce a cost figure behind a caveat: the caveat was tried and the
  // grain moved instead.
  showCost: boolean;
}): JSX.Element {
  // ⚠ THE HEADER IS TWO ROWS WHEN `showMl`, ONE WHEN NOT — because the four "not addressed by
  // severity" columns sit under a shared group cell, and a group cell only makes sense with a
  // second row beneath it. Every OTHER header cell therefore has to span both rows, or the four
  // sub-headers shove the ordinary columns out of alignment with their own data. Add a column
  // here and it needs `rowSpan={headSpan}` too.
  const headSpan = showMl ? 2 : 1;
  // ⚠ A BOT WITH NO COMMENTS IN THE WINDOW IS ABSENT FROM THE VOLUME RESPONSE (it has no trend to
  // keep such a row meaningful, unlike this table's dormant rows) — so a miss means "said nothing
  // on anything merged here" and renders a DASH, never a 0.
  const volumeByBot = useMemo(() => volumeByKey(volume?.bots), [volume?.bots]);
  const mergedPrs = volume?.totals.prs ?? 0;
  return (
    // Its own scroll box with the Bot column sticky, so the wide table never widens the page.
    <div className={TABLE_SCROLL} data-testid="bot-roi-table">
      <table
        className={`${TABLE} text-meta ${showMl ? 'min-w-[1560px]' : 'min-w-[1080px]'}`}
      >
        <thead>
          <tr className={`text-left text-ui-mute${showMl ? '' : ' '}`}>
            <th rowSpan={headSpan} className={`${STICKY_COL} px-2 py-1.5 font-medium`}>Bot</th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium">Threads</th>
            {/* ⚠ THIS COLUMN AND THE ONE BESIDE IT ARE NOT A NUMERATOR AND A RATIO, and their
                adjacency invites exactly that reading. They disagree on BOTH axes:
                  • KIND — this counts `review_comments` ONLY; "Comments/PR" also counts PR
                    comments and review bodies.
                  • POPULATION — this counts comments by their OWN createdAt on PRs in ANY state;
                    "Comments/PR" is over PRs MERGED inside the window.
                So `Comments ÷ Threads` is not this bot's comments-per-PR, and `Comments/PR ×
                anything` does not reconstruct this number. Both tooltips say which basis they
                use, because the figures alone cannot. */}
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="Inline review comments this bot left in the window, counted by the comment's own date, across PRs in any state (open, merged or closed). Deliberately NOT the numerator of Comments/PR — that column also counts PR comments and review bodies, and only over PRs merged inside the window."
            >
              Comments
            </th>
            {/* ⚠ `rowSpan={headSpan}` LIKE EVERY OTHER NON-ML HEADER CELL. When `showMl` the header
                is TWO rows (the four "not addressed by severity" columns sit under a group cell),
                and a new column without the span shoves every ordinary column out of alignment
                with its own data.
                ⚠ THE TOOLTIP STATES THE DENOMINATOR IN WORDS, and that is not padding: the same
                bot's "per PR it commented on" and "per merged PR in scope" differ by ~6× on a
                quiet repo (measured: 656 of mrdoob/three.js's 796 merged PRs drew NO bot comment
                at all), and the number alone cannot tell a reader which one it is. The cell's own
                tooltip carries the other figure so the gap is visible rather than implied. */}
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="How much this bot says when it shows up: its comments averaged over the PRs IT COMMENTED ON — not over every PR. Counts inline review comments, PR comments and review bodies, on PRs MERGED inside the window (open PRs are excluded, unlike the thread columns to the left). Click a figure for the PRs behind it."
            >
              Comments/PR
            </th>
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="Threads the team used: a later commit likely addressed the thread, it was resolved, or a person replied after the bot"
            >
              Used
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="Threads with no reply and no follow-up commit — the total not-addressed">
              Not addressed
            </th>
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title={`Not-addressed threads older than the ${Math.round(
                overdueGraceMs / 3_600_000,
              )}h grace window — the genuinely-ignored ones that drive 'Rarely used' verdict`}
            >
              Unanswered after {Math.round(overdueGraceMs / 3_600_000)}h
            </th>
            <th
              rowSpan={headSpan}
              className="px-2 py-1.5 text-right font-medium"
              title="PRs merged inside the window that still carried at least one not-addressed thread by this bot at merge — the team's final answer was to ship anyway. The threads themselves may be older than the window."
            >
              Merged anyway
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="This bot's median time from opening a thread to it being addressed — a human reply, a resolve, or an addressing commit">
              Time to address
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="How long the oldest not-addressed thread has been waiting">
              Oldest not addressed
            </th>
            <th rowSpan={headSpan} className="px-2 py-1.5 text-right font-medium" title="Not-addressed threads as a share of all this bot's threads">
              % not addressed
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
                  className="px-2 pb-0 pt-1.5 text-center font-medium"
                  title="This bot's not-addressed threads, split by the predicted severity of the finding that opened each one. Model-scored and advisory: threads whose opening comment was never scored aren't counted, so these need not add up to the Not addressed column."
                >
                  Not addressed by severity
                </th>
                {/* The Inflation column (plan P1.2/C2) — the workspace inflation charts' verdict,
                    folded into the row. `rowSpan={headSpan}` like every other non-group ML cell. */}
                <th
                  rowSpan={headSpan}
                  className="px-2 py-1.5 text-right font-medium"
                  title="How often this bot's OWN severity badge contradicted our label, over its badged findings in the window: the up-arrow count = the bot graded a finding worse than we did (inflation), the down-arrow count = we graded it worse than the bot (what a nit-filter on its own grades would drop). Counts, never shares. A bot that badges nothing shows a dash — no badge is silence, not agreement. Click a count for the comments behind it."
                >
                  Inflation
                </th>
              </>
            )}
            {showCost && (
              <th
                rowSpan={headSpan}
                className="px-2 py-1.5 text-right font-medium"
                // ⚠ THE OLD "narrowed to a single repo…" CAVEAT IS GONE BECAUSE THE STATE IS.
                // This column no longer renders on the per-repo mount at all (`showCost` is
                // `repoId == null`), so both halves of the figure now describe the
                // same population — the whole Workspace — and a caveat about a case that cannot
                // occur would only teach the reader to distrust a number that is exact. The
                // cross-workspace warning stays: prices are per Workspace and are never summed.
                // ⚠ THE FRACTION'S TWO ENDS ARE ON ONE TIME BASE, AND THE TITLE SAYS SO. This
                // divided the monthly price by the raw in-window count until the benchmark rollup
                // landed one tab away with its own $/acted-on: $2.23 here against $21.24 there,
                // same bot, same price. The count is now annualised over the selected window, so
                // the two figures differ only by the stretch each was measured over — which both
                // surfaces state. Benchmark measures the reviewer's whole observed span; this
                // measures the window in the picker, so a bot busier lately reads cheaper here.
                title="Monthly cost ÷ used threads a month, both over this whole Workspace — the used count is scaled from the selected window to a month, so the price and the work are on the same time base. Bots Monitoring → Benchmark measures the same fraction over each reviewer's whole observed span instead, so the two answer different questions and need not match. The price is this bot's price FOR THIS WORKSPACE — set it on the bot's card in Bots Monitoring → Classification. Another Workspace may hold a different figure for the same bot; the two are never added together."
              >
                $ per used thread
              </th>
            )}
            <th rowSpan={headSpan} className="px-2 py-1.5 text-center font-medium">Verdict</th>
            {onOpenDepth != null && (
              <th
                rowSpan={headSpan}
                className="px-2 py-1.5 text-center font-medium"
                title="Open this bot's depth tab — its latency, cadence, coverage and consistency charts, plus its severity-over-time and category mix"
              >
                Depth
              </th>
            )}
          </tr>
          {showMl && (
            <tr className="text-left text-ui-mute">
              {SEVERITY_COLUMNS.map((s, i) => (
                <th
                  key={s}
                  className={`px-1.5 pb-1.5 text-right text-meta font-medium${i === 0 ? ' ' : ''}`}
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
            const dash = <span className="text-ui-mute">—</span>;
            return (
              <tr
                key={v.key}
                className={`group ${TR_HOVER}`}
              >
                <td className={`${STICKY_COL} whitespace-nowrap px-2 py-1.5 group-hover:bg-ui-hover`}>
                  <button
                    type="button"
                    onClick={() => onOpenVendor(v.key)}
                    title="Open the bot drill-down — its comments (default) and the PRs it touched"
                    className="hit inline-flex cursor-pointer items-center gap-1 rounded-ui px-1.5 py-0.5 font-medium hover:underline"
                    style={{ ...vendorInk(color), background: `${color}1a` }}
                  >
                    <BotIcon size={11} />
                    {v.label}
                  </button>
                  {v.reviewers > 1 && (
                    <span className="ml-1 text-ui-faint">×{v.reviewers}</span>
                  )}
                  {v.dormant && (
                    <span
                      className="ml-1.5 inline-block rounded-ui px-1 py-px text-meta text-ui-mute bg-ui-surface"
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
                <td className="px-2 py-1.5 text-right tabular-nums text-ui-mute">
                  {v.dormant ? dash : v.comments}
                </td>
                {/* Comments per merged PR. NOT dashed on `dormant`: dormancy is judged on the
                    THREAD columns' window, while this one counts comments on PRs merged in it —
                    a bot that opened no new threads can still have commented on what shipped.
                    Three states, deliberately distinguishable:
                      • loading  → a pulse, never a 0 that turns into 12 a moment later;
                      • no row   → a dash ("said nothing on anything merged here");
                      • a figure → a button into the PRs it was folded from. */}
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <VolumeCell
                    bot={volumeByBot.get(v.key)}
                    loading={volumeLoading}
                    mergedPrs={mergedPrs}
                    onOpen={onOpenVolume}
                  />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {v.dormant ? (
                    dash
                  ) : (
                    <>
                      <span className="text-ui-ink">{v.actedOn}</span>
                      <span className="ml-1 text-ui-faint">{pct(v.actedOnPct)}</span>
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {v.dormant ? (
                    dash
                  ) : (
                    <span
                      className={
                        v.untouched > 0 ? 'text-ui-ink' : 'text-ui-faint'
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
                        v.overdueUntouched > 0 ? 'text-ui-ink' : 'text-ui-faint'
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
                        v.mergedPastPrs > 0 ? 'text-ui-ink' : 'text-ui-faint'
                      }
                    >
                      {v.mergedPastPrs}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ui-mute">
                  {v.dormant ? dash : dur(v.medianAddressedMs)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ui-mute">
                  {v.oldestUntouchedDays != null ? `${v.oldestUntouchedDays}d` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ui-mute">
                  {v.dormant ? dash : pct(v.noiseRatioPct)}
                </td>
                {/* Same-line overlap — advisory. `?? null` guards a stale cached response that
                    predates the field (the column then reads as blank, never NaN). */}
                <td
                  className="px-2 py-1.5 text-right tabular-nums text-ui-mute"
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
                      className="px-2 py-1.5 text-right font-medium tabular-nums text-ui-ink"
                    >
                      {v.mlHighPct != null ? `${v.mlHighPct}%` : dash}
                    </td>
                    <td
                      className="px-2 py-1.5 text-right tabular-nums text-ui-mute"
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
                          className={`px-1.5 py-1.5 text-right tabular-nums${i === 0 ? ' ' : ''}`}
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
                    {/* Inflation — counts + sparkline. NOT dashed on dormant: like the ML
                        cells above, its window population is labels, not threads, and the cell
                        carries its own dash rule (badges nothing ⇒ dash, never zero). */}
                    <td className="px-2 py-1.5 text-right">
                      <InflationCell vendor={v} onOpen={onOpenInflation} />
                    </td>
                  </>
                )}
                {/* The $/acted-on figure. The price is a plain column on this bot's WORKSPACE row
                    — one row per actor here, so nothing is inherited, shared or split, and the
                    tooltip names the workspace rather than an account-wide subscription. The
                    predecessor's per-team column needed an "inh" marker to stop three teams
                    inheriting one $120 tool reading as $360; there is no inheritance left to
                    label, only the rule that a figure from THIS workspace is not a figure about
                    another one. */}
                {showCost && (
                <td
                  className="px-2 py-1.5 text-right tabular-nums text-ui-mute"
                  // Money is printed through the same formatter as the cost box in Bots →
                  // Settings, so "45.50" there can't read back as "45.5" here.
                  title={
                    v.costMonthlyUsd == null
                      ? v.legacyOnlyUsd != null
                        ? // An UNAPPLIED pointer, never a price. The old account-wide list still
                          // holds $X for this login, but nothing reads it any more — including
                          // when the user deliberately CLEARED the price, which is indistinguishable
                          // from "never migrated" on this row. So it is offered, not charged.
                          `No price set for this bot in this Workspace. The old account-wide list still has $${formatCostInput(v.legacyOnlyUsd)}/mo for it — re-enter it in Bots Monitoring → Classification to use it.`
                        : 'No price set for this bot in this Workspace — set one in Bots Monitoring → Classification.'
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
                )}
                <td className="px-2 py-1.5 text-center">
                  {v.dormant ? (
                    dash
                  ) : (
                    <span
                      className={`inline-block rounded-ui px-1.5 py-0.5 text-meta font-semibold ${verdict.className}`}
                      title={verdict.title}
                    >
                      {verdict.label}
                    </span>
                  )}
                </td>
                {onOpenDepth != null && (
                  <td className="px-2 py-1.5 text-center">
                    {(() => {
                      // The 'pierre' attribution row (and any future non-user key) has no
                      // users.id to key a depth tab on — a dash, never a dead pill.
                      const depthUserId = vendorKeyUserId(v.key);
                      return depthUserId == null ? (
                        dash
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            onOpenDepth({
                              userId: depthUserId,
                              label: v.label,
                              login: v.login,
                              kind: v.kind,
                            })
                          }
                          title="Open this bot's depth tab — latency, cadence, coverage and consistency, plus its severity-over-time and category mix"
                          className="whitespace-nowrap rounded-ui px-1.5 py-0.5 text-meta font-medium text-ui-accent hover:bg-ui-hover touch:py-2"
                        >
                          Depth →
                        </button>
                      );
                    })()}
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
    <Callout
      tone="info"
      icon={<ResolveIcon />}
      onClick={() => openBotThreadsDetail(repoIds?.[0] ?? null)}
      testId="resolve-backlog-caption"
      title="Review & resolve the likely-addressed bot threads"
      action="Show list →"
    >
      <span className="font-semibold tabular-nums">{totalThreads}</span> likely-addressed bot
      thread{totalThreads === 1 ? '' : 's'} look resolved by later commits — review before
      resolving on GitHub.
    </Callout>
  );
}

// Scope = the ACTIVE WORKSPACE. `repoId` additionally narrows the DATA to ONE repo (the per-repo
// Bots tab): the analytics and the vendor drill-down measure that repo alone, and only bots with
// activity in it surface. It does NOT change the judgement — who counts as a bot is the
// workspace's answer either way.
//
export function BotRoiPanel({ repoId }: { repoId?: number } = {}): JSX.Element | null {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const openBotPrsDetail = useFilters((s) => s.openBotPrsDetail);
  const openBotOnlyDetail = useFilters((s) => s.openBotOnlyDetail);
  // The "what the bots are flagging" tiles/chips → the flagging drill-down tab.
  const openBotFlaggingDetail = useFilters((s) => s.openBotFlaggingDetail);
  // ⚠ MONEY IS WORKSPACE-GRAINED, SO IT RENDERS ONLY ON THE WORKSPACE-GRAINED MOUNT.
  // `costPerActedOnUsd` is this bot's whole MONTHLY WORKSPACE price divided by the acted-on
  // threads in the measured scope. On the bare rail mount both halves describe the same
  // population and the figure is exact. With `repoId` set, the denominator shrinks to ONE
  // repository's work while the numerator stays the whole subscription — an UPPER BOUND that
  // reads as spend, cannot be added up across the repos of one workspace without counting the
  // same subscription n times, and is wrong in the flattering-to-nobody direction (it inflates
  // the apparent cost of every bot on every repo tab). The server figure is unchanged and still
  // correct for the rail; it is the per-repo VIEW that had no honest way to show it.
  //
  // This is the same grain move the Bots → Benchmark rollup makes: money lives at the workspace
  // grain or it does not ship. A reader who wants the exact figure has it one rail up.
  //
  const showCost = repoId == null;
  // The workspace decides the VERDICT; `repoIds` only narrows the measured data. Both occupy
  // their own query-key slot, so either change refetches and two workspaces can never share a
  // cache entry.

  const workspaceId = useFilters((s) => s.workspaceId);
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const { data, isLoading, isError } = useBotAnalytics(workspaceId, window, true, repoScope);
  // ⚠ THE VOLUME QUERY TAKES THE SAME TRIPLE, AND SO DOES THE DRILL-DOWN IT OPENS — workspace,
  // window, repo narrowing. The column reproduces the drill-down's own numbers (both fold ONE
  // server-side scan), so measuring them at different scopes would leave the list quietly
  // contradicting the cell that was clicked, with nothing on screen saying why. This is the same
  // failure the MlTotalsStrip's `onOpen` note describes, and the reason the window lives in the
  // shared store field rather than in either tab's local state.
  //
  // ⚠ `isPlaceholderData` IS PART OF "LOADING" HERE. This query carries its previous response
  // across a key change (`placeholderData: prev => prev`) while `useBotAnalytics` does NOT — so
  // after a window or repo-scope switch the analytics half skeletons, comes back new, and repaints
  // the table while this half is still serving the OLD scope's numbers with `isLoading === false`.
  // Without this term the column would print the previous window's average beside the new
  // window's thread columns, silently.
  const {
    data: volume,
    isLoading: volumeFetching,
    isPlaceholderData: volumeStale,
  } = useBotVolume(workspaceId, window, true, repoScope);
  const volumeLoading = volumeFetching || volumeStale;
  const openBotVolumeDetail = useFilters((s) => s.openBotVolumeDetail);
  // The per-bot DEPTH drill-down tab (plan P1.1/C1) — keyed on the bot's users.id, with the
  // label metadata (and this table's repo narrowing) captured at open time.
  const openBotDetailTab = usePinnedTabs((s) => s.openBotDetailTab);
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
  // a row the server resolved to null — never to fill that null (see `resolveVendorCost`).
  const { data: settings } = useProSettings(true);

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
  // in Bots Monitoring → Classification makes it silently VANISH from the only screen that lists review bots —
  // indistinguishable from "we stopped detecting it", and there is no way to notice a MIS-role.
  // Volume only: no verdict, no noise ratio, no $/acted-on, because those are the ROI judgements
  // that were deliberately withheld.
  const qualityChecks = data?.qualityChecks ?? [];

  // The panel's one explanation. The grace figure is the server's constant (`overdueGraceMs`), read
  // off the response rather than retyped; it is absent only before the first response lands.
  const graceHours =
    data?.totals.overdueGraceMs != null ? Math.round(data.totals.overdueGraceMs / 3_600_000) : null;
  const roiInfo = (
    <>
      <p>
        <span className="font-semibold">Used</span>: a thread counts as used if it was resolved, a
        person replied after the bot’s last comment, or a later commit touched the file it is on.
        The commit test is a guess: the commit may have changed something else.
      </p>
      <p>
        <span className="font-semibold">Not addressed</span>: still unresolved, nobody replied and
        no later commit touched the file. “% not addressed” is that share of the bot’s threads.
      </p>
      <p>
        A not-addressed thread counts as <span className="font-semibold">unanswered</span> only once
        it is older than {graceHours != null ? `${graceHours} hours` : 'a fixed grace period'}, so a
        bot is not marked down for threads nobody has reached yet.
      </p>
      <p className="font-semibold">Verdicts</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <span className="font-semibold">Rarely used</span>: at least 10 threads, under 30% used,
          and at least half unanswered.
        </li>
        <li>
          <span className="font-semibold">Tune</span>: at least 5 threads and under 60% used, or at
          least 20 scored findings of which 70% or more are nits.
        </li>
        <li>
          <span className="font-semibold">Keep</span>: everything else.
        </li>
      </ul>
      <p>
        <span className="font-semibold">$ per used thread</span>: the bot’s monthly price divided
        by the used threads it produces in a month at this window’s rate. A price is set per
        Workspace, so another Workspace can hold a different price for the same bot, and the two
        are never added together. It is shown only on the Bots rail: one repository’s share of a
        Workspace-wide price is not a real cost.
      </p>
      <p>
        <span className="font-semibold">Turning it off would save</span>: shown under the table for
        a priced bot marked Rarely used (at least {RARELY_USED_MIN_THREADS} threads, under{' '}
        {RARELY_USED_MAX_PCT}% used). The yearly figure is the monthly price times 12.
      </p>
    </>
  );

  const header = (
    // The "Review-bot ROI" heading was dropped (the rail line already has a header); just the
    // window/date-range picker remains, right-aligned.
    //
    // The window picker writes the SHARED `botAnalyticsWindow` field that BotsView's caution and
    // the hoisted tuning suggestions also read; neither makes a window CLAIM in its copy.
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-meta text-ui-mute">
        How this is measured
        <InfoButton title="How Bot ROI is measured">{roiInfo}</InfoButton>
      </span>
      <div className="ml-auto">
        <Segmented
          label="Window"
          value={window}
          onChange={setWindow}
          options={WINDOWS.map((w) => ({ value: w.key, label: w.label }))}
        />
      </div>
    </div>
  );

  let body: JSX.Element;
  if (isLoading) {
    body = (
      <div className="h-28 animate-pulse rounded-ui bg-ui-surface" />
    );
  } else if (isError) {
    body = <div className="text-body text-ui-danger">Couldn’t load bot analytics.</div>;
  } else if (!data || vendors.length === 0) {
    // LANDMINE: "no vendors" is NOT the same as "no bots". If every automated reviewer in scope
    // is roled `quality_check`, `vendors` is empty while `qualityChecks` is not — claiming "no
    // activity" there would be a lie, and would hide the only rows that exist. So the
    // quality-check section renders in the empty branch too, and the wording softens to name it.
    body = (
      <div className="space-y-3">
        <div className="rounded-ui p-6 text-center text-body text-ui-faint bg-ui-surface">
          No review-bot activity in this window.
          <div className="mt-1 text-meta">
            Try a wider window above.
            {qualityChecks.length > 0 && ' Quality checks are listed below.'}
          </div>
        </div>
        <QualityCheckSection rows={qualityChecks} botColor={botColor} />
      </div>
    );
  } else {
    const t = data.totals;
    // The picker's own word for the window every windowed figure on this panel was measured over.
    // Quoted by the inflation history card, whose span is a FIXED 12 weeks and therefore has to
    // name the other grain rather than let a reader assume the two agree. `rolling_90` is a valid
    // `BotWindowKind` with no button here (only the chat sets it), so the fallback is a word, not
    // a fabricated day count.
    const windowLabel = WINDOWS.find((wOpt) => wOpt.key === window)?.label ?? 'selected';
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
        <div className="text-meta text-ui-mute">
          <span className="font-semibold tabular-nums text-ui-ink">
            {t.threads}
          </span>{' '}
          bot thread{t.threads === 1 ? '' : 's'} · {t.comments} comment
          {t.comments === 1 ? '' : 's'} ·{' '}
          <span className="tabular-nums">{pct(t.actedOnPct)}</span> used ·{' '}
          <span className="tabular-nums text-ui-warn">
            {t.untouched}
          </span>{' '}
          not addressed
          {' · '}
          <span className="tabular-nums">
            counted unanswered after {Math.round(t.overdueGraceMs / 3_600_000)}h
          </span>
          {' · '}
          <button
            type="button"
            onClick={() => openBotOnlyDetail(repoId ?? null)}
            title="Show the OPEN PRs only a bot reviewed — no human review or comment since they opened"
            className="hit rounded-ui underline decoration-dotted underline-offset-2 hover:text-ui-ink"
          >
            <b className="tabular-nums text-ui-ink">{t.botOnlyPrs}</b>{' '}
            bot-only open PR{t.botOnlyPrs === 1 ? '' : 's'}
          </button>
        </div>
        <VendorTable
          vendors={vendors}
          botColor={botColor}
          onOpenVendor={(key) => openBotPrsDetail(key, repoId ?? null)}
          overdueGraceMs={t.overdueGraceMs}
          showMl={showMlColumns}
          showCost={showCost}
          volume={volume}
          volumeLoading={volumeLoading}
          // ⚠ THE SAME `repoId ?? null` THIRD LEG the flagging drill-down gets: on the per-repo
          // Bots tab the cell counts ONE repo, so the list must too. The bot narrowing is the
          // one-element SET shape shared with the flagging drill-down (`users.id`s, never vendor
          // key strings) — one narrowing convention on this surface, not two.
          onOpenVolume={(b) =>
            openBotVolumeDetail(repoId ?? null, { userIds: [b.userId], label: b.label })
          }
          // The Inflation column's click-through — the EXACT opener the removed workspace
          // inflation charts used: the flagging drill-down over `findings`, seeded with the
          // clicked bot's id + direction (the `|bot:<id>|` refineQueryKey slot), plus the same
          // `repoId ?? null` third leg as every other drill-down on this table. The workspace and
          // window ride the shared store fields the tab reads for itself, so the count clicked
          // and the list's `filteredTotal` are the same server-side fold of the same scan.
          onOpenInflation={(direction, bots) =>
            openBotFlaggingDetail({ kind: 'findings' }, repoId ?? null, {
              bots,
              disagree: direction,
            })
          }
          // "Depth →". The meta is the chip/header label + the repo narrowing THIS table was measured at,
          // so the tab describes the same scope as the row that was clicked.
          onOpenDepth={(b) => {
            const meta: TabBotMeta = {
              id: b.userId,
              login: b.login,
              label: b.label,
              kind: b.kind,
              repoId: repoId ?? null,
            };
            openBotDetailTab(b.userId, meta);
          }}
        />
        {/* "What you could stop paying" — one templated sentence per priced, rarely-used review
            bot (lib/botSavings.ts). Gated on `showCost`, the SAME predicate as the $ column:
            money lives at Workspace grain, so a repo-narrowed mount shows none. */}
        {(() => {
          const lines = vendors
            .map((v) => ({ key: v.key, text: stopPayingLine(v, window, showCost) }))
            .filter((l): l is { key: string; text: string } => l.text != null);
          if (lines.length === 0) return null;
          return (
            <div className="space-y-1" data-testid="bot-stop-paying">
              {lines.map((l) => (
                <p key={l.key} className="text-meta text-ui-ink">
                  {l.text}
                </p>
              ))}
            </div>
          );
        })()}
        {/* Bot-effectiveness charts (per vendor): raw weekly volume, the volume-independent
            effectiveness + verdict, and the acted-on vs untouched split — those three always
            visible. The fourth, severity inflation over time, is the only conditional one: it
            enlarges the table's Inflation sparkline and rides the same ML gate that column does. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ChartCard title="Thread volume" note="weekly · last 12">
            <VendorTrendChart vendors={vendors} value={threadsVal} botColor={botColor} />
          </ChartCard>
          <ChartCard title="Bot effectiveness" note="% of threads used · keep / tune / rarely used">
            <EffectivenessChart vendors={vendors} />
          </ChartCard>
          <ChartCard title="Used vs not addressed" note="threads, by bot · this window">
            <ActedVsUntouchedChart vendors={vendors} />
          </ChartCard>
          {/* The Inflation column's sparkline, enlarged — same response, same field
              (`mlInflation.weekly`), same two direction hues, plus the key/axis/hover a 52×14px
              cell-sized SVG has no room for. It sits in THIS row rather than in the "Workspace
              charts" section because that section is fed by `/api/pro/bot-behaviour`, which
              carries no weekly inflation at all; here it costs no request.

              ⚠ GATED ON `showMlColumns`, THE SAME FLAG AS THE COLUMN IT ENLARGES — a deployment
              with no scoring service, or a window with nothing scored, must show neither. It also
              spans the full row (`lg:col-span-3` on the card itself): the three cards beside it
              are one-metric-per-bot, this one is one PANEL per bot and would be unreadable in a
              third of the width. It returns null when there is no badged bot to chart and none to
              name, so no empty cell appears in the grid. */}
          {showMlColumns && (
            <InflationHistoryChart
              vendors={vendors}
              botColor={botColor}
              windowLabel={windowLabel}
            />
          )}
        </div>
        {/* `TuningSuggestions` USED TO SIT HERE and now renders in BotsView, above this panel.
            Do not re-add it — two mounts would draw it twice. */}
        <QualityCheckSection rows={qualityChecks} botColor={botColor} />
        {/* ⚠ THE PRICING INSTRUCTION IS GATED ON THE SAME PREDICATE AS THE COLUMN IT DESCRIBES.
            "Set a price to see $/acted-on" is a promise about THIS table, and on the per-repo
            mount there is no $/acted-on column for a price to fill — a reader who followed it
            would set a price, come back, and find nothing changed here. The rail mount keeps the
            sentence because there the instruction is true and the figure it produces is exact.
            The per-repo mount says instead where the money does live, so the absence reads as a
            grain decision rather than as a missing column. */}
        <div className="text-meta text-ui-mute">
          {showCost ? (
            <>
              Set a bot’s monthly price in <span className="font-medium">Bots Monitoring → Classification</span> to
              see $ per used thread.
            </>
          ) : (
            <>
              Cost is on the <span className="font-medium">Bots</span> rail.
            </>
          )}
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
