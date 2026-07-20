import { useMemo } from 'react';
import type {
  AutomatedReviewerKind,
  BotTuningSuggestion,
  BotVendorAnalytics,
  BotVendorTrendPoint,
  BotVerdict,
  BotWindowKind,
} from '@pierre-review/shared';
import {
  useBotAnalytics,
  useAddBotMuteRule,
  useResolvableBotThreads,
} from '../../hooks/useBotTriage.js';
import { useProSettings, useHasProSettings } from '../../hooks/useProSettings.js';
import { useFilters, scopeToParam } from '../../store/filters.js';
import { automatedReviewerMeta, relativeTime } from '../../lib/ui.js';
import { useBotColors } from '../../hooks/useBotColors.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { ChartCard, ChartEmpty, PALETTE, type Series } from '../charts/common.js';

// Bot ROI / utilisation panel — CORE/FREE (rendered in the Bots rail console). The analytics
// route is CORE + deterministic (no AI): a per-vendor signal-to-noise table + a 12-week
// thread-volume trend + keep/tune/kill verdicts, plus the deterministic tuning suggestions with
// one-click mute-rule creation. The ONLY plugin-backed bit is the per-vendor $ cost overlay
// (entered in Settings → Review bots, stored in pro_settings, overlaid CLIENT-side here since
// getBotAnalytics returns cost fields null); its fetch is gated on plugin presence so the pure
// OSS path never calls /api/pro/settings (the cost column just shows "—").

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
    title: 'A lot of comments go untouched — consider muting the noisy paths/severities.',
  },
  kill: {
    label: 'Kill',
    className: 'bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30',
    title: 'High volume, low acted-on, high untouched — probably not paying for itself.',
  },
};

// The account-wide per-bot colour resolver (brand-aware hybrid — see useBotColors): the same
// colour for a given bot across the ROI charts, table, feed pills, and the per-repo Bots tab.
type BotColor = (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

// Chart y-axis / value formatter (BarChart never passes null).
const pctAxis = (n: number): string => `${Math.round(n)}%`;

// Per-week metric extractor for the thread-volume trend. Module-level so its identity is
// stable (keeps VendorTrendChart's useMemo from recomputing every render).
const threadsVal = (p: BotVendorTrendPoint): number | null => p.threads;

// Keep/tune/kill → the traffic-light hue that tints each effectiveness bar.
const VERDICT_COLOR: Record<BotVerdict, string> = {
  keep: PALETTE.green,
  tune: PALETTE.amber,
  kill: PALETTE.red,
};

function usd(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toFixed(2)}`;
}

// Overlay the per-BOT monthly cost (from Pro settings, keyed by reviewer login) onto the analytics
// rows, deriving $/acted-on-comment client-side. getBotAnalytics returns cost fields null by design
// (core can't read pro_settings), so this is where the ROI figure actually lands.
function withCost(
  vendors: BotVendorAnalytics[],
  costByLogin: Map<string, number>,
): BotVendorAnalytics[] {
  return vendors.map((v) => {
    const monthly = v.login != null ? costByLogin.get(v.login) ?? null : null;
    const perActedOn = monthly != null && v.actedOn > 0 ? monthly / v.actedOn : null;
    return { ...v, costMonthlyUsd: monthly, costPerActedOnUsd: perActedOn };
  });
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
// its keep/tune/kill verdict. Surfaces low-volume-but-ineffective bots the count charts bury
// (a 24-thread bot at 25% acted-on reads as clearly "kill" here, where its stacked bar is a
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
        {(['keep', 'tune', 'kill'] as BotVerdict[]).map((v) => (
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

function TuningSuggestions({
  suggestions,
}: {
  suggestions: BotTuningSuggestion[];
}): JSX.Element | null {
  const addRule = useAddBotMuteRule();
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-950/20">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        Tuning suggestions
      </div>
      <ul className="space-y-1.5">
        {suggestions.map((s, i) => {
          const meta = automatedReviewerMeta(s.vendorKind);
          const pending = addRule.isPending;
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
              <button
                type="button"
                onClick={() =>
                  addRule.mutate({
                    vendorKind: s.vendorKind,
                    pathGlob: s.pathGlob,
                    severity: s.severity,
                    action: 'hide',
                  })
                }
                disabled={pending}
                className="ml-auto shrink-0 rounded border border-amber-400 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"
                title="Hide this vendor's matching threads from the feed"
              >
                {pending ? 'Adding…' : 'Create mute rule'}
              </button>
            </li>
          );
        })}
      </ul>
      {addRule.isError && (
        <div className="mt-1 text-[11px] text-red-500">
          {(addRule.error as Error)?.message ?? 'Couldn’t create the rule.'}
        </div>
      )}
    </div>
  );
}

function VendorTable({
  vendors,
  botColor,
  onOpenVendor,
}: {
  vendors: BotVendorAnalytics[];
  botColor: BotColor;
  onOpenVendor: (key: string) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
      <table className="w-full min-w-[680px] border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800 dark:text-gray-400">
            <th className="px-2 py-1.5 font-medium">Vendor</th>
            <th className="px-2 py-1.5 text-right font-medium">Threads</th>
            <th className="px-2 py-1.5 text-right font-medium">Comments</th>
            <th
              className="px-2 py-1.5 text-right font-medium"
              title="A later commit likely addressed the thread, it was resolved, or a human replied/resolved after the bot"
            >
              Acted on
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Threads with no reply and no follow-up commit">
              Untouched
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Untouched threads' oldest age">
              Oldest
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Low-value / untouched share — the noise floor">
              Noise
            </th>
            <th className="px-2 py-1.5 text-right font-medium" title="Monthly vendor cost ÷ acted-on threads (from Pro settings)">
              $/acted-on
            </th>
            <th className="px-2 py-1.5 text-center font-medium">Verdict</th>
          </tr>
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
                    title="View this bot's PRs"
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
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.oldestUntouchedDays != null ? `${v.oldestUntouchedDays}d` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">
                  {v.dormant ? dash : pct(v.noiseRatioPct)}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-500" title={v.costMonthlyUsd != null ? `$${v.costMonthlyUsd}/mo` : 'Set a monthly cost in Settings → Review bots'}>
                  {v.dormant ? dash : usd(v.costPerActedOnUsd)}
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The scope-wide "clear the stale-bot backlog" caution — rendered in BotsView directly beneath
// the "only a bot reviewed" caution and styled to MATCH it (full-width clickable + a "Show list"
// pill), in sky (its own colour). The whole banner opens the resolvable-bot-threads review-and-
// resolve drill-down TAB (BotThreadsDetail). Renders NOTHING until the eager resolvable query (a
// lean per-PR id-list) shows ≥1 likely-addressed automated-reviewer thread.
export function ResolveBacklogBanner({
  scope,
  repoScope,
}: {
  scope: string;
  repoScope: number[] | null;
}): JSX.Element | null {
  const { data } = useResolvableBotThreads(true, scope, repoScope);
  const openBotThreadsDetail = useFilters((s) => s.openBotThreadsDetail);
  const totalThreads = data?.totalThreads ?? 0;

  if (totalThreads === 0) return null;

  return (
    <button
      type="button"
      onClick={() => openBotThreadsDetail(repoScope?.[0] ?? null)}
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

// `repoId` scopes the whole panel to ONE repo (the per-repo Bots tab): analytics + the vendor
// drill-down narrow to that repo, and only bots active in it surface. Absent = the cross-repo
// Bots rail (respects the team-scope selector).
export function BotRoiPanel({ repoId }: { repoId?: number } = {}): JSX.Element | null {
  const window = useFilters((s) => s.botAnalyticsWindow);
  const setWindow = useFilters((s) => s.setBotAnalyticsWindow);
  const openBotPrsDetail = useFilters((s) => s.openBotPrsDetail);
  const openBotOnlyDetail = useFilters((s) => s.openBotOnlyDetail);
  // A repo scope (per-repo Bots tab) wins over the team-scope selector; both are in the query
  // key so either change refetches.
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const repoScope = useMemo(() => (repoId != null ? [repoId] : null), [repoId]);
  const { data, isLoading, isError } = useBotAnalytics(window, true, scope, repoScope);
  const botColor = useBotColors();
  // Cost overlay is the one plugin-backed bit — gate the fetch on plugin presence so the OSS
  // path never hits /api/pro/settings (which 404s without the plugin).
  const { data: settings } = useProSettings(useHasProSettings());

  const costByLogin = useMemo(
    () => new Map((settings?.bots.cost ?? []).map((c) => [c.login, c.monthlyUsd])),
    [settings?.bots.cost],
  );
  const vendors = useMemo(
    () => (data ? withCost(data.vendors, costByLogin) : []),
    [data, costByLogin],
  );

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
    body = (
      <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-700">
        No automated-reviewer activity in this window.
        <div className="mt-1 text-[11px]">
          When review bots (CodeRabbit, Copilot, in-house AI…) comment on your PRs, their
          signal-to-noise lands here. A bot that was active earlier may just be quiet — try
          widening the window above.
        </div>
      </div>
    );
  } else {
    const t = data.totals;
    body = (
      <div className="space-y-3">
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
          untouched ·{' '}
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
        />
        {/* Bot-effectiveness charts (per vendor) — all always visible: raw weekly volume, the
            volume-independent effectiveness + verdict, and the acted-on vs untouched split. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ChartCard title="Thread volume" note="weekly · last 12">
            <VendorTrendChart vendors={vendors} value={threadsVal} botColor={botColor} />
          </ChartCard>
          <ChartCard title="Bot effectiveness" note="acted-on % · keep / tune / kill">
            <EffectivenessChart vendors={vendors} />
          </ChartCard>
          <ChartCard title="Acted-on vs untouched" note="by bot · current window">
            <ActedVsUntouchedChart vendors={vendors} />
          </ChartCard>
        </div>
        <TuningSuggestions suggestions={data.suggestions} />
        <div className="text-[11px] text-gray-400">
          “Acted on” = a later commit likely addressed the thread, it was resolved, or a human
          replied/resolved after the bot (approximate). Noise ratio = the untouched share of a
          bot's threads. Set per-bot monthly cost in Settings → Review bots to see $/acted-on.
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
